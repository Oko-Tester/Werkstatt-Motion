use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
pub const DAILY_BACKUP_RETENTION_DAYS: i64 = 14;
/// Mindestzahl täglicher Sicherungen, die nie gelöscht werden – auch dann nicht,
/// wenn sie älter als das Aufbewahrungsfenster sind. Nach einer längeren Pause
/// (Urlaub, defekter Rechner) bleibt so die letzte gute Sicherung davor erhalten,
/// statt dass der erste Lauf danach alles Ältere wegräumt.
const MIN_KEPT_DAILY_BACKUPS: usize = 3;

const DAILY_BACKUP_PREFIX: &str = "taeglich-";
const MANUAL_BACKUP_PREFIX: &str = "manuell-";

/// Dateiname der Backup-Einstellungen im App-Datenordner, neben der Datenbank.
pub const BACKUP_SETTINGS_FILE: &str = "sicherung.json";

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

/// Schreibt eine Datei vollständig und dauerhaft auf den Datenträger und
/// prüft anschließend die geschriebene Länge. Ein halb geschriebenes Backup
/// darf nie als Erfolg gelten.
fn write_file_complete(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    use std::io::Write;

    let mut file = std::fs::File::create(path).map_err(|_| io_error())?;
    file.write_all(bytes).map_err(|_| io_error())?;
    file.sync_all().map_err(|_| io_error())?;
    drop(file);

    let written = std::fs::metadata(path).map_err(|_| io_error())?.len();
    if written != bytes.len() as u64 {
        return Err(io_error());
    }
    Ok(())
}

/// Zähler für eindeutige temporäre Dateinamen. Läuft die Sicherung in den
/// zweiten Ordner zweimal gleichzeitig, darf keiner der Läufe die halbe Datei
/// des anderen überschreiben oder umbenennen.
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Legt den Zielordner an und schreibt die Backup-Datei atomar hinein.
fn write_backup_file(dir: &Path, file_name: &str, bytes: &[u8]) -> Result<PathBuf, ApiError> {
    std::fs::create_dir_all(dir).map_err(|_| io_error())?;
    write_file_atomically(dir, file_name, bytes)
}

/// Schreibt die Backup-Datei atomar in einen schon vorhandenen Ordner: erst
/// vollständig unter temporärem Namen, dann umbenennen. Schlägt irgendetwas
/// davon fehl, bleibt kein halbes Backup zurück. Der Ordner wird nie angelegt –
/// so entsteht der zweite Sicherungsordner nie versehentlich auf einem anderen
/// Laufwerk.
fn write_file_atomically(dir: &Path, file_name: &str, bytes: &[u8]) -> Result<PathBuf, ApiError> {
    let path = dir.join(file_name);
    let unique = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = dir.join(format!(".{file_name}.{}-{unique}.tmp", std::process::id()));

    if let Err(err) = write_file_complete(&temporary, bytes) {
        let _ = std::fs::remove_file(&temporary);
        return Err(err);
    }
    if std::fs::rename(&temporary, &path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(io_error());
    }
    Ok(path)
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
    let stamp = db::now(conn)?.replace(':', "-");
    let file_name = format!("vor-wiederherstellung-{stamp}.{BACKUP_FILE_EXTENSION}");
    let bytes = create_backup_bytes(conn, keys)?;
    write_backup_file(backups_dir, &file_name, &bytes)
}

/// Ergebnis des täglichen Backup-Laufs. Existiert für den heutigen
/// Kalendertag bereits eine Sicherung, bleibt `created` false.
#[derive(Debug)]
pub struct DailyBackupResult {
    pub created: bool,
    pub path: PathBuf,
}

