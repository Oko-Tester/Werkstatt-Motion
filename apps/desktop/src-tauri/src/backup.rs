use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::{self, SecretKey};
use crate::db;
use crate::error::ApiError;
use crate::hidden;
use crate::keys::KeyMaterial;

/// Backup-Dateiformat (JSON). Die Datenbank liegt als Base64 im Feld `db`,
/// versteckte Einträge darin bleiben verschlüsselt. Der Master-Key ist
/// ausschließlich mit dem Wiederherstellungscode geschützt enthalten –
/// die Backup-Datei allein gibt keine versteckten Daten preis.
pub const BACKUP_FORMAT: &str = "werkstatt-backup";
pub const BACKUP_FORMAT_VERSION: i64 = 1;
pub const BACKUP_FILE_EXTENSION: &str = "werkstattbackup";

const KEY_RECOVERY_KDF: &str = "hkdf-sha256";
const KEY_RECOVERY_AAD: &[u8] = b"werkstatt-backup-key-recovery-v1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub format: String,
    pub format_version: i64,
    pub created_at: String,
    pub app_version: String,
    pub db_schema_version: i64,
    pub encryption_version: i64,
    /// SHA-256 der Datenbankbytes (Hex), prüft Transportschäden.
    pub db_sha256: String,
    pub db: String,
    pub key_recovery: KeyRecovery,
}

/// Geschützt exportierte Schlüsselwiederherstellungsdaten: der Master-Key,
/// verschlüsselt mit einem aus dem Wiederherstellungscode abgeleiteten
/// Schlüssel. Ohne den Code ist dieser Block wertlos.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRecovery {
    pub kdf: String,
    pub salt: String,
    pub nonce: String,
    pub wrapped_key: String,
}

/// Ergebnis einer erfolgreichen Backup-Validierung. Erst mit diesem Wert
/// darf die eigentliche Wiederherstellung ausgeführt werden.
pub struct ValidatedBackup {
    // (Debug siehe unten – gibt bewusst keine Inhalte aus.)
    /// Bereits auf die aktuelle Schemaversion migrierte Datenbankbytes.
    pub db_bytes: Vec<u8>,
    /// Schlüssel, mit dem die versteckten Einträge des Backups lesbar sind.
    pub master_key: SecretKey,
    /// Weicht der Schlüssel vom aktuell gespeicherten ab?
    pub key_changed: bool,
    pub created_at: String,
    pub file_name: Option<String>,
    pub vehicle_count: i64,
    pub payment_count: i64,
    pub hidden_count: i64,
}

impl std::fmt::Debug for ValidatedBackup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Keine Datenbankbytes, kein Schlüsselmaterial in Debug-Ausgaben.
        f.write_str("ValidatedBackup(***)")
    }
}

