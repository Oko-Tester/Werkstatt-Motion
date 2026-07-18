use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::crypto::{self, SecretKey, ENCRYPTION_VERSION};
use crate::db;
use crate::error::ApiError;
use crate::models::{HiddenEntry, HiddenEntryPatch, NewHiddenEntry, SecretHistoryEntry};

/// Fachlicher Inhalt eines versteckten Eintrags. Wird als Ganzes serialisiert
/// und verschlüsselt – einzelne Felder landen nie im Klartext in SQLite.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HiddenPayload {
    name: String,
    amount_cents: i64,
    note: String,
}

/// Fachlicher Inhalt eines archivierten versteckten Eintrags. Auch der
/// Abschlusszeitpunkt wird authentifiziert verschlüsselt gespeichert.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HiddenHistoryPayload {
    name: String,
    amount_cents: i64,
    note: String,
    completed_or_archived_at: String,
}

/// Bindet Ciphertext an Eintrags-ID und Formatversion. Verhindert, dass
/// verschlüsselte Payloads zwischen Zeilen vertauscht werden können.
fn aad_for(id: &str, version: i64) -> Vec<u8> {
    format!("werkstatt-hidden:{id}:{version}").into_bytes()
}

/// Eigene AAD-Domäne für History-Snapshots. Dadurch kann ein gültiger
/// Ciphertext aus `hidden_entries` nie als History-Payload wiederverwendet
/// werden (und umgekehrt), selbst wenn IDs und Schlüssel übereinstimmen.
fn history_aad_for(
    id: &str,
    source_hidden_entry_id: &str,
    completed_at: &str,
    created_at: &str,
    version: i64,
) -> Vec<u8> {
    format!(
        "werkstatt-hidden-history:{id}:{source_hidden_entry_id}:{completed_at}:{created_at}:{version}"
    )
    .into_bytes()
}

fn validate(name: &str, amount_cents: i64) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::validation(
            "name",
            "Bezeichnung darf nicht leer sein",
        ));
    }
    if amount_cents <= 0 {
        return Err(ApiError::validation(
            "amountCents",
            "Betrag muss größer als 0 sein",
        ));
    }
    Ok(())
}

fn encrypt_payload(
    key: &SecretKey,
    id: &str,
    payload: &HiddenPayload,
) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let plaintext = Zeroizing::new(serde_json::to_vec(payload).map_err(|_| ApiError::crypto())?);
    let (ciphertext, nonce) = crypto::seal(key, &plaintext, &aad_for(id, ENCRYPTION_VERSION))?;
    Ok((ciphertext, nonce.to_vec()))
}

fn encrypt_history_payload(
    key: &SecretKey,
    id: &str,
    source_hidden_entry_id: &str,
    completed_at: &str,
    created_at: &str,
    payload: &HiddenHistoryPayload,
) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let plaintext = Zeroizing::new(serde_json::to_vec(payload).map_err(|_| ApiError::crypto())?);
    let aad = history_aad_for(
        id,
        source_hidden_entry_id,
        completed_at,
        created_at,
        ENCRYPTION_VERSION,
    );
    let (ciphertext, nonce) = crypto::seal(key, &plaintext, &aad)?;
    Ok((ciphertext, nonce.to_vec()))
}

struct EncryptedRow {
    id: String,
    encrypted_payload: Vec<u8>,
    nonce: Vec<u8>,
    encryption_version: i64,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
}

struct EncryptedHistoryRow {
    id: String,
    source_hidden_entry_id: String,
    encrypted_payload: Vec<u8>,
    nonce: Vec<u8>,
    encryption_version: i64,
    completed_at: String,
    created_at: String,
}

fn row_from_db(row: &Row<'_>) -> rusqlite::Result<EncryptedRow> {
    Ok(EncryptedRow {
        id: row.get("id")?,
        encrypted_payload: row.get("encrypted_payload")?,
        nonce: row.get("nonce")?,
        encryption_version: row.get("encryption_version")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        archived_at: row.get("archived_at")?,
    })
}