fn is_calendar_date(value: &str) -> bool {
    value.len() == 10
        && value.bytes().enumerate().all(|(index, byte)| match index {
            4 | 7 => byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

fn daily_backup_date(file_name: &str) -> Option<&str> {
    let date = file_name
        .strip_prefix(DAILY_BACKUP_PREFIX)?
        .strip_suffix(&format!(".{BACKUP_FILE_EXTENSION}"))?;
    is_calendar_date(date).then_some(date)
}

/// Entfernt ausschließlich tägliche Sicherungen, die außerhalb des
/// Aufbewahrungsfensters liegen – die `MIN_KEPT_DAILY_BACKUPS` neuesten bleiben
/// aber in jedem Fall. Andere automatische und manuelle Backups werden bewusst
/// nicht angefasst. Das Aufräumen ist Nebensache: Eine Datei, die gerade nicht
/// zu löschen ist (z. B. vom Virenscanner gehalten), macht eine fertige
/// Sicherung nicht zum Fehler und hält die zweite Kopie nicht auf.
fn cleanup_daily_backups(backups_dir: &Path, cutoff_date: &str) {
    let Ok(entries) = std::fs::read_dir(backups_dir) else {
        return;
    };
    let mut dailies: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let date = daily_backup_date(file_name.to_str()?)?.to_string();
            Some((date, entry.path()))
        })
        .collect();
    // Neueste zuerst: Die ersten `MIN_KEPT_DAILY_BACKUPS` sind geschützt.
    dailies.sort_by(|a, b| b.0.cmp(&a.0));
    for (date, path) in dailies.into_iter().skip(MIN_KEPT_DAILY_BACKUPS) {
        if date.as_str() < cutoff_date {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Erstellt höchstens ein Backup pro Kalendertag (`today`) und bewahrt nur das
/// Fenster ab `cutoff_date` auf. Die Tage kommen von außen (`daily_dates`),
/// damit die Kopie in den zweiten Ordner garantiert dieselben benutzt – auch
/// wenn währenddessen Mitternacht vergeht.
pub fn write_daily_backup_for_dates(
    conn: &Connection,
    keys: &KeyMaterial,
    backups_dir: &Path,
    today: &str,
    cutoff_date: &str,
) -> Result<DailyBackupResult, ApiError> {
    if !is_calendar_date(today) || !is_calendar_date(cutoff_date) {
        return Err(ApiError::backup(
            "Backup-Datum konnte nicht ermittelt werden",
        ));
    }

    std::fs::create_dir_all(backups_dir).map_err(|_| io_error())?;
    let file_name = format!("{DAILY_BACKUP_PREFIX}{today}.{BACKUP_FILE_EXTENSION}");
    let path = backups_dir.join(&file_name);

    let created = if path.is_file() {
        false
    } else {
        let bytes = create_backup_bytes(conn, keys)?;
        write_backup_file(backups_dir, &file_name, &bytes).map_err(|_| {
            ApiError::backup("Das tägliche Backup konnte nicht abgeschlossen werden")
        })?;
        true
    };

    cleanup_daily_backups(backups_dir, cutoff_date);
    Ok(DailyBackupResult { created, path })
}

/// Die Kalendertage der täglichen Sicherung: heute und der erste Tag, der noch
/// aufbewahrt wird (14-Tage-Fenster). Die Berechnung läuft über SQLite und
/// richtet sich nach dem lokalen Kalendertag des Betriebssystems.
pub fn daily_dates(conn: &Connection) -> Result<(String, String), ApiError> {
    Ok(conn.query_row(
        "SELECT date('now', 'localtime'), date('now', 'localtime', ?1)",
        [format!("-{} days", DAILY_BACKUP_RETENTION_DAYS - 1)],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}

// ---------- Zweiter Sicherungsordner ----------

/// Einstellungen der Datensicherung. Sie liegen bewusst nicht in der Datenbank,
/// sondern in einer kleinen Datei daneben: Der Ordner gehört zu diesem Computer
/// (ein USB-Stick hat anderswo einen anderen Laufwerksbuchstaben), und eine
/// Wiederherstellung darf ihn weder überschreiben noch zurückdrehen.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupSettings {
    /// Zweiter Speicherort für die automatische Sicherung (USB-Stick, Netzlaufwerk):
    /// der Ordner, den die App beim Einrichten selbst angelegt hat und allein
    /// verwaltet – nicht der Ordner, den man im Dialog gewählt hat.
    pub second_dir: Option<String>,
}

/// Grundname des Ordners, den die App im gewählten Ordner anlegt. Nur in ihm
/// schreibt und räumt sie auf; was sonst im gewählten Ordner liegt, bleibt
/// unberührt.
const SECOND_FOLDER_BASE_NAME: &str = "Werkstatt-Motion-Sicherung";

/// Name des eigenen Ordners im zweiten Speicherort. Mit dem Computernamen, damit
/// sich zwei Rechner denselben Stick oder dieselbe Freigabe teilen können, ohne
/// sich gegenseitig zu überschreiben oder aufzuräumen.
pub fn second_folder_name() -> String {
    let computer = ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|name| file_name_part(name.trim()))
        .filter(|name| !name.is_empty());
    match computer {
        Some(name) => format!("{SECOND_FOLDER_BASE_NAME}-{name}"),
        None => SECOND_FOLDER_BASE_NAME.to_string(),
    }
}

const SECOND_DIR_UNREACHABLE: &str = "Der zweite Sicherungsordner ist nicht erreichbar. \
     Ist der USB-Stick eingesteckt oder das Netzlaufwerk verbunden?";

/// Liest die Einstellungen. Fehlt die Datei oder ist sie unlesbar, gelten die
/// Standardwerte: Die Sicherung darf nie an einer kaputten Einstellung scheitern.
pub fn load_backup_settings(path: &Path) -> BackupSettings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_backup_settings(path: &Path, settings: &BackupSettings) -> Result<(), ApiError> {
    let failed = || ApiError::backup("Die Einstellung konnte nicht gespeichert werden");
    let dir = path.parent().ok_or_else(failed)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(failed)?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| failed())?;
    write_backup_file(dir, file_name, &bytes)
        .map(|_| ())
        .map_err(|_| failed())
}

/// Liegt `path` in `base` oder ist es `base` selbst? Verglichen werden die
/// aufgelösten Pfade; lässt sich einer nicht auflösen, gilt der Pfad wie er ist.
fn is_same_or_inside(path: &Path, base: &Path) -> bool {
    match (path.canonicalize(), base.canonicalize()) {
        (Ok(path), Ok(base)) => path.starts_with(base),
        _ => path.starts_with(base),
    }
}

/// Richtet den zweiten Speicherort im gewählten Ordner ein: Der Ordner muss
/// erreichbar und beschreibbar sein und außerhalb der Daten dieser App liegen.
/// Die App legt darin einen eigenen Ordner (`folder_name`) an – das ist die
/// einzige Stelle, an der sie je einen Ordner im zweiten Speicherort anlegt –
/// und merkt sich diesen. Dadurch bleibt alles andere im gewählten Ordner
/// unberührt, und ein anderer Stick unter demselben Laufwerksbuchstaben (oder
/// ein leerer Einhängepunkt) wird später als „nicht erreichbar“ erkannt.
pub fn set_second_dir(
    settings_path: &Path,
    local_backups_dir: &Path,
    picked: &Path,
    folder_name: &str,
) -> Result<(), ApiError> {
    if !picked.is_dir() {
        return Err(ApiError::backup(SECOND_DIR_UNREACHABLE));
    }
    let own_data = [Some(local_backups_dir), settings_path.parent()];
    if own_data
        .into_iter()
        .flatten()
        .any(|own| is_same_or_inside(picked, own))
    {
        return Err(ApiError::backup(
            "Bitte einen anderen Ordner wählen: Dieser gehört zu den Daten \
             der App und liegt nicht getrennt von ihnen",
        ));
    }

    // Wurde der eigene Ordner direkt gewählt, wird er benutzt statt darin einen
    // zweiten anzulegen.
    let already_own = picked
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(folder_name));
    let target = if already_own {
        picked.to_path_buf()
    } else {
        picked.join(folder_name)
    };
    let not_writable = || ApiError::backup("In diesen Ordner kann nicht geschrieben werden");
    match std::fs::create_dir(&target) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists && target.is_dir() => {}
        Err(_) => return Err(not_writable()),
    }
    let probe = target.join(".werkstatt-schreibtest");
    std::fs::write(&probe, b"ok").map_err(|_| not_writable())?;
    let _ = std::fs::remove_file(&probe);

    save_backup_settings(
        settings_path,
        &BackupSettings {
            second_dir: Some(target.display().to_string()),
        },
    )
}

/// Entfernt den zweiten Speicherort. Bereits kopierte Sicherungen bleiben dort
/// liegen.
pub fn clear_second_dir(settings_path: &Path) -> Result<(), ApiError> {
    save_backup_settings(settings_path, &BackupSettings::default())
}

/// Übernimmt den Änderungszeitpunkt der Quelle in die Kopie. So zeigt „Zuletzt
/// gesichert“ am zweiten Ort das Alter der Daten und nicht den Moment des
/// Kopierens (der Stick kann erst nachmittags eingesteckt worden sein). Gelingt
/// es nicht, bleibt es beim Zeitpunkt des Kopierens.
fn copy_modified_time(source: &Path, target: &Path) {
    let Ok(modified) = std::fs::metadata(source).and_then(|meta| meta.modified()) else {
        return;
    };
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(target) {
        let _ = file.set_modified(modified);
    }
}

/// Kopiert die heutige Tagessicherung in den eigenen Ordner im zweiten
/// Speicherort und räumt dort – wie auf diesem Computer – tägliche Sicherungen
/// außerhalb der 14 Tage weg. Manuelle Sicherungen und fremde Dateien bleiben
/// unberührt. Der Ordner wird nie angelegt: Fehlt er (z. B. USB-Stick nicht
/// eingesteckt), gibt es einen klaren Fehler, statt dass auf dem falschen
/// Laufwerk ein neuer Ordner entsteht.
pub fn mirror_daily_backup(
    source: &Path,
    second_dir: &Path,
    today: &str,
    cutoff_date: &str,
) -> Result<DailyBackupResult, ApiError> {
    if !is_calendar_date(today) || !is_calendar_date(cutoff_date) {
        return Err(ApiError::backup(
            "Backup-Datum konnte nicht ermittelt werden",
        ));
    }
    if !second_dir.is_dir() {
        return Err(ApiError::backup(SECOND_DIR_UNREACHABLE));
    }

    let file_name = format!("{DAILY_BACKUP_PREFIX}{today}.{BACKUP_FILE_EXTENSION}");
    let path = second_dir.join(&file_name);
    let created = if path.is_file() {
        false
    } else {
        let bytes = std::fs::read(source).map_err(|_| io_error())?;
        write_file_atomically(second_dir, &file_name, &bytes).map_err(|_| {
            ApiError::backup("Die zweite Sicherung konnte nicht geschrieben werden")
        })?;
        copy_modified_time(source, &path);
        true
    };

    cleanup_daily_backups(second_dir, cutoff_date);
    Ok(DailyBackupResult { created, path })
}

/// Zeitstempel für den Dateinamen einer manuellen Sicherung, im lokalen Kalender.
pub fn manual_backup_stamp(conn: &Connection) -> Result<String, ApiError> {
    Ok(conn.query_row(
        "SELECT strftime('%Y-%m-%d_%H-%M-%S', 'now', 'localtime')",
        [],
        |row| row.get(0),
    )?)
}

/// Schreibt eine fertige manuelle Sicherung mit Zeitstempel in den zweiten
/// Ordner. Manuelle Sicherungen werden nie automatisch gelöscht. Inhalt und
/// Zeitstempel entstehen vorher unter der Datenbanksperre; das Schreiben auf
/// USB-Stick oder Netzlaufwerk braucht sie nicht.
pub fn write_manual_backup(
    second_dir: &Path,
    stamp: &str,
    bytes: &[u8],
) -> Result<PathBuf, ApiError> {
    if !second_dir.is_dir() {
        return Err(ApiError::backup(SECOND_DIR_UNREACHABLE));
    }
    let file_name = format!("{MANUAL_BACKUP_PREFIX}{stamp}.{BACKUP_FILE_EXTENSION}");
    write_file_atomically(second_dir, &file_name, bytes)
}

/// Stand der Datensicherung für die Einstellungen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    /// Ordner der automatischen Sicherung auf diesem Computer.
    pub local_dir: String,
    /// Zeitpunkt der letzten Tagessicherung (Millisekunden seit 1970).
    pub local_last_at: Option<i64>,
    pub retention_days: i64,
    pub second_dir: Option<String>,
    /// Zeitpunkt der letzten Sicherung im zweiten Ordner (Millisekunden seit 1970).
    pub second_last_at: Option<i64>,
    /// Grund, falls der zweite Ordner gerade nicht erreichbar ist.
    pub second_error: Option<String>,
}