fn io_error() -> ApiError {
    ApiError::backup("Backup-Datei konnte nicht gelesen oder geschrieben werden")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Hängt ein Suffix an einen Pfad an („werkstatt.db“ → „werkstatt.db-wal“).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Konsistenter Schnappschuss der laufenden Datenbank über die
/// SQLite-Online-Backup-API (funktioniert auch mit aktivem WAL).
fn snapshot_db_bytes(conn: &Connection) -> Result<Vec<u8>, ApiError> {
    let dir = tempfile::tempdir().map_err(|_| io_error())?;
    let path = dir.path().join("snapshot.db");
    {
        let mut dest = Connection::open(&path)?;
        let backup = rusqlite::backup::Backup::new(conn, &mut dest)?;
        backup
            .run_to_completion(64, std::time::Duration::from_millis(2), None)
            .map_err(ApiError::from)?;
    }
    std::fs::read(&path).map_err(|_| io_error())
}

/// Erstellt die vollständige Backup-Datei als Bytes (JSON).
pub fn create_backup_bytes(conn: &Connection, keys: &KeyMaterial) -> Result<Vec<u8>, ApiError> {
    // Vor dem Snapshot auch archivierte Altbestände in die verschlüsselte
    // History überführen und beide Ciphertext-Domänen authentifizieren.
    hidden::verify_all(conn, &keys.master_key)?;
    hidden::backfill_archived_history(conn, &keys.master_key)?;
    hidden::verify_all(conn, &keys.master_key)?;
    let db_bytes = snapshot_db_bytes(conn)?;

    let salt = crypto::random_bytes(16);
    let wrapping_key = crypto::derive_wrapping_key(&keys.recovery_code, &salt);
    let (wrapped_key, nonce) =
        crypto::seal(&wrapping_key, keys.master_key.as_bytes(), KEY_RECOVERY_AAD)?;

    let file = BackupFile {
        format: BACKUP_FORMAT.to_string(),
        format_version: BACKUP_FORMAT_VERSION,
        created_at: db::now(conn)?,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        db_schema_version: db::schema_version(conn)?,
        encryption_version: crypto::ENCRYPTION_VERSION,
        db_sha256: sha256_hex(&db_bytes),
        db: BASE64.encode(&db_bytes),
        key_recovery: KeyRecovery {
            kdf: KEY_RECOVERY_KDF.to_string(),
            salt: BASE64.encode(&salt),
            nonce: BASE64.encode(nonce),
            wrapped_key: BASE64.encode(&wrapped_key),
        },
    };
    serde_json::to_vec_pretty(&file)
        .map_err(|_| ApiError::backup("Backup konnte nicht erstellt werden"))
}

fn unwrap_master_key(recovery: &KeyRecovery, recovery_code: &str) -> Result<SecretKey, ApiError> {
    if recovery.kdf != KEY_RECOVERY_KDF {
        return Err(ApiError::backup(
            "Backup verwendet ein unbekanntes Schlüsselformat",
        ));
    }
    let decode = |value: &str| {
        BASE64
            .decode(value.as_bytes())
            .map_err(|_| ApiError::backup("Backup-Datei ist ungültig"))
    };
    let salt = decode(&recovery.salt)?;
    let nonce = decode(&recovery.nonce)?;
    let wrapped = decode(&recovery.wrapped_key)?;

    let wrapping_key = crypto::derive_wrapping_key(recovery_code, &salt);
    let key_bytes = crypto::open(&wrapping_key, &wrapped, &nonce, KEY_RECOVERY_AAD)?;
    SecretKey::from_slice(&key_bytes).ok_or_else(ApiError::crypto)
}

/// Validiert ein Backup vollständig, ohne die aktuelle Datenbank anzufassen:
/// Manifest, Prüfsumme, Schemaversion (inklusive Migration einer Kopie) und
/// die Integrität aller verschlüsselten Einträge.
pub fn validate_backup_bytes(
    bytes: &[u8],
    file_name: Option<String>,
    current_key: Option<&SecretKey>,
    recovery_code: Option<&Zeroizing<String>>,
) -> Result<ValidatedBackup, ApiError> {
    let file: BackupFile = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::backup("Backup-Datei ist ungültig oder beschädigt"))?;

    if file.format != BACKUP_FORMAT {
        return Err(ApiError::backup("Keine Werkstatt-Backup-Datei"));
    }
    if file.format_version > BACKUP_FORMAT_VERSION {
        return Err(ApiError::backup(
            "Backup stammt aus einer neueren App-Version und kann nicht gelesen werden",
        ));
    }

    let db_bytes = BASE64
        .decode(file.db.as_bytes())
        .map_err(|_| ApiError::backup("Backup-Datei ist ungültig oder beschädigt"))?;
    if sha256_hex(&db_bytes) != file.db_sha256 {
        return Err(ApiError::backup(
            "Backup ist beschädigt (Prüfsumme stimmt nicht)",
        ));
    }

    // Kopie anlegen, migrieren und prüfen – die echte Datenbank bleibt unberührt.
    let dir = tempfile::tempdir().map_err(|_| io_error())?;
    let staged_path = dir.path().join("staged.db");
    std::fs::write(&staged_path, &db_bytes).map_err(|_| io_error())?;

    let (master_key, key_changed, vehicle_count, payment_count, hidden_count) = {
        let mut conn = Connection::open(&staged_path)
            .map_err(|_| ApiError::backup("Backup enthält keine lesbare Datenbank"))?;
        let stored_version = db::schema_version(&conn)
            .map_err(|_| ApiError::backup("Backup enthält keine lesbare Datenbank"))?;
        if stored_version > db::current_schema_version() {
            return Err(ApiError::backup(
                "Backup stammt aus einer neueren App-Version und kann nicht gelesen werden",
            ));
        }
        db::migrate(&mut conn)
            .map_err(|_| ApiError::backup("Backup enthält keine lesbare Datenbank"))?;

        let count =
            |sql: &str| -> Result<i64, ApiError> { Ok(conn.query_row(sql, [], |row| row.get(0))?) };
        let vehicle_count = count("SELECT COUNT(*) FROM vehicles WHERE archived_at IS NULL")?;
        let payment_count =
            count("SELECT COUNT(*) FROM payments WHERE paid_at IS NULL AND archived_at IS NULL")?;

        // Integrität der verschlüsselten Inhalte: erst mit dem aktuellen
        // Schlüssel, sonst mit dem im Backup geschützten Schlüssel.
        let total_hidden = count(
            "SELECT
                (SELECT COUNT(*) FROM hidden_entries) +
                (SELECT COUNT(*) FROM hidden_entry_history)",
        )?;
        let mut chosen: Option<(SecretKey, bool)> = None;
        if let Some(key) = current_key {
            if total_hidden == 0 || hidden::verify_all(&conn, key).is_ok() {
                chosen = Some((key.clone(), false));
            }
        }
        if chosen.is_none() {
            if let Some(code) = recovery_code {
                if let Ok(unwrapped) = unwrap_master_key(&file.key_recovery, code) {
                    if total_hidden == 0 || hidden::verify_all(&conn, &unwrapped).is_ok() {
                        let changed = current_key.map(|key| *key != unwrapped).unwrap_or(true);
                        chosen = Some((unwrapped, changed));
                    }
                }
            }
        }
        if chosen.is_none() && total_hidden == 0 {
            // Backup ohne verschlüsselte Einträge: auch ohne Schlüssel und
            // Wiederherstellungscode nutzbar (Reparaturweg). Ein frischer
            // Schlüssel ist hier gefahrlos, weil nichts damit gelesen werden muss.
            chosen = Some((SecretKey::generate(), true));
        }
        let (master_key, key_changed) = chosen.ok_or_else(|| {
            ApiError::backup(
                "Verschlüsselte Einträge im Backup können nicht gelesen werden. \
                 Ohne passenden Schlüssel oder Wiederherstellungscode ist dieses \
                 Backup nicht nutzbar.",
            )
        })?;
        hidden::backfill_archived_history(&conn, &master_key)
            .map_err(|_| ApiError::backup("Verschlüsselte Historie im Backup ist beschädigt"))?;
        hidden::verify_all(&conn, &master_key)
            .map_err(|_| ApiError::backup("Verschlüsselte Historie im Backup ist beschädigt"))?;
        let hidden_count = count("SELECT COUNT(*) FROM hidden_entries WHERE archived_at IS NULL")?;
        (
            master_key,
            key_changed,
            vehicle_count,
            payment_count,
            hidden_count,
        )
    };

    // Die migrierte Kopie ist der Stand, der später eingespielt wird.
    let staged_bytes = std::fs::read(&staged_path).map_err(|_| io_error())?;

    Ok(ValidatedBackup {
        db_bytes: staged_bytes,
        master_key,
        key_changed,
        created_at: file.created_at,
        file_name,
        vehicle_count,
        payment_count,
        hidden_count,
    })
}