fn history_row_from_db(row: &Row<'_>) -> rusqlite::Result<EncryptedHistoryRow> {
    Ok(EncryptedHistoryRow {
        id: row.get("id")?,
        source_hidden_entry_id: row.get("source_hidden_entry_id")?,
        encrypted_payload: row.get("encrypted_payload")?,
        nonce: row.get("nonce")?,
        encryption_version: row.get("encryption_version")?,
        completed_at: row.get("completed_at")?,
        created_at: row.get("created_at")?,
    })
}

fn decrypt_row(key: &SecretKey, row: EncryptedRow) -> Result<HiddenEntry, ApiError> {
    // Unbekannte (zukünftige) Formatversionen werden abgelehnt statt geraten.
    if row.encryption_version != ENCRYPTION_VERSION {
        return Err(ApiError::crypto());
    }
    let plaintext = crypto::open(
        key,
        &row.encrypted_payload,
        &row.nonce,
        &aad_for(&row.id, row.encryption_version),
    )?;
    let payload: HiddenPayload =
        serde_json::from_slice(&plaintext).map_err(|_| ApiError::crypto())?;
    Ok(HiddenEntry {
        id: row.id,
        name: payload.name,
        amount_cents: payload.amount_cents,
        note: payload.note,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
    })
}

fn decrypt_history_row(
    key: &SecretKey,
    row: EncryptedHistoryRow,
) -> Result<SecretHistoryEntry, ApiError> {
    if row.encryption_version != ENCRYPTION_VERSION {
        return Err(ApiError::crypto());
    }
    let plaintext = crypto::open(
        key,
        &row.encrypted_payload,
        &row.nonce,
        &history_aad_for(
            &row.id,
            &row.source_hidden_entry_id,
            &row.completed_at,
            &row.created_at,
            row.encryption_version,
        ),
    )?;
    let payload: HiddenHistoryPayload =
        serde_json::from_slice(&plaintext).map_err(|_| ApiError::crypto())?;
    if payload.completed_or_archived_at != row.completed_at {
        return Err(ApiError::crypto());
    }
    Ok(SecretHistoryEntry {
        id: row.id,
        source_hidden_entry_id: row.source_hidden_entry_id,
        name: payload.name,
        amount_cents: payload.amount_cents,
        note: payload.note,
        completed_or_archived_at: payload.completed_or_archived_at,
        completed_at: row.completed_at,
        created_at: row.created_at,
    })
}

fn get_row(conn: &Connection, id: &str) -> Result<EncryptedRow, ApiError> {
    conn.query_row(
        "SELECT * FROM hidden_entries WHERE id = ?1",
        [id],
        row_from_db,
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => ApiError::not_found("Eintrag nicht gefunden"),
        other => other.into(),
    })
}

pub fn get_entry(conn: &Connection, key: &SecretKey, id: &str) -> Result<HiddenEntry, ApiError> {
    decrypt_row(key, get_row(conn, id)?)
}

/// Anzahl aller versteckten Einträge inklusive archivierter (nur für Tests).
#[cfg(test)]
pub fn count_entries(conn: &Connection) -> Result<i64, ApiError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM hidden_entries", [], |row| row.get(0))?)
}

/// Anzahl aller verschlüsselten Datensätze aus aktuellem Bestand und Historie.
/// Dient als „es existieren verschlüsselte Daten“-Signal für die
/// Schlüsselverwaltung und darf die History nicht übersehen.
pub fn count_encrypted_records(conn: &Connection) -> Result<i64, ApiError> {
    Ok(conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM hidden_entries) +
            (SELECT COUNT(*) FROM hidden_entry_history)",
        [],
        |row| row.get(0),
    )?)
}

/// Aktive versteckte Einträge, älteste zuerst (wie offene Zahlungen).
pub fn list_entries(conn: &Connection, key: &SecretKey) -> Result<Vec<HiddenEntry>, ApiError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM hidden_entries WHERE archived_at IS NULL
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([], row_from_db)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|row| decrypt_row(key, row)).collect()
}