/// Änderungszeit der neuesten Sicherungsdatei mit einem der Namensanfänge.
fn newest_backup_millis(dir: &Path, prefixes: &[&str]) -> Option<i64> {
    let suffix = format!(".{BACKUP_FILE_EXTENSION}");
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.ends_with(&suffix) && prefixes.iter().any(|prefix| name.starts_with(prefix))
        })
        .filter_map(|entry| entry.metadata().ok()?.modified().ok())
        .filter_map(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .max()
}

/// Liest den Stand aus den Dateien selbst: Es gibt keine zweite Buchführung, die
/// von der Wirklichkeit abweichen könnte.
pub fn backup_status(local_dir: &Path, settings_path: &Path) -> BackupStatus {
    let settings = load_backup_settings(settings_path);
    let second_path = settings.second_dir.as_deref().map(Path::new);
    let second_error = second_path
        .filter(|dir| !dir.is_dir())
        .map(|_| SECOND_DIR_UNREACHABLE.to_string());
    let second_last_at = match (second_path, &second_error) {
        (Some(dir), None) => {
            newest_backup_millis(dir, &[DAILY_BACKUP_PREFIX, MANUAL_BACKUP_PREFIX])
        }
        _ => None,
    };
    BackupStatus {
        local_dir: local_dir.display().to_string(),
        local_last_at: newest_backup_millis(local_dir, &[DAILY_BACKUP_PREFIX]),
        retention_days: DAILY_BACKUP_RETENTION_DAYS,
        second_dir: settings.second_dir.clone(),
        second_last_at,
        second_error,
    }
}

