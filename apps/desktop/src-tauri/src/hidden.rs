use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::crypto::{self, SecretKey, ENCRYPTION_VERSION};
use crate::db;
use crate::error::ApiError;
use crate::models::{HiddenEntry, HiddenEntryPatch, NewHiddenEntry};

/// Fachlicher Inhalt eines versteckten Eintrags. Wird als Ganzes serialisiert
/// und verschlüsselt – einzelne Felder landen nie im Klartext in SQLite.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HiddenPayload {
    name: String,
    amount_cents: i64,
    note: String,
}

/// Bindet Ciphertext an Eintrags-ID und Formatversion. Verhindert, dass
/// verschlüsselte Payloads zwischen Zeilen vertauscht werden können.
fn aad_for(id: &str, version: i64) -> Vec<u8> {
    format!("werkstatt-hidden:{id}:{version}").into_bytes()
}

fn validate(name: &str, amount_cents: i64) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::validation("name", "Bezeichnung darf nicht leer sein"));
    }
    if amount_cents <= 0 {
        return Err(ApiError::validation("amountCents", "Betrag muss größer als 0 sein"));
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

struct EncryptedRow {
    id: String,
    encrypted_payload: Vec<u8>,
    nonce: Vec<u8>,
    encryption_version: i64,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
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

fn get_row(conn: &Connection, id: &str) -> Result<EncryptedRow, ApiError> {
    conn.query_row("SELECT * FROM hidden_entries WHERE id = ?1", [id], row_from_db)
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => ApiError::not_found("Eintrag nicht gefunden"),
            other => other.into(),
        })
}

pub fn get_entry(conn: &Connection, key: &SecretKey, id: &str) -> Result<HiddenEntry, ApiError> {
    decrypt_row(key, get_row(conn, id)?)
}

/// Anzahl aller versteckten Einträge inklusive archivierter. Dient als
/// „es existieren verschlüsselte Daten“-Signal für die Schlüsselverwaltung.
pub fn count_entries(conn: &Connection) -> Result<i64, ApiError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM hidden_entries", [], |row| row.get(0))?)
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

/// Entschlüsselt jede Zeile inklusive archivierter und prüft damit die
/// Integrität des gesamten Bestands (z. B. bei der Backup-Validierung).
pub fn verify_all(conn: &Connection, key: &SecretKey) -> Result<i64, ApiError> {
    let mut stmt = conn.prepare("SELECT * FROM hidden_entries")?;
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

pub fn archive_entry(conn: &Connection, key: &SecretKey, id: &str) -> Result<HiddenEntry, ApiError> {
    let timestamp = db::now(conn)?;
    let changed = conn.execute(
        "UPDATE hidden_entries SET archived_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, timestamp],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found("Eintrag nicht gefunden"));
    }
    get_entry(conn, key, id)
}

pub fn restore_entry(conn: &Connection, key: &SecretKey, id: &str) -> Result<HiddenEntry, ApiError> {
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
        // Archivierte zählen weiterhin als verschlüsselte Daten.
        assert_eq!(count_entries(&conn).unwrap(), 1);

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
    fn falscher_schluessel_liest_nichts() {
        let conn = test_conn();
        let key = SecretKey::generate();
        create_entry(&conn, &key, input("A", 100, "")).unwrap();

        let wrong = SecretKey::generate();
        assert!(list_entries(&conn, &wrong).is_err());
        assert!(verify_all(&conn, &wrong).is_err());
    }
}