/// Entschlüsselt jede Bestandszeile inklusive archivierter und prüft damit
/// deren Integrität.
pub fn verify_entries(conn: &Connection, key: &SecretKey) -> Result<i64, ApiError> {
    let mut stmt = conn.prepare("SELECT * FROM hidden_entries ORDER BY id ASC")?;
    let rows = stmt
        .query_map([], row_from_db)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut count = 0;
    for row in rows {
        decrypt_row(key, row)?;
        count += 1;
    }
    Ok(count)
}

/// Entschlüsselte Secret-History, jüngstes Archivierungsereignis zuerst. Die
/// zusätzlichen Tie-Breaker machen die Reihenfolge über Aufrufe hinweg stabil.
pub fn list_history(
    conn: &Connection,
    key: &SecretKey,
) -> Result<Vec<SecretHistoryEntry>, ApiError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM hidden_entry_history
         ORDER BY completed_at DESC, created_at DESC, id ASC",
    )?;
    let rows = stmt
        .query_map([], history_row_from_db)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|row| decrypt_history_row(key, row))
        .collect()
}

/// Prüft jeden verschlüsselten History-Snapshot, auch wenn der zugehörige
/// aktive Datensatz nicht mehr gelistet wird.
pub fn verify_history(conn: &Connection, key: &SecretKey) -> Result<i64, ApiError> {
    let mut stmt = conn.prepare("SELECT * FROM hidden_entry_history ORDER BY id ASC")?;
    let rows = stmt
        .query_map([], history_row_from_db)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut count = 0;
    for row in rows {
        decrypt_history_row(key, row)?;
        count += 1;
    }
    Ok(count)
}

/// Integritätsprüfung des gesamten Secret-Bestands einschließlich Historie.
pub fn verify_all(conn: &Connection, key: &SecretKey) -> Result<i64, ApiError> {
    Ok(verify_entries(conn, key)? + verify_history(conn, key)?)
}

pub fn create_entry(
    conn: &Connection,
    key: &SecretKey,
    input: NewHiddenEntry,
) -> Result<HiddenEntry, ApiError> {
    let payload = HiddenPayload {
        name: input.name.trim().to_string(),
        amount_cents: input.amount_cents,
        note: input.note.trim().to_string(),
    };
    validate(&payload.name, payload.amount_cents)?;

    let id = Uuid::new_v4().to_string();
    let (ciphertext, nonce) = encrypt_payload(key, &id, &payload)?;
    let timestamp = db::now(conn)?;
    conn.execute(
        "INSERT INTO hidden_entries
            (id, encrypted_payload, nonce, encryption_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, ciphertext, nonce, ENCRYPTION_VERSION, timestamp],
    )?;
    get_entry(conn, key, &id)
}

pub fn update_entry(
    conn: &Connection,
    key: &SecretKey,
    id: &str,
    patch: HiddenEntryPatch,
) -> Result<HiddenEntry, ApiError> {
    let current = get_entry(conn, key, id)?;
    let payload = HiddenPayload {
        name: patch
            .name
            .map(|value| value.trim().to_string())
            .unwrap_or(current.name),
        amount_cents: patch.amount_cents.unwrap_or(current.amount_cents),
        note: patch
            .note
            .map(|value| value.trim().to_string())
            .unwrap_or(current.note),
    };
    validate(&payload.name, payload.amount_cents)?;

    let (ciphertext, nonce) = encrypt_payload(key, id, &payload)?;
    let timestamp = db::now(conn)?;
    conn.execute(
        "UPDATE hidden_entries
         SET encrypted_payload = ?2, nonce = ?3, encryption_version = ?4, updated_at = ?5
         WHERE id = ?1",
        params![id, ciphertext, nonce, ENCRYPTION_VERSION, timestamp],
    )?;
    get_entry(conn, key, id)
}

fn get_history_by_source(
    conn: &Connection,
    key: &SecretKey,
    source_hidden_entry_id: &str,
) -> Result<Option<SecretHistoryEntry>, ApiError> {
    let row = conn
        .query_row(
            "SELECT * FROM hidden_entry_history WHERE source_hidden_entry_id = ?1",
            [source_hidden_entry_id],
            history_row_from_db,
        )
        .optional()?;
    row.map(|row| decrypt_history_row(key, row)).transpose()
}