fn file_name_part(value: &str) -> String {
    value
        .chars()
        .take(64)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

/// Möglicher Ablageort für die Sicherung vor einem Update. Der Ordner neben
/// der Installation ist der Wunschort, weil die Sicherung dort auch ohne
/// laufende App sofort auffindbar ist. Auf Linux gehört die Installation
/// aber häufig root (`/usr/bin`, Paketinstallation) oder liegt in einem
/// schreibgeschützten AppImage-Mount – dort kann ein normaler Nutzer keinen
/// Ordner anlegen. Deshalb gibt es immer einen beschreibbaren Ausweichort.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateBackupTarget {
    pub dir: PathBuf,
    /// Liegt dieser Ordner neben der installierten Programmdatei?
    pub next_to_installation: bool,
}

impl UpdateBackupTarget {
    /// Unterordner `Backups` neben der installierten Programmdatei.
    pub fn next_to_installation(install_dir: &Path) -> Self {
        Self {
            dir: install_dir.join("Backups"),
            next_to_installation: true,
        }
    }

    /// Backup-Ordner im Anwendungsdatenverzeichnis – derselbe Ort, an dem
    /// auch die täglichen Sicherungen liegen.
    pub fn app_data(backups_dir: &Path) -> Self {
        Self {
            dir: backups_dir.to_path_buf(),
            next_to_installation: false,
        }
    }
}

/// Ergebnis der verpflichtenden Sicherung vor einem Update.
#[derive(Debug, Clone)]
pub struct UpdateBackup {
    pub path: PathBuf,
    /// false, wenn auf das Anwendungsdatenverzeichnis ausgewichen wurde.
    pub next_to_installation: bool,
}