/// Tauscht die Datenbankdatei atomar gegen die validierten Bytes aus und
/// öffnet die Verbindung neu. Schlägt der Austausch fehl, bleibt die alte
/// Datei bestehen und die Verbindung zeigt wieder auf die alte Datenbank.
/// Der Slot darf leer sein (defekte Datenbank) – dann ist der Austausch der
/// Reparaturweg und es gibt keine alte Verbindung zu schließen.
pub fn swap_database(
    slot: &mut Option<Connection>,
    db_path: &Path,
    db_bytes: &[u8],
) -> Result<(), ApiError> {
    let tmp_path = sibling(db_path, ".restore-neu");
    std::fs::write(&tmp_path, db_bytes).map_err(|_| io_error())?;

    let reopen = |slot: &mut Option<Connection>| -> Result<(), ApiError> {
        *slot = Some(db::open(db_path)?);
        Ok(())
    };

    // Alte Verbindung schließen, damit die Datei ersetzt werden kann.
    drop(slot.take());

    if std::fs::rename(&tmp_path, db_path).is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        // Alte Datei ist unangetastet – Verbindung wieder öffnen (best effort).
        let _ = reopen(slot);
        return Err(ApiError::backup(
            "Wiederherstellung konnte nicht abgeschlossen werden",
        ));
    }

    // WAL-Reste gehören zur alten Datei und dürfen die neue nicht beeinflussen.
    let _ = std::fs::remove_file(sibling(db_path, "-wal"));
    let _ = std::fs::remove_file(sibling(db_path, "-shm"));

    reopen(slot)
}