/// Legt genau einen unveränderlichen, verschlüsselten Snapshot für die erste
/// Archivierung an. Ein vorhandener Snapshot wird entschlüsselt geprüft und
/// unverändert wiederverwendet.
fn insert_history_snapshot(
    conn: &Connection,
    key: &SecretKey,
    source_hidden_entry_id: &str,
    snapshot_created_at: &str,
) -> Result<bool, ApiError> {
    if get_history_by_source(conn, key, source_hidden_entry_id)?.is_some() {
        return Ok(false);
    }

    let entry = get_entry(conn, key, source_hidden_entry_id)?;
    let completed_at = entry.archived_at.clone().ok_or_else(|| {
        ApiError::validation(
            "archivedAt",
            "Nur archivierte Einträge können in die Historie übernommen werden",
        )
    })?;
    let history_id = Uuid::new_v4().to_string();
    let payload = HiddenHistoryPayload {
        name: entry.name,
        amount_cents: entry.amount_cents,
        note: entry.note,
        completed_or_archived_at: completed_at.clone(),
    };
    let (ciphertext, nonce) = encrypt_history_payload(
        key,
        &history_id,
        source_hidden_entry_id,
        &completed_at,
        snapshot_created_at,
        &payload,
    )?;
    let changed = conn.execute(
        "INSERT OR IGNORE INTO hidden_entry_history (
            id, source_hidden_entry_id, encrypted_payload, nonce,
            encryption_version, completed_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            history_id,
            source_hidden_entry_id,
            ciphertext,
            nonce,
            ENCRYPTION_VERSION,
            completed_at,
            snapshot_created_at,
        ],
    )?;
    Ok(changed == 1)
}