/// Erstellt die verpflichtende Sicherung vor einem App-Update. Die Ablageorte
/// werden der Reihe nach versucht; der erste, in dem die Datei vollständig
/// landet, gewinnt. Erst wenn keiner davon funktioniert, schlägt der Aufruf
/// fehl – und dann darf das Update nicht fortgesetzt werden.
pub fn write_update_backup(
    conn: &Connection,
    keys: &KeyMaterial,
    targets: &[UpdateBackupTarget],
    current_version: &str,
    target_version: &str,
) -> Result<UpdateBackup, ApiError> {
    let stamp = db::now(conn)?.replace(':', "-");
    let current = file_name_part(current_version);
    let target = file_name_part(target_version);
    let file_name = format!("vor-update-{current}-auf-{target}-{stamp}.{BACKUP_FILE_EXTENSION}");
    let bytes = create_backup_bytes(conn, keys)?;

    for candidate in targets {
        let Ok(path) = write_backup_file(&candidate.dir, &file_name, &bytes) else {
            continue;
        };
        return Ok(UpdateBackup {
            path,
            next_to_installation: candidate.next_to_installation,
        });
    }

    Err(ApiError::backup(
        "Das Sicherheits-Backup vor dem Update konnte nirgends gespeichert werden – \
         weder neben der installierten App noch im Datenordner der App. \
         Das Update wurde deshalb nicht gestartet.",
    ))
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
                vehicle_id: None,
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

    /// Ordner, in dem sich nichts anlegen lässt: Der Elternpfad ist eine
    /// Datei. Das bildet plattformunabhängig nach, was unter Linux ein
    /// Installationsordner ohne Schreibrecht (`/usr/bin`) oder ein
    /// schreibgeschützter AppImage-Mount auslöst.
    fn nicht_beschreibbarer_ordner(dir: &Path) -> PathBuf {
        let blocker = dir.join("nicht-beschreibbar");
        std::fs::write(&blocker, b"datei statt ordner").unwrap();
        blocker.join("Backups")
    }

    #[test]
    fn update_backup_liegt_neben_der_installation_und_ist_vollstaendig() {
        let dir = tempfile::tempdir().unwrap();
        let install_dir = dir.path().join("installation");
        std::fs::create_dir_all(&install_dir).unwrap();
        let conn = open_db(&dir.path().join("aktuell.db"));
        let keys = test_keys();
        seed(&conn, &keys);

        let targets = [
            UpdateBackupTarget::next_to_installation(&install_dir),
            UpdateBackupTarget::app_data(&dir.path().join("daten-backups")),
        ];
        let result = write_update_backup(&conn, &keys, &targets, "1.0.0", "1.0.1").unwrap();

        assert!(result.next_to_installation);
        assert_eq!(
            result.path.parent(),
            Some(install_dir.join("Backups").as_path())
        );
        assert!(result.path.exists());
        assert!(result
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("vor-update-1.0.0-auf-1.0.1-"));
        let bytes = std::fs::read(&result.path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(MARKER_NAME));
        validate_backup_bytes(&bytes, None, Some(&keys.master_key), None).unwrap();
    }

    #[test]
    fn update_backup_weicht_auf_den_datenordner_aus_wenn_die_installation_gesperrt_ist() {
        // Linux-Fall: Neben der Installation darf der Nutzer keinen Ordner
        // anlegen. Das Update darf daran nicht scheitern – die Sicherung muss
        // vollständig im Datenordner landen.
        let dir = tempfile::tempdir().unwrap();
        let conn = open_db(&dir.path().join("aktuell.db"));
        let keys = test_keys();
        seed(&conn, &keys);

        let gesperrt = nicht_beschreibbarer_ordner(dir.path());
        let daten_backups = dir.path().join("daten").join("backups");
        let targets = [
            UpdateBackupTarget {
                dir: gesperrt.clone(),
                next_to_installation: true,
            },
            UpdateBackupTarget::app_data(&daten_backups),
        ];
        let result = write_update_backup(&conn, &keys, &targets, "1.0.0", "1.0.1").unwrap();

        assert!(!result.next_to_installation);
        assert_eq!(result.path.parent(), Some(daten_backups.as_path()));
        assert!(!gesperrt.exists());
        let bytes = std::fs::read(&result.path).unwrap();
        // Der Ausweichort liefert kein halbes Backup: Es ist vollständig
        // gültig und enthält die versteckten Daten weiterhin verschlüsselt.
        assert!(!String::from_utf8_lossy(&bytes).contains(MARKER_NAME));
        let validated = validate_backup_bytes(&bytes, None, Some(&keys.master_key), None).unwrap();
        assert_eq!(validated.hidden_count, 1);
        assert_eq!(validated.vehicle_count, 1);

        // Keine temporäre Restdatei im Ausweichordner.
        let übrig: Vec<_> = std::fs::read_dir(&daten_backups).unwrap().collect();
        assert_eq!(übrig.len(), 1);
    }

    #[test]
    fn update_backup_scheitert_erst_wenn_kein_einziger_ort_funktioniert() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_db(&dir.path().join("aktuell.db"));
        let keys = test_keys();
        seed(&conn, &keys);

        let gesperrt = nicht_beschreibbarer_ordner(dir.path());
        let targets = [
            UpdateBackupTarget {
                dir: gesperrt.clone(),
                next_to_installation: true,
            },
            UpdateBackupTarget {
                dir: gesperrt.join("noch-tiefer"),
                next_to_installation: false,
            },
        ];
        let err = write_update_backup(&conn, &keys, &targets, "1.0.0", "1.0.1").unwrap_err();

        assert_eq!(err.code, ErrorCode::Backup);
        assert!(err.message.contains("nicht gestartet"));
        assert!(!format!("{err} {err:?}").contains(MARKER_NAME));
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
    fn taegliches_backup_wird_pro_tag_nur_einmal_erstellt() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_db(&dir.path().join("aktuell.db"));
        let keys = test_keys();
        seed(&conn, &keys);
        let backups_dir = dir.path().join("backups");

        let first =
            write_daily_backup_for_dates(&conn, &keys, &backups_dir, "2026-08-11", "2026-07-29")
                .unwrap();
        let first_bytes = std::fs::read(&first.path).unwrap();
        let second =
            write_daily_backup_for_dates(&conn, &keys, &backups_dir, "2026-08-11", "2026-07-29")
                .unwrap();

        assert!(first.created);
        assert!(!second.created);
        assert_eq!(first.path, second.path);
        assert_eq!(std::fs::read(&second.path).unwrap(), first_bytes);
        validate_backup_bytes(&first_bytes, None, Some(&keys.master_key), None).unwrap();
    }

    #[test]
    fn taegliche_backups_werden_nach_14_tagen_bereinigt() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_db(&dir.path().join("aktuell.db"));
        let keys = test_keys();
        let backups_dir = dir.path().join("backups");
        std::fs::create_dir_all(&backups_dir).unwrap();

        let expired: Vec<PathBuf> = ["26", "27", "28"]
            .iter()
            .map(|day| backups_dir.join(format!("taeglich-2026-07-{day}.werkstattbackup")))
            .collect();
        let cutoff = backups_dir.join("taeglich-2026-07-29.werkstattbackup");
        let recent_a = backups_dir.join("taeglich-2026-08-09.werkstattbackup");
        let recent_b = backups_dir.join("taeglich-2026-08-10.werkstattbackup");
        let unrelated = backups_dir.join("vor-wiederherstellung-alt.werkstattbackup");
        for file in expired
            .iter()
            .chain([&cutoff, &recent_a, &recent_b, &unrelated])
        {
            std::fs::write(file, b"alt").unwrap();
        }

        let result =
            write_daily_backup_for_dates(&conn, &keys, &backups_dir, "2026-08-11", "2026-07-29")
                .unwrap();

        assert!(result.created);
        for file in &expired {
            assert!(!file.exists(), "{file:?}");
        }
        assert!(cutoff.exists());
        assert!(recent_a.exists());
        assert!(recent_b.exists());
        assert!(unrelated.exists());
        assert!(result.path.exists());
    }

    #[test]
    fn die_drei_neuesten_sicherungen_bleiben_auch_nach_einer_langen_pause() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_db(&dir.path().join("aktuell.db"));
        let keys = test_keys();
        let backups_dir = dir.path().join("backups");
        std::fs::create_dir_all(&backups_dir).unwrap();

        // Vier Sicherungen aus dem Juni; danach war der Rechner wochenlang aus.
        let juni: Vec<PathBuf> = ["01", "02", "03", "04"]
            .iter()
            .map(|day| backups_dir.join(format!("taeglich-2026-06-{day}.werkstattbackup")))
            .collect();
        let update = backups_dir.join("vor-update-1.0.0-auf-1.0.1-x.werkstattbackup");
        for file in juni.iter().chain([&update]) {
            std::fs::write(file, b"alt").unwrap();
        }

        let result =
            write_daily_backup_for_dates(&conn, &keys, &backups_dir, "2026-08-11", "2026-07-29")
                .unwrap();

        // Heute plus die beiden neuesten aus dem Juni bleiben, obwohl diese weit
        // außerhalb der 14 Tage liegen; nur die älteren werden aufgeräumt.
        assert!(result.path.exists());
        assert!(!juni[0].exists());
        assert!(!juni[1].exists());
        assert!(juni[2].exists());
        assert!(juni[3].exists());
        assert!(update.exists());
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

    // ---------- Zweiter Sicherungsordner ----------

    fn tagessicherung_fuer_test(dir: &Path) -> (Connection, KeyMaterial, DailyBackupResult) {
        let conn = open_db(&dir.join("aktuell.db"));
        let keys = test_keys();
        seed(&conn, &keys);
        let local = write_daily_backup_for_dates(
            &conn,
            &keys,
            &dir.join("backups"),
            "2026-08-11",
            "2026-07-29",
        )
        .unwrap();
        (conn, keys, local)
    }

    fn setze_aenderungszeit(path: &Path, sekunden: u64) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(sekunden))
            .unwrap();
    }

    fn aenderungszeit(path: &Path) -> u64 {
        std::fs::metadata(path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    /// Name des eigenen Ordners in den Tests.
    const TEST_ORDNER: &str = "Werkstatt-Motion-Sicherung-TEST";

    #[test]
    fn zweiter_ordner_bekommt_die_tagessicherung_und_raeumt_nur_eigene_alte_dateien_auf() {
        let dir = tempfile::tempdir().unwrap();
        let (_conn, keys, local) = tagessicherung_fuer_test(dir.path());
        let second_dir = dir.path().join("usb-stick");
        std::fs::create_dir_all(&second_dir).unwrap();
        let abgelaufen = second_dir.join("taeglich-2026-07-28.werkstattbackup");
        let grenze = second_dir.join("taeglich-2026-07-29.werkstattbackup");
        let neu_a = second_dir.join("taeglich-2026-08-09.werkstattbackup");
        let neu_b = second_dir.join("taeglich-2026-08-10.werkstattbackup");
        let manuell = second_dir.join("manuell-2026-07-01_08-00-00.werkstattbackup");
        let fremd = second_dir.join("urlaubsfotos.zip");
        for file in [&abgelaufen, &grenze, &neu_a, &neu_b, &manuell, &fremd] {
            std::fs::write(file, b"inhalt").unwrap();
        }
        // Die Tagessicherung ist schon Stunden alt, wenn der Stick eingesteckt wird.
        setze_aenderungszeit(&local.path, 1_700_000_000);

        let first =
            mirror_daily_backup(&local.path, &second_dir, "2026-08-11", "2026-07-29").unwrap();

        assert!(first.created);
        assert_eq!(
            first.path,
            second_dir.join("taeglich-2026-08-11.werkstattbackup")
        );
        let bytes = std::fs::read(&first.path).unwrap();
        assert_eq!(bytes, std::fs::read(&local.path).unwrap());
        validate_backup_bytes(&bytes, None, Some(&keys.master_key), None).unwrap();
        // Die Kopie trägt das Alter der Daten, nicht den Moment des Kopierens.
        assert_eq!(aenderungszeit(&first.path), 1_700_000_000);
        assert!(!abgelaufen.exists());
        assert!(grenze.exists());
        assert!(manuell.exists());
        assert!(fremd.exists());

        // Am selben Tag gibt es nichts Neues, und es bleiben keine Reste liegen.
        let again =
            mirror_daily_backup(&local.path, &second_dir, "2026-08-11", "2026-07-29").unwrap();
        assert!(!again.created);
        let reste = std::fs::read_dir(&second_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with('.'))
            .count();
        assert_eq!(reste, 0);
    }

    #[test]
    fn zweiter_ordner_behaelt_nach_einer_langen_pause_die_neuesten_sicherungen() {
        let dir = tempfile::tempdir().unwrap();
        let (_conn, _keys, local) = tagessicherung_fuer_test(dir.path());
        let second_dir = dir.path().join("usb-stick");
        std::fs::create_dir_all(&second_dir).unwrap();
        let juni: Vec<PathBuf> = ["01", "02", "03", "04"]
            .iter()
            .map(|day| second_dir.join(format!("taeglich-2026-06-{day}.werkstattbackup")))
            .collect();
        for file in &juni {
            std::fs::write(file, b"alt").unwrap();
        }

        mirror_daily_backup(&local.path, &second_dir, "2026-08-11", "2026-07-29").unwrap();

        // Wie auf dem Computer: Heute und die beiden neuesten älteren bleiben.
        assert!(second_dir
            .join("taeglich-2026-08-11.werkstattbackup")
            .exists());
        assert!(!juni[0].exists());
        assert!(!juni[1].exists());
        assert!(juni[2].exists());
        assert!(juni[3].exists());
    }

    #[test]
    fn zweite_sicherung_legt_einen_fehlenden_ordner_nicht_an() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, keys, local) = tagessicherung_fuer_test(dir.path());
        let fehlend = dir.path().join("nicht-eingesteckt").join("Sicherung");

        let err =
            mirror_daily_backup(&local.path, &fehlend, "2026-08-11", "2026-07-29").unwrap_err();
        assert_eq!(err.code, ErrorCode::Backup);
        assert!(err.message.contains("nicht erreichbar"));

        let stamp = manual_backup_stamp(&conn).unwrap();
        let bytes = create_backup_bytes(&conn, &keys).unwrap();
        let err = write_manual_backup(&fehlend, &stamp, &bytes).unwrap_err();
        assert_eq!(err.code, ErrorCode::Backup);
        assert!(!dir.path().join("nicht-eingesteckt").exists());
    }

    #[test]
    fn gleichzeitige_schreibvorgaenge_in_dieselbe_datei_lassen_nichts_halbes_zurueck() {
        const NAME: &str = "taeglich-2026-08-11.werkstattbackup";
        let dir = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();

        let results: Vec<bool> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| write_backup_file(dir.path(), NAME, &bytes).is_ok()))
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect()
        });

        // Unter Windows kann ein gleichzeitiges Umbenennen einzelne Läufe
        // abweisen; entscheidend ist, dass die Datei vollständig ankommt und
        // keine temporären Reste bleiben.
        assert!(results.iter().any(|ok| *ok));
        assert_eq!(std::fs::read(dir.path().join(NAME)).unwrap(), bytes);
        let reste: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name != NAME)
            .collect();
        assert!(reste.is_empty(), "übrig geblieben: {reste:?}");
    }

    #[test]
    fn manuelle_sicherung_liegt_mit_zeitstempel_im_zweiten_ordner_und_ist_gueltig() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, keys, _local) = tagessicherung_fuer_test(dir.path());
        let second_dir = dir.path().join("usb-stick");
        std::fs::create_dir_all(&second_dir).unwrap();

        let stamp = manual_backup_stamp(&conn).unwrap();
        let bytes = create_backup_bytes(&conn, &keys).unwrap();
        let path = write_manual_backup(&second_dir, &stamp, &bytes).unwrap();

        assert_eq!(path.parent(), Some(second_dir.as_path()));
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("manuell-20"));
        assert_eq!(name, format!("manuell-{stamp}.werkstattbackup"));
        let bytes = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(MARKER_NAME));
        validate_backup_bytes(&bytes, None, Some(&keys.master_key), None).unwrap();
    }

    #[test]
    fn zweiter_ordner_wird_geprueft_und_als_eigener_unterordner_gemerkt() {
        let data = tempfile::tempdir().unwrap();
        let stick = tempfile::tempdir().unwrap();
        let settings_path = data.path().join("sicherung.json");
        let backups_dir = data.path().join("backups");
        std::fs::create_dir_all(&backups_dir).unwrap();

        assert_eq!(
            load_backup_settings(&settings_path),
            BackupSettings::default()
        );

        // Im gewählten Ordner entsteht der eigene Ordner, und nur der wird gemerkt.
        set_second_dir(&settings_path, &backups_dir, stick.path(), TEST_ORDNER).unwrap();
        let eigener = stick.path().join(TEST_ORDNER);
        assert!(eigener.is_dir());
        assert_eq!(
            load_backup_settings(&settings_path).second_dir,
            Some(eigener.display().to_string())
        );
        // Der Schreibtest hinterlässt nichts, und sonst bleibt der Ordner unberührt.
        assert_eq!(std::fs::read_dir(&eigener).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(stick.path()).unwrap().count(), 1);

        // Wird der eigene Ordner selbst gewählt, entsteht darin kein zweiter.
        set_second_dir(&settings_path, &backups_dir, &eigener, TEST_ORDNER).unwrap();
        assert_eq!(
            load_backup_settings(&settings_path).second_dir,
            Some(eigener.display().to_string())
        );
        assert_eq!(std::fs::read_dir(&eigener).unwrap().count(), 0);

        // Die Daten der App sind kein zweiter Ort: der Ordner der Sicherungen,
        // ein Unterordner davon und der Datenordner selbst.
        let darunter = backups_dir.join("unterordner");
        std::fs::create_dir_all(&darunter).unwrap();
        for eigen in [backups_dir.as_path(), darunter.as_path(), data.path()] {
            let err = set_second_dir(&settings_path, &backups_dir, eigen, TEST_ORDNER).unwrap_err();
            assert_eq!(err.code, ErrorCode::Backup);
            assert!(err.message.contains("anderen Ordner"), "{eigen:?}");
        }
        assert!(!backups_dir.join(TEST_ORDNER).exists());
        assert!(!data.path().join(TEST_ORDNER).exists());

        // Ein fehlender Ordner wird abgelehnt, die bisherige Wahl bleibt.
        let err = set_second_dir(
            &settings_path,
            &backups_dir,
            &stick.path().join("weg"),
            TEST_ORDNER,
        )
        .unwrap_err();
        assert!(err.message.contains("nicht erreichbar"));
        assert_eq!(
            load_backup_settings(&settings_path).second_dir,
            Some(eigener.display().to_string())
        );

        // Entfernen vergisst den Ordner, löscht dort aber nichts.
        std::fs::write(eigener.join("taeglich-2026-08-11.werkstattbackup"), b"x").unwrap();
        clear_second_dir(&settings_path).unwrap();
        assert_eq!(load_backup_settings(&settings_path).second_dir, None);
        assert!(eigener.join("taeglich-2026-08-11.werkstattbackup").exists());
    }

    #[test]
    fn dateien_im_gewaehlten_ordner_bleiben_unberuehrt() {
        let data = tempfile::tempdir().unwrap();
        let stick = tempfile::tempdir().unwrap();
        let (_conn, _keys, local) = tagessicherung_fuer_test(data.path());
        let settings_path = data.path().join("sicherung.json");
        // Auf dem Stick liegen schon alte Kopien, z. B. von Hand dorthin kopiert.
        let alt = stick.path().join("taeglich-2026-01-05.werkstattbackup");
        let urlaub = stick.path().join("urlaubsfotos.zip");
        std::fs::write(&alt, b"von Hand kopiert").unwrap();
        std::fs::write(&urlaub, b"fotos").unwrap();

        set_second_dir(
            &settings_path,
            &data.path().join("backups"),
            stick.path(),
            TEST_ORDNER,
        )
        .unwrap();
        let eigener = PathBuf::from(load_backup_settings(&settings_path).second_dir.unwrap());
        mirror_daily_backup(&local.path, &eigener, "2026-08-11", "2026-07-29").unwrap();

        // Aufgeräumt wird nur im eigenen Ordner.
        assert!(alt.exists());
        assert!(urlaub.exists());
        assert!(eigener.join("taeglich-2026-08-11.werkstattbackup").exists());
    }

    #[test]
    fn ein_anderer_stick_am_selben_ort_wird_nicht_beschrieben() {
        let data = tempfile::tempdir().unwrap();
        let stick = tempfile::tempdir().unwrap();
        let (conn, keys, local) = tagessicherung_fuer_test(data.path());
        let settings_path = data.path().join("sicherung.json");
        let backups_dir = data.path().join("backups");
        set_second_dir(&settings_path, &backups_dir, stick.path(), TEST_ORDNER).unwrap();
        let eigener = stick.path().join(TEST_ORDNER);

        // Der Laufwerksbuchstabe (oder der Einhängepunkt) existiert noch, aber
        // der eigene Ordner ist weg: Es steckt ein anderer Datenträger darin.
        std::fs::remove_dir_all(&eigener).unwrap();

        let err =
            mirror_daily_backup(&local.path, &eigener, "2026-08-11", "2026-07-29").unwrap_err();
        assert!(err.message.contains("nicht erreichbar"));
        let stamp = manual_backup_stamp(&conn).unwrap();
        let bytes = create_backup_bytes(&conn, &keys).unwrap();
        assert!(write_manual_backup(&eigener, &stamp, &bytes).is_err());
        assert!(backup_status(&backups_dir, &settings_path)
            .second_error
            .unwrap()
            .contains("nicht erreichbar"));
        assert!(!eigener.exists());
        assert_eq!(std::fs::read_dir(stick.path()).unwrap().count(), 0);
    }

    #[test]
    fn aufraeumen_haelt_eine_fertige_sicherung_nicht_auf() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, keys, local) = tagessicherung_fuer_test(dir.path());
        let second_dir = dir.path().join("usb-stick");
        std::fs::create_dir_all(&second_dir).unwrap();
        // Ein Eintrag mit dem Namen einer abgelaufenen Sicherung, der sich nicht
        // wie eine Datei löschen lässt (steht hier für eine gesperrte Datei).
        std::fs::create_dir_all(second_dir.join("taeglich-2026-07-01.werkstattbackup")).unwrap();
        let backups_dir = dir.path().join("backups");
        std::fs::create_dir_all(backups_dir.join("taeglich-2026-07-02.werkstattbackup")).unwrap();

        let kopie =
            mirror_daily_backup(&local.path, &second_dir, "2026-08-11", "2026-07-29").unwrap();
        assert!(kopie.created);
        assert!(kopie.path.is_file());

        // Auch lokal bleibt die fertige Sicherung ein Erfolg, und die Kopie läuft weiter.
        let lokal =
            write_daily_backup_for_dates(&conn, &keys, &backups_dir, "2026-08-12", "2026-07-30")
                .unwrap();
        assert!(lokal.created);
        assert!(lokal.path.is_file());
    }

    #[test]
    fn eigener_ordnername_enthaelt_keine_pfadzeichen() {
        let name = second_folder_name();
        assert!(name.starts_with(SECOND_FOLDER_BASE_NAME));
        assert!(!name.contains(['/', '\\', ':']), "{name}");
        assert!(name.len() <= SECOND_FOLDER_BASE_NAME.len() + 1 + 64);
    }

    #[test]
    fn defekte_einstellungsdatei_faellt_auf_die_standardwerte_zurueck() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sicherung.json");
        assert_eq!(load_backup_settings(&path), BackupSettings::default());

        std::fs::write(&path, b"{ kaputt").unwrap();
        assert_eq!(load_backup_settings(&path), BackupSettings::default());

        // Unbekannte Felder aus einer neueren Version stören nicht.
        std::fs::write(&path, br#"{"secondDir":"E:\\Sicherung","neu":true}"#).unwrap();
        assert_eq!(
            load_backup_settings(&path).second_dir.as_deref(),
            Some("E:\\Sicherung")
        );
    }

    #[test]
    fn status_zeigt_die_letzten_sicherungen_und_einen_nicht_erreichbaren_ordner() {
        let dir = tempfile::tempdir().unwrap();
        let settings_path = dir.path().join("sicherung.json");
        let local = dir.path().join("backups");
        std::fs::create_dir_all(&local).unwrap();

        // Ohne Sicherungen und ohne zweiten Ort.
        let leer = backup_status(&local, &settings_path);
        assert_eq!(leer.local_last_at, None);
        assert_eq!(leer.second_dir, None);
        assert_eq!(leer.second_error, None);
        assert_eq!(leer.retention_days, DAILY_BACKUP_RETENTION_DAYS);

        // Die neueste Tagessicherung zählt; andere Dateien (hier vor-update) nicht.
        let alt = local.join("taeglich-2026-08-10.werkstattbackup");
        let neu = local.join("taeglich-2026-08-11.werkstattbackup");
        let update = local.join("vor-update-1.0.0-auf-1.0.1-x.werkstattbackup");
        for file in [&alt, &neu, &update] {
            std::fs::write(file, b"x").unwrap();
        }
        setze_aenderungszeit(&alt, 1_000_000);
        setze_aenderungszeit(&neu, 2_000_000);
        setze_aenderungszeit(&update, 3_000_000);
        assert_eq!(
            backup_status(&local, &settings_path).local_last_at,
            Some(2_000_000_000)
        );

        // Zweiter Ort, der gerade fehlt (USB-Stick nicht eingesteckt).
        let stick = tempfile::tempdir().unwrap();
        set_second_dir(&settings_path, &local, stick.path(), TEST_ORDNER).unwrap();
        let usb = stick.path().join(TEST_ORDNER);
        std::fs::remove_dir_all(&usb).unwrap();
        let getrennt = backup_status(&local, &settings_path);
        assert_eq!(getrennt.second_dir, Some(usb.display().to_string()));
        assert_eq!(getrennt.second_last_at, None);
        assert!(getrennt.second_error.unwrap().contains("nicht erreichbar"));

        // Wieder eingesteckt: Tages- und manuelle Sicherungen zählen, die neueste gewinnt.
        std::fs::create_dir_all(&usb).unwrap();
        let tag = usb.join("taeglich-2026-08-11.werkstattbackup");
        let manuell = usb.join("manuell-2026-08-11_16-30-00.werkstattbackup");
        std::fs::write(&tag, b"x").unwrap();
        std::fs::write(&manuell, b"x").unwrap();
        setze_aenderungszeit(&tag, 4_000_000);
        setze_aenderungszeit(&manuell, 5_000_000);
        let da = backup_status(&local, &settings_path);
        assert_eq!(da.second_error, None);
        assert_eq!(da.second_last_at, Some(5_000_000_000));
    }
}