/// Legt eine nicht mehr lesbare Datenbankdatei vor der Wiederherstellung
/// als Kopie ins Backup-Verzeichnis (best effort – blockiert nie).
pub fn preserve_broken_database(db_path: &Path, backups_dir: &Path) {
    if !db_path.exists() || std::fs::create_dir_all(backups_dir).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let target = backups_dir.join(format!("defekte-datenbank-{stamp}.db"));
    let _ = std::fs::copy(db_path, target);
}

/// Schreibt vor einer Wiederherstellung eine automatische Sicherung des
/// aktuellen Zustands in das Backup-Verzeichnis der App.
pub fn write_safety_backup(
    conn: &Connection,
    keys: &KeyMaterial,
    backups_dir: &Path,
) -> Result<PathBuf, ApiError> {
    std::fs::create_dir_all(backups_dir).map_err(|_| io_error())?;
    let stamp = db::now(conn)?.replace(':', "-");
    let path = backups_dir.join(format!(
        "vor-wiederherstellung-{stamp}.{BACKUP_FILE_EXTENSION}"
    ));
    let bytes = create_backup_bytes(conn, keys)?;
    std::fs::write(&path, bytes).map_err(|_| io_error())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::models::{NewHiddenEntry, NewPayment, NewVehicle};

    const MARKER_NAME: &str = "GEHEIME-BEZEICHNUNG-77319";
    const MARKER_NOTE: &str = "VERTRAULICHE-NOTIZ-40230";

    fn test_keys() -> KeyMaterial {
        KeyMaterial {
            master_key: SecretKey::generate(),
            recovery_code: Zeroizing::new("TEST-WIEDERHERSTELLUNGS-CODE".to_string()),
        }
    }

    fn open_db(path: &Path) -> Connection {
        let mut conn = Connection::open(path).unwrap();
        db::migrate(&mut conn).unwrap();
        conn
    }

    fn seed(conn: &Connection, keys: &KeyMaterial) {
        db::create_vehicle(
            conn,
            NewVehicle {
                customer_name: "Müller, Anna".to_string(),
                vehicle_name: "VW Golf".to_string(),
                ..NewVehicle::default()
            },
        )
        .unwrap();
        db::create_payment(
            conn,
            NewPayment {
                customer_name: "Lang".to_string(),
                amount_cents: 12990,
                note: String::new(),
            },
        )
        .unwrap();
        hidden::create_entry(
            conn,
            &keys.master_key,
            NewHiddenEntry {
                name: MARKER_NAME.to_string(),
                amount_cents: 424242,
                note: MARKER_NOTE.to_string(),
            },
        )
        .unwrap();
    }

    #[test]
    fn backup_enthaelt_keine_versteckten_klartextdaten() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_db(&dir.path().join("a.db"));
        let keys = test_keys();
        seed(&conn, &keys);

        let bytes = create_backup_bytes(&conn, &keys).unwrap();

        // Weder die Backup-Datei selbst …
        let text = String::from_utf8_lossy(&bytes).to_string();
        assert!(!text.contains(MARKER_NAME));
        assert!(!text.contains(MARKER_NOTE));
        assert!(!text.contains("424242"));

        // … noch die enthaltene Datenbank gibt versteckte Inhalte preis.
        let file: BackupFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(file.format, BACKUP_FORMAT);
        assert_eq!(file.format_version, BACKUP_FORMAT_VERSION);
        assert_eq!(file.db_schema_version, db::current_schema_version());
        let db_bytes = BASE64.decode(file.db.as_bytes()).unwrap();
        let db_text = String::from_utf8_lossy(&db_bytes).to_string();
        assert!(!db_text.contains(MARKER_NAME));
        assert!(!db_text.contains(MARKER_NOTE));

        // Offene (nicht versteckte) Daten dürfen enthalten sein – das Backup
        // ist vollständig.
        assert!(db_text.contains("Müller, Anna"));
    }

    #[test]
    fn zwei_backups_wrappen_den_schluessel_mit_unterschiedlichen_nonces() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_db(&dir.path().join("a.db"));
        let keys = test_keys();

        let a: BackupFile =
            serde_json::from_slice(&create_backup_bytes(&conn, &keys).unwrap()).unwrap();
        let b: BackupFile =
            serde_json::from_slice(&create_backup_bytes(&conn, &keys).unwrap()).unwrap();
        assert_ne!(a.key_recovery.nonce, b.key_recovery.nonce);
        assert_ne!(a.key_recovery.salt, b.key_recovery.salt);
    }

    #[test]
    fn gueltiges_backup_wird_validiert_und_wiederhergestellt() {
        let dir = tempfile::tempdir().unwrap();
        let keys = test_keys();
        let source = open_db(&dir.path().join("quelle.db"));
        seed(&source, &keys);
        let backup = create_backup_bytes(&source, &keys).unwrap();

        let validated = validate_backup_bytes(
            &backup,
            Some("test.werkstattbackup".to_string()),
            Some(&keys.master_key),
            Some(&keys.recovery_code),
        )
        .unwrap();
        assert!(!validated.key_changed);
        assert_eq!(validated.vehicle_count, 1);
        assert_eq!(validated.payment_count, 1);
        assert_eq!(validated.hidden_count, 1);

        // In eine andere, leere Datenbank einspielen.
        let target_path = dir.path().join("ziel.db");
        let mut slot = Some(open_db(&target_path));
        swap_database(&mut slot, &target_path, &validated.db_bytes).unwrap();
        let target = slot.expect("Verbindung nach dem Austausch");

        let entries = hidden::list_entries(&target, &validated.master_key).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, MARKER_NAME);
        assert_eq!(db::list_vehicles(&target).unwrap().len(), 1);
        assert_eq!(db::list_open_payments(&target).unwrap().len(), 1);
    }

    #[test]
    fn wiederherstellung_funktioniert_ohne_nutzbare_datenbank() {
        // Reparaturweg: Die aktuelle Datenbankdatei ist defekt, es gibt keine
        // offene Verbindung – die Wiederherstellung tauscht die Datei trotzdem.
        let dir = tempfile::tempdir().unwrap();
        let keys = test_keys();
        let source = open_db(&dir.path().join("quelle.db"));
        seed(&source, &keys);
        let backup = create_backup_bytes(&source, &keys).unwrap();
        let validated = validate_backup_bytes(&backup, None, Some(&keys.master_key), None).unwrap();

        let db_path = dir.path().join("defekt.db");
        std::fs::write(&db_path, b"kein sqlite").unwrap();
        // Die defekte Datei wird vorher beiseitegelegt.
        let backups_dir = dir.path().join("backups");
        preserve_broken_database(&db_path, &backups_dir);
        let preserved: Vec<_> = std::fs::read_dir(&backups_dir).unwrap().collect();
        assert_eq!(preserved.len(), 1);

        let mut slot: Option<Connection> = None;
        swap_database(&mut slot, &db_path, &validated.db_bytes).unwrap();
        let conn = slot.expect("Verbindung nach dem Austausch");
        assert_eq!(db::list_vehicles(&conn).unwrap().len(), 1);
        assert_eq!(
            hidden::list_entries(&conn, &validated.master_key)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn backup_ohne_versteckte_eintraege_braucht_keinen_schluessel() {
        // Reparaturweg: Schlüssel verloren, Backup enthält nichts
        // Verschlüsseltes – die Validierung darf nicht daran scheitern.
        let dir = tempfile::tempdir().unwrap();
        let keys = test_keys();
        let conn = open_db(&dir.path().join("a.db"));
        db::create_vehicle(
            &conn,
            crate::models::NewVehicle {
                customer_name: "Huber".to_string(),
                vehicle_name: "Golf".to_string(),
                ..crate::models::NewVehicle::default()
            },
        )
        .unwrap();
        let backup = create_backup_bytes(&conn, &keys).unwrap();

        let validated = validate_backup_bytes(&backup, None, None, None).unwrap();
        assert!(validated.key_changed);
        assert_eq!(validated.vehicle_count, 1);
        assert_eq!(validated.hidden_count, 0);
    }

    #[test]
    fn wiederherstellung_ueber_recovery_code_ohne_aktuellen_schluessel() {
        let dir = tempfile::tempdir().unwrap();
        let keys = test_keys();
        let source = open_db(&dir.path().join("quelle.db"));
        seed(&source, &keys);
        let backup = create_backup_bytes(&source, &keys).unwrap();

        // Ohne aktuellen Schlüssel, aber mit richtigem Code: funktioniert.
        let validated =
            validate_backup_bytes(&backup, None, None, Some(&keys.recovery_code)).unwrap();
        assert!(validated.key_changed);
        assert_eq!(validated.master_key, keys.master_key);

        // Falscher Code: sicherer Fehler.
        let wrong = Zeroizing::new("FALSCHER-CODE".to_string());
        let err = validate_backup_bytes(&backup, None, None, Some(&wrong)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Backup);

        // Weder Schlüssel noch Code: sicherer Fehler.
        let err = validate_backup_bytes(&backup, None, None, None).unwrap_err();
        assert_eq!(err.code, ErrorCode::Backup);
    }

    #[test]
    fn beschaedigte_backups_werden_abgelehnt_und_die_datenbank_bleibt_unveraendert() {
        let dir = tempfile::tempdir().unwrap();
        let keys = test_keys();
        let db_path = dir.path().join("aktuell.db");
        {
            let conn = open_db(&db_path);
            seed(&conn, &keys);
        }
        let before = std::fs::read(&db_path).unwrap();

        let source = open_db(&dir.path().join("quelle.db"));
        seed(&source, &keys);
        let valid = create_backup_bytes(&source, &keys).unwrap();

        // (a) Abgeschnittene Datei.
        let truncated = &valid[..valid.len() / 2];
        assert_eq!(
            validate_backup_bytes(truncated, None, Some(&keys.master_key), None)
                .unwrap_err()
                .code,
            ErrorCode::Backup,
        );

        // (b) Prüfsumme stimmt nicht (Datenbankbytes verändert).
        let mut file: BackupFile = serde_json::from_slice(&valid).unwrap();
        let mut db_bytes = BASE64.decode(file.db.as_bytes()).unwrap();
        db_bytes[100] ^= 0x01;
        file.db = BASE64.encode(&db_bytes);
        let tampered = serde_json::to_vec(&file).unwrap();
        assert_eq!(
            validate_backup_bytes(&tampered, None, Some(&keys.master_key), None)
                .unwrap_err()
                .code,
            ErrorCode::Backup,
        );

        // (c) Manipulierter Ciphertext IM Backup, Prüfsumme „repariert“:
        // die Integritätsprüfung der verschlüsselten Inhalte greift.
        let mut file: BackupFile = serde_json::from_slice(&valid).unwrap();
        let db_bytes = BASE64.decode(file.db.as_bytes()).unwrap();
        let staged = dir.path().join("manipuliert.db");
        std::fs::write(&staged, &db_bytes).unwrap();
        {
            let conn = Connection::open(&staged).unwrap();
            let (id, mut blob): (String, Vec<u8>) = conn
                .query_row(
                    "SELECT id, encrypted_payload FROM hidden_entries LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            blob[0] ^= 0x01;
            conn.execute(
                "UPDATE hidden_entries SET encrypted_payload = ?2 WHERE id = ?1",
                rusqlite::params![id, blob],
            )
            .unwrap();
        }
        let manipulated = std::fs::read(&staged).unwrap();
        file.db_sha256 = sha256_hex(&manipulated);
        file.db = BASE64.encode(&manipulated);
        let tampered = serde_json::to_vec(&file).unwrap();
        assert_eq!(
            validate_backup_bytes(
                &tampered,
                None,
                Some(&keys.master_key),
                Some(&keys.recovery_code),
            )
            .unwrap_err()
            .code,
            ErrorCode::Backup,
        );

        // (d) Fremdes Format.
        assert_eq!(
            validate_backup_bytes(br#"{"format":"anders"}"#, None, None, None)
                .unwrap_err()
                .code,
            ErrorCode::Backup,
        );

        // (e) Neuere Formatversion.
        let mut file: BackupFile = serde_json::from_slice(&valid).unwrap();
        file.format_version = BACKUP_FORMAT_VERSION + 1;
        let newer = serde_json::to_vec(&file).unwrap();
        assert_eq!(
            validate_backup_bytes(&newer, None, Some(&keys.master_key), None)
                .unwrap_err()
                .code,
            ErrorCode::Backup,
        );

        // Die aktuelle Datenbank wurde durch keinen Fehlversuch verändert.
        assert_eq!(std::fs::read(&db_path).unwrap(), before);
    }

    #[test]
    fn backup_validierung_prueft_auch_secret_history() {
        let dir = tempfile::tempdir().unwrap();
        let keys = test_keys();
        let source = open_db(&dir.path().join("quelle-history.db"));
        let entry = hidden::create_entry(
            &source,
            &keys.master_key,
            NewHiddenEntry {
                name: MARKER_NAME.to_string(),
                amount_cents: 777,
                note: MARKER_NOTE.to_string(),
            },
        )
        .unwrap();
        hidden::archive_entry(&source, &keys.master_key, &entry.id).unwrap();
        let valid = create_backup_bytes(&source, &keys).unwrap();

        let mut file: BackupFile = serde_json::from_slice(&valid).unwrap();
        let staged = dir.path().join("history-manipuliert.db");
        std::fs::write(&staged, BASE64.decode(file.db.as_bytes()).unwrap()).unwrap();
        {
            let conn = Connection::open(&staged).unwrap();
            let (id, mut ciphertext): (String, Vec<u8>) = conn
                .query_row(
                    "SELECT id, encrypted_payload FROM hidden_entry_history LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            ciphertext[0] ^= 0x40;
            conn.execute(
                "UPDATE hidden_entry_history SET encrypted_payload = ?2 WHERE id = ?1",
                rusqlite::params![id, ciphertext],
            )
            .unwrap();
        }
        let manipulated = std::fs::read(&staged).unwrap();
        file.db_sha256 = sha256_hex(&manipulated);
        file.db = BASE64.encode(&manipulated);
        let tampered = serde_json::to_vec(&file).unwrap();
        let err = validate_backup_bytes(
            &tampered,
            None,
            Some(&keys.master_key),
            Some(&keys.recovery_code),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Backup);
        assert!(!format!("{err} {err:?}").contains(MARKER_NAME));
        assert!(!format!("{err} {err:?}").contains(MARKER_NOTE));
    }

    #[test]
    fn neuere_schemaversion_wird_abgelehnt() {
        let dir = tempfile::tempdir().unwrap();
        let keys = test_keys();
        let conn = open_db(&dir.path().join("neu.db"));
        conn.pragma_update(None, "user_version", db::current_schema_version() + 10)
            .unwrap();
        let backup = create_backup_bytes(&conn, &keys).unwrap();

        let err = validate_backup_bytes(&backup, None, Some(&keys.master_key), None).unwrap_err();
        assert_eq!(err.code, ErrorCode::Backup);
        assert!(err.message.contains("neueren App-Version"));
    }

    #[test]
    fn safety_backup_wird_geschrieben_und_ist_gueltig() {
        let dir = tempfile::tempdir().unwrap();
        let keys = test_keys();
        let conn = open_db(&dir.path().join("a.db"));
        seed(&conn, &keys);

        let backups_dir = dir.path().join("backups");
        let path = write_safety_backup(&conn, &keys, &backups_dir).unwrap();
        assert!(path.exists());

        let bytes = std::fs::read(&path).unwrap();
        let validated = validate_backup_bytes(&bytes, None, Some(&keys.master_key), None).unwrap();
        assert_eq!(validated.hidden_count, 1);
    }
}