/// Zieht Snapshots für Einträge nach, die bereits vor Einführung der
/// Secret-History archiviert waren. Erst werden alle Quellzeilen erfolgreich
/// entschlüsselt; danach werden die fehlenden Snapshots atomar eingefügt. Bei
/// falschem Schlüssel oder Manipulation bleibt die Historie unverändert.
pub fn backfill_archived_history(conn: &Connection, key: &SecretKey) -> Result<i64, ApiError> {
    let tx = conn.unchecked_transaction()?;
    // Der Backfill ist selbstständig sicher und setzt nicht voraus, dass der
    // Aufrufer zuvor geprüft hat: bestehender Bestand und bestehende History
    // müssen vollständig authentisch sein, bevor die erste Zeile hinzukommt.
    verify_all(&tx, key)?;
    let ids = {
        let mut stmt = tx.prepare(
            "SELECT h.id
             FROM hidden_entries h
             LEFT JOIN hidden_entry_history hh
               ON hh.source_hidden_entry_id = h.id
             WHERE h.archived_at IS NOT NULL
               AND hh.source_hidden_entry_id IS NULL
             ORDER BY h.archived_at ASC, h.id ASC",
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids
    };

    // Vor dem ersten INSERT alle Kandidaten authentifizieren. So entstehen bei
    // einem beschädigten Altbestand auch innerhalb der Transaktion keine
    // partiellen Snapshots.
    for id in &ids {
        let entry = get_entry(&tx, key, id)?;
        if entry.archived_at.is_none() {
            return Err(ApiError::crypto());
        }
    }

    let mut inserted = 0i64;
    for id in ids {
        let created_at = db::now(&tx)?;
        if insert_history_snapshot(&tx, key, &id, &created_at)? {
            inserted += 1;
        }
    }
    tx.commit()?;
    Ok(inserted)
}

pub fn archive_entry(
    conn: &Connection,
    key: &SecretKey,
    id: &str,
) -> Result<HiddenEntry, ApiError> {
    let tx = conn.unchecked_transaction()?;
    let current = get_entry(&tx, key, id)?;
    let archived_at = match current.archived_at {
        Some(value) => value,
        None => {
            let timestamp = db::now(&tx)?;
            tx.execute(
                "UPDATE hidden_entries
                 SET archived_at = ?2, updated_at = ?2
                 WHERE id = ?1 AND archived_at IS NULL",
                params![id, timestamp],
            )?;
            timestamp
        }
    };
    insert_history_snapshot(&tx, key, id, &archived_at)?;
    tx.commit()?;
    get_entry(conn, key, id)
}

pub fn restore_entry(
    conn: &Connection,
    key: &SecretKey,
    id: &str,
) -> Result<HiddenEntry, ApiError> {
    let timestamp = db::now(conn)?;
    let changed = conn.execute(
        "UPDATE hidden_entries SET archived_at = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, timestamp],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found("Eintrag nicht gefunden"));
    }
    get_entry(conn, key, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    const MARKER_NAME: &str = "GEHEIME-BEZEICHNUNG-93142";
    const MARKER_NOTE: &str = "STRENG-VERTRAULICHE-NOTIZ-58671";

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        db::migrate(&mut conn).unwrap();
        conn
    }

    fn input(name: &str, cents: i64, note: &str) -> NewHiddenEntry {
        NewHiddenEntry {
            name: name.to_string(),
            amount_cents: cents,
            note: note.to_string(),
        }
    }

    #[test]
    fn anlegen_lesen_und_aktualisieren() {
        let conn = test_conn();
        let key = SecretKey::generate();

        let entry = create_entry(&conn, &key, input(" Eintrag A ", 12345, " Notiz ")).unwrap();
        assert_eq!(entry.name, "Eintrag A");
        assert_eq!(entry.amount_cents, 12345);
        assert_eq!(entry.note, "Notiz");
        assert!(entry.archived_at.is_none());

        let list = list_entries(&conn, &key).unwrap();
        assert_eq!(list, vec![entry.clone()]);

        let updated = update_entry(
            &conn,
            &key,
            &entry.id,
            HiddenEntryPatch {
                amount_cents: Some(999),
                note: Some("Neu".to_string()),
                ..HiddenEntryPatch::default()
            },
        )
        .unwrap();
        assert_eq!(updated.name, "Eintrag A");
        assert_eq!(updated.amount_cents, 999);
        assert_eq!(updated.note, "Neu");
    }

    #[test]
    fn validierung_wie_bei_zahlungen() {
        let conn = test_conn();
        let key = SecretKey::generate();

        let err = create_entry(&conn, &key, input("  ", 100, "")).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(err.field.as_deref(), Some("name"));

        let err = create_entry(&conn, &key, input("A", 0, "")).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(err.field.as_deref(), Some("amountCents"));

        let entry = create_entry(&conn, &key, input("A", 100, "")).unwrap();
        let err = update_entry(
            &conn,
            &key,
            &entry.id,
            HiddenEntryPatch {
                amount_cents: Some(-5),
                ..HiddenEntryPatch::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        // Alter Wert bleibt erhalten.
        assert_eq!(get_entry(&conn, &key, &entry.id).unwrap().amount_cents, 100);
    }

    #[test]
    fn archivieren_und_wiederherstellen() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let entry = create_entry(&conn, &key, input("A", 100, "")).unwrap();

        let archived = archive_entry(&conn, &key, &entry.id).unwrap();
        assert!(archived.archived_at.is_some());
        assert!(list_entries(&conn, &key).unwrap().is_empty());
        // Archivierte zählen weiterhin als verschlüsselte Daten; zusätzlich
        // existiert genau ein verschlüsselter History-Snapshot.
        assert_eq!(count_entries(&conn).unwrap(), 1);
        assert_eq!(count_encrypted_records(&conn).unwrap(), 2);
        let history = list_history(&conn, &key).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].source_hidden_entry_id, entry.id);
        assert_eq!(history[0].name, "A");
        assert_eq!(
            history[0].completed_or_archived_at,
            archived.archived_at.clone().unwrap()
        );

        let restored = restore_entry(&conn, &key, &entry.id).unwrap();
        assert!(restored.archived_at.is_none());
        assert_eq!(list_entries(&conn, &key).unwrap().len(), 1);

        let err = archive_entry(&conn, &key, "fehlt").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn klartext_steht_nicht_in_der_datenbankdatei() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hidden-test.db");
        let key = SecretKey::generate();
        {
            let mut conn = Connection::open(&path).unwrap();
            db::migrate(&mut conn).unwrap();
            create_entry(&conn, &key, input(MARKER_NAME, 424242, MARKER_NOTE)).unwrap();
            // Auch nach einem Update darf kein Klartext zurückbleiben.
            let entry = &list_entries(&conn, &key).unwrap()[0];
            update_entry(
                &conn,
                &key,
                &entry.id,
                HiddenEntryPatch {
                    note: Some(format!("{MARKER_NOTE}-geaendert")),
                    ..HiddenEntryPatch::default()
                },
            )
            .unwrap();
            archive_entry(&conn, &key, &entry.id).unwrap();
            let history = list_history(&conn, &key).unwrap();
            assert_eq!(history[0].name, MARKER_NAME);
            assert!(history[0].note.contains(MARKER_NOTE));
        }
        let bytes = std::fs::read(&path).unwrap();
        let haystack = String::from_utf8_lossy(&bytes);
        assert!(!haystack.contains(MARKER_NAME));
        assert!(!haystack.contains(MARKER_NOTE));
        assert!(!haystack.contains("93142"));
        assert!(!haystack.contains("58671"));
    }

    #[test]
    fn gleicher_inhalt_erzeugt_unterschiedliche_nonces() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let a = create_entry(&conn, &key, input("Gleich", 100, "Gleich")).unwrap();
        let b = create_entry(&conn, &key, input("Gleich", 100, "Gleich")).unwrap();

        let nonce = |id: &str| -> Vec<u8> {
            conn.query_row(
                "SELECT nonce FROM hidden_entries WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_ne!(nonce(&a.id), nonce(&b.id));

        // Jede Neuverschlüsselung (Update) bekommt ebenfalls eine frische Nonce.
        let before = nonce(&a.id);
        update_entry(
            &conn,
            &key,
            &a.id,
            HiddenEntryPatch {
                name: Some("Gleich".to_string()),
                ..HiddenEntryPatch::default()
            },
        )
        .unwrap();
        assert_ne!(nonce(&a.id), before);
    }

    #[test]
    fn manipulierter_ciphertext_wird_abgelehnt_ohne_klartext_im_fehler() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let entry = create_entry(&conn, &key, input(MARKER_NAME, 100, MARKER_NOTE)).unwrap();

        let mut blob: Vec<u8> = conn
            .query_row(
                "SELECT encrypted_payload FROM hidden_entries WHERE id = ?1",
                [&entry.id],
                |row| row.get(0),
            )
            .unwrap();
        blob[0] ^= 0x01;
        conn.execute(
            "UPDATE hidden_entries SET encrypted_payload = ?2 WHERE id = ?1",
            params![entry.id, blob],
        )
        .unwrap();

        let err = list_entries(&conn, &key).unwrap_err();
        assert_eq!(err.code, ErrorCode::Crypto);
        let text = format!("{err} {err:?}");
        assert!(!text.contains(MARKER_NAME));
        assert!(!text.contains(MARKER_NOTE));

        assert!(verify_all(&conn, &key).is_err());
    }

    #[test]
    fn vertauschte_payloads_zwischen_zeilen_werden_abgelehnt() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let a = create_entry(&conn, &key, input("A", 100, "")).unwrap();
        let b = create_entry(&conn, &key, input("B", 200, "")).unwrap();

        // Payload und Nonce von B in Zeile A kopieren: die AAD-Bindung an die
        // Eintrags-ID muss das als Manipulation erkennen.
        conn.execute(
            "UPDATE hidden_entries
             SET encrypted_payload = (SELECT encrypted_payload FROM hidden_entries WHERE id = ?2),
                 nonce = (SELECT nonce FROM hidden_entries WHERE id = ?2)
             WHERE id = ?1",
            params![a.id, b.id],
        )
        .unwrap();

        let err = get_entry(&conn, &key, &a.id).unwrap_err();
        assert_eq!(err.code, ErrorCode::Crypto);
    }

    #[test]
    fn secret_history_ist_atomar_idempotent_und_unveraenderlich() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let entry = create_entry(&conn, &key, input("Original", 1234, "Erste Notiz")).unwrap();

        // Wenn der History-INSERT scheitert, darf auch archived_at nicht gesetzt
        // bleiben.
        conn.execute_batch(
            "CREATE TRIGGER fail_hidden_history
             BEFORE INSERT ON hidden_entry_history
             BEGIN SELECT RAISE(ABORT, 'test'); END;",
        )
        .unwrap();
        assert!(archive_entry(&conn, &key, &entry.id).is_err());
        assert!(get_entry(&conn, &key, &entry.id)
            .unwrap()
            .archived_at
            .is_none());
        conn.execute_batch("DROP TRIGGER fail_hidden_history;")
            .unwrap();

        let first_archived = archive_entry(&conn, &key, &entry.id).unwrap();
        let first = list_history(&conn, &key).unwrap().remove(0);
        let stored_before: (Vec<u8>, Vec<u8>) = conn
            .query_row(
                "SELECT encrypted_payload, nonce FROM hidden_entry_history
                 WHERE source_hidden_entry_id = ?1",
                [&entry.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        // Wiederholtes Archivieren ist vollständig idempotent.
        let second_archived = archive_entry(&conn, &key, &entry.id).unwrap();
        assert_eq!(second_archived.archived_at, first_archived.archived_at);
        assert_eq!(list_history(&conn, &key), Ok(vec![first.clone()]));
        let stored_after: (Vec<u8>, Vec<u8>) = conn
            .query_row(
                "SELECT encrypted_payload, nonce FROM hidden_entry_history
                 WHERE source_hidden_entry_id = ?1",
                [&entry.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored_after, stored_before);

        // Wiederherstellen, fachlich ändern und erneut archivieren darf den
        // ersten Snapshot nicht umschreiben.
        restore_entry(&conn, &key, &entry.id).unwrap();
        update_entry(
            &conn,
            &key,
            &entry.id,
            HiddenEntryPatch {
                name: Some("Neu".to_string()),
                amount_cents: Some(9999),
                note: Some("Zweite Notiz".to_string()),
            },
        )
        .unwrap();
        archive_entry(&conn, &key, &entry.id).unwrap();
        assert_eq!(list_history(&conn, &key).unwrap(), vec![first]);
    }

    #[test]
    fn secret_history_nutzt_frische_nonces_und_eigene_aad_domaene() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let a = create_entry(&conn, &key, input("Gleich", 500, "Gleich")).unwrap();
        let b = create_entry(&conn, &key, input("Gleich", 500, "Gleich")).unwrap();
        archive_entry(&conn, &key, &a.id).unwrap();
        archive_entry(&conn, &key, &b.id).unwrap();

        let history_nonces: Vec<Vec<u8>> = conn
            .prepare("SELECT nonce FROM hidden_entry_history ORDER BY source_hidden_entry_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(history_nonces.len(), 2);
        assert_ne!(history_nonces[0], history_nonces[1]);

        // Selbst Ciphertext+Nonce einer gültigen Bestandszeile funktionieren
        // wegen der getrennten AAD-Domäne nicht in der History-Tabelle.
        conn.execute(
            "UPDATE hidden_entry_history
             SET encrypted_payload = (SELECT encrypted_payload FROM hidden_entries WHERE id = ?1),
                 nonce = (SELECT nonce FROM hidden_entries WHERE id = ?1)
             WHERE source_hidden_entry_id = ?1",
            [&a.id],
        )
        .unwrap();
        let err = list_history(&conn, &key).unwrap_err();
        assert_eq!(err.code, ErrorCode::Crypto);
    }

    #[test]
    fn manipulierte_secret_history_wird_von_liste_und_integritaetspruefung_abgelehnt() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let entry = create_entry(&conn, &key, input(MARKER_NAME, 100, MARKER_NOTE)).unwrap();
        archive_entry(&conn, &key, &entry.id).unwrap();

        let mut blob: Vec<u8> = conn
            .query_row(
                "SELECT encrypted_payload FROM hidden_entry_history
                 WHERE source_hidden_entry_id = ?1",
                [&entry.id],
                |row| row.get(0),
            )
            .unwrap();
        blob[0] ^= 0x80;
        conn.execute(
            "UPDATE hidden_entry_history SET encrypted_payload = ?2
             WHERE source_hidden_entry_id = ?1",
            params![entry.id, blob],
        )
        .unwrap();

        let err = list_history(&conn, &key).unwrap_err();
        assert_eq!(err.code, ErrorCode::Crypto);
        let text = format!("{err} {err:?}");
        assert!(!text.contains(MARKER_NAME));
        assert!(!text.contains(MARKER_NOTE));
        assert!(verify_history(&conn, &key).is_err());
        assert!(verify_all(&conn, &key).is_err());
    }

    #[test]
    fn secret_history_metadaten_sind_durch_aad_gebunden() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let entry = create_entry(&conn, &key, input("A", 100, "")).unwrap();
        archive_entry(&conn, &key, &entry.id).unwrap();

        conn.execute(
            "UPDATE hidden_entry_history
             SET completed_at = '2099-01-01T00:00:00.000Z'
             WHERE source_hidden_entry_id = ?1",
            [&entry.id],
        )
        .unwrap();
        assert_eq!(
            list_history(&conn, &key).unwrap_err().code,
            ErrorCode::Crypto
        );
    }

    #[test]
    fn backfill_archivierter_altbestaende_ist_sicher_und_idempotent() {
        let conn = test_conn();
        let key = SecretKey::generate();
        let a = create_entry(&conn, &key, input("Alt A", 100, "Notiz A")).unwrap();
        let b = create_entry(&conn, &key, input("Alt B", 200, "Notiz B")).unwrap();
        let archived_at = "2024-01-02T03:04:05.000Z";
        conn.execute(
            "UPDATE hidden_entries
             SET archived_at = ?1, updated_at = ?1",
            [archived_at],
        )
        .unwrap();

        // Ein falscher Schlüssel darf keinen partiellen Backfill erzeugen.
        assert!(backfill_archived_history(&conn, &SecretKey::generate()).is_err());
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM hidden_entry_history", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(before, 0);

        assert_eq!(backfill_archived_history(&conn, &key).unwrap(), 2);
        assert_eq!(backfill_archived_history(&conn, &key).unwrap(), 0);
        let history = list_history(&conn, &key).unwrap();
        assert_eq!(history.len(), 2);
        assert!(history
            .iter()
            .any(|item| item.source_hidden_entry_id == a.id));
        assert!(history
            .iter()
            .any(|item| item.source_hidden_entry_id == b.id));
        assert!(history
            .iter()
            .all(|item| item.completed_or_archived_at == archived_at));
        assert_eq!(verify_entries(&conn, &key).unwrap(), 2);
        assert_eq!(verify_history(&conn, &key).unwrap(), 2);
        assert_eq!(verify_all(&conn, &key).unwrap(), 4);
    }

    #[test]
    fn fuenfhundert_verschluesselte_eintraege_bleiben_schnell_lesbar() {
        // Zielgröße aus den Abnahmekriterien: 500 verschlüsselte Einträge.
        let conn = test_conn();
        let key = SecretKey::generate();
        for index in 0..500 {
            create_entry(
                &conn,
                &key,
                input(&format!("Eintrag {index}"), 100 + index as i64, ""),
            )
            .unwrap();
        }

        let start = std::time::Instant::now();
        assert_eq!(list_entries(&conn, &key).unwrap().len(), 500);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(1),
            "Entschlüsseltes Auflisten dauert zu lange: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn falscher_schluessel_liest_nichts() {
        let conn = test_conn();
        let key = SecretKey::generate();
        create_entry(&conn, &key, input("A", 100, "")).unwrap();

        let wrong = SecretKey::generate();
        assert!(list_entries(&conn, &wrong).is_err());
        assert!(verify_all(&conn, &wrong).is_err());
    }
}
