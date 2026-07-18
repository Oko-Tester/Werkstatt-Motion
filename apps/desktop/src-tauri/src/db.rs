use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::error::ApiError;
use crate::models::{
    CustomerSuggestion, NewPayment, NewVehicle, Payment, PaymentPatch, UiPreferences, Vehicle,
    VehicleHistory, VehiclePatch, VehicleStatusField,
};

/// Versionierte Migrationen. Der Index + 1 entspricht der Zielversion in
/// PRAGMA user_version. Bestehende Einträge dürfen nie verändert werden –
/// Schemaänderungen bekommen einen neuen Eintrag am Ende.
const MIGRATIONS: &[&str] = &[
    // Version 1: Grundschema für Fahrzeuge und offene Zahlungen.
    "CREATE TABLE vehicles (
        id            TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        vehicle_name  TEXT NOT NULL DEFAULT '',
        license_plate TEXT NOT NULL DEFAULT '',
        tuv_required  INTEGER NOT NULL DEFAULT 0,
        parts_ordered INTEGER NOT NULL DEFAULT 0,
        parts_arrived INTEGER NOT NULL DEFAULT 0,
        is_done       INTEGER NOT NULL DEFAULT 0,
        position      INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        archived_at   TEXT
    );
    CREATE INDEX idx_vehicles_active ON vehicles (archived_at, position);
    CREATE TABLE payments (
        id            TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        amount_cents  INTEGER NOT NULL,
        note          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        paid_at       TEXT,
        archived_at   TEXT
    );
    CREATE INDEX idx_payments_open ON payments (paid_at, archived_at, created_at);",
    // Version 2: Versteckte Einträge. Fachliche Inhalte (Bezeichnung, Betrag,
    // Notiz) liegen ausschließlich als verschlüsselter Payload vor – es gibt
    // bewusst keine Klartextspalten dafür.
    "CREATE TABLE hidden_entries (
        id                 TEXT PRIMARY KEY,
        encrypted_payload  BLOB NOT NULL,
        nonce              BLOB NOT NULL,
        encryption_version INTEGER NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        archived_at        TEXT
    );
    CREATE INDEX idx_hidden_entries_active ON hidden_entries (archived_at, created_at);",
    // Version 3: Stabile, einmalige Fahrzeug-Snapshots. Die UNIQUE-Bindung an
    // die Quell-ID macht den Abschluss auch bei Wiederholung idempotent.
    "CREATE TABLE vehicle_history (
        id                  TEXT PRIMARY KEY,
        source_vehicle_id   TEXT NOT NULL UNIQUE,
        customer_name       TEXT NOT NULL,
        vehicle_name        TEXT NOT NULL DEFAULT '',
        license_plate       TEXT NOT NULL DEFAULT '',
        tuv_required        INTEGER NOT NULL,
        parts_ordered       INTEGER NOT NULL,
        parts_arrived       INTEGER NOT NULL,
        is_done             INTEGER NOT NULL,
        completed_at        TEXT NOT NULL,
        archived_at         TEXT,
        vehicle_created_at  TEXT NOT NULL,
        snapshot_created_at TEXT NOT NULL
    );
    CREATE INDEX idx_vehicle_history_completed
        ON vehicle_history (completed_at DESC, snapshot_created_at DESC, id ASC);
    INSERT OR IGNORE INTO vehicle_history (
        id, source_vehicle_id, customer_name, vehicle_name, license_plate,
        tuv_required, parts_ordered, parts_arrived, is_done, completed_at,
        archived_at, vehicle_created_at, snapshot_created_at
    )
    SELECT lower(hex(randomblob(16))), id, customer_name, vehicle_name, license_plate,
           tuv_required, parts_ordered, parts_arrived, is_done, updated_at,
           archived_at, created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM vehicles WHERE is_done = 1;",
    // Version 4: Historie versteckter Einträge ohne Klartextspalten. Der
    // verschlüsselte Backfill erfolgt erst, sobald der Vault-Key verfügbar ist.
    "CREATE TABLE hidden_entry_history (
        id                     TEXT PRIMARY KEY,
        source_hidden_entry_id TEXT NOT NULL UNIQUE,
        encrypted_payload      BLOB NOT NULL,
        nonce                  BLOB NOT NULL,
        encryption_version     INTEGER NOT NULL,
        completed_at           TEXT NOT NULL,
        created_at             TEXT NOT NULL
    );
    CREATE INDEX idx_hidden_entry_history_completed
        ON hidden_entry_history (completed_at DESC, created_at DESC, id ASC);",
    // Version 5: Versionierte, typisierte UI-Präferenzen als Singleton.
    "CREATE TABLE ui_preferences (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        version                  INTEGER NOT NULL,
        payments_panel_collapsed INTEGER NOT NULL DEFAULT 0,
        vehicle_column_order     TEXT NOT NULL
    );
    INSERT INTO ui_preferences
        (id, version, payments_panel_collapsed, vehicle_column_order)
    VALUES
        (1, 1, 0, '[\"customerName\",\"vehicleName\",\"licensePlate\",\"tuvRequired\",\"partsOrdered\",\"partsArrived\",\"isDone\"]');",
    // Version 6: Vom Nutzer verstellbare Höhe des Zahlungsbereichs.
    "ALTER TABLE ui_preferences
        ADD COLUMN payments_panel_height INTEGER NOT NULL DEFAULT 240;
     UPDATE ui_preferences SET version = 2 WHERE id = 1;",
    // Version 7: Ausblendbare Fahrzeugspalten.
    "ALTER TABLE ui_preferences
        ADD COLUMN vehicle_hidden_columns TEXT NOT NULL DEFAULT '[]';
     UPDATE ui_preferences SET version = 3 WHERE id = 1;",
    // Version 8: Frei bearbeitbare Notiz je Fahrzeug und im unveränderlichen Snapshot.
    "ALTER TABLE vehicles ADD COLUMN note TEXT NOT NULL DEFAULT '';
     ALTER TABLE vehicle_history ADD COLUMN note TEXT NOT NULL DEFAULT '';",
];

/// Öffnet (oder erzeugt) die Datenbankdatei, setzt die Pragmas und führt die
/// Migrationen aus. Liefert bei jedem Scheitern eine verständliche Meldung –
/// der Aufrufer entscheidet, wie er ohne Datenbank weiterläuft.
pub fn open(path: &std::path::Path) -> Result<Connection, ApiError> {
    let mut conn = Connection::open(path)
        .map_err(|_| ApiError::database("Die Datenbank konnte nicht geöffnet werden"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .and_then(|()| conn.pragma_update(None, "foreign_keys", "ON"))
        .map_err(|_| ApiError::database("Die Datenbank konnte nicht geöffnet werden"))?;
    migrate(&mut conn).map_err(|_| {
        ApiError::database("Die Datenbank konnte nicht auf den neuesten Stand gebracht werden")
    })?;
    Ok(conn)
}

/// Bringt die Datenbank auf die aktuelle Schemaversion. Läuft in einer
/// Transaktion und ist beliebig oft aufrufbar.
pub fn migrate(conn: &mut Connection) -> Result<(), ApiError> {
    let tx = conn.transaction()?;
    let mut version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    while (version as usize) < MIGRATIONS.len() {
        tx.execute_batch(MIGRATIONS[version as usize])?;
        version += 1;
    }
    tx.pragma_update(None, "user_version", version)?;
    tx.commit()?;
    Ok(())
}

pub fn schema_version(conn: &Connection) -> Result<i64, ApiError> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

/// Aktuelle Schemaversion des Codes (Zielversion der Migrationen).
pub fn current_schema_version() -> i64 {
    MIGRATIONS.len() as i64
}

pub fn now(conn: &Connection) -> Result<String, ApiError> {
    Ok(
        conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })?,
    )
}

/// Kennzeichen normalisieren: Großschreibung, überflüssige Leerzeichen entfernen.
pub fn normalize_license_plate(input: &str) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase()
}

fn validate_vehicle_text(
    customer_name: &str,
    vehicle_name: &str,
    license_plate: &str,
) -> Result<(), ApiError> {
    if customer_name.trim().is_empty() {
        return Err(ApiError::validation(
            "customerName",
            "Kunde darf nicht leer sein",
        ));
    }
    if vehicle_name.trim().is_empty() && license_plate.trim().is_empty() {
        return Err(ApiError::validation(
            "vehicleName",
            "Fahrzeug oder Kennzeichen angeben",
        ));
    }
    Ok(())
}

fn validate_payment_values(customer_name: &str, amount_cents: i64) -> Result<(), ApiError> {
    if customer_name.trim().is_empty() {
        return Err(ApiError::validation(
            "customerName",
            "Kunde darf nicht leer sein",
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

fn vehicle_from_row(row: &Row<'_>) -> rusqlite::Result<Vehicle> {
    Ok(Vehicle {
        id: row.get("id")?,
        customer_name: row.get("customer_name")?,
        vehicle_name: row.get("vehicle_name")?,
        license_plate: row.get("license_plate")?,
        note: row.get("note")?,
        tuv_required: row.get("tuv_required")?,
        parts_ordered: row.get("parts_ordered")?,
        parts_arrived: row.get("parts_arrived")?,
        is_done: row.get("is_done")?,
        position: row.get("position")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        archived_at: row.get("archived_at")?,
    })
}

fn payment_from_row(row: &Row<'_>) -> rusqlite::Result<Payment> {
    Ok(Payment {
        id: row.get("id")?,
        customer_name: row.get("customer_name")?,
        amount_cents: row.get("amount_cents")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        paid_at: row.get("paid_at")?,
        archived_at: row.get("archived_at")?,
    })
}

fn vehicle_history_from_row(row: &Row<'_>) -> rusqlite::Result<VehicleHistory> {
    Ok(VehicleHistory {
        id: row.get("id")?,
        source_vehicle_id: row.get("source_vehicle_id")?,
        customer_name: row.get("customer_name")?,
        vehicle_name: row.get("vehicle_name")?,
        license_plate: row.get("license_plate")?,
        note: row.get("note")?,
        tuv_required: row.get("tuv_required")?,
        parts_ordered: row.get("parts_ordered")?,
        parts_arrived: row.get("parts_arrived")?,
        is_done: row.get("is_done")?,
        completed_at: row.get("completed_at")?,
        archived_at: row.get("archived_at")?,
        vehicle_created_at: row.get("vehicle_created_at")?,
        snapshot_created_at: row.get("snapshot_created_at")?,
    })
}

// ---------- Fahrzeuge ----------

pub fn get_vehicle(conn: &Connection, id: &str) -> Result<Vehicle, ApiError> {
    conn.query_row(
        "SELECT * FROM vehicles WHERE id = ?1",
        [id],
        vehicle_from_row,
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => ApiError::not_found("Fahrzeug nicht gefunden"),
        other => other.into(),
    })
}

/// Aktive Fahrzeuge, oberste Priorität zuerst (kleinste Position).
pub fn list_vehicles(conn: &Connection) -> Result<Vec<Vehicle>, ApiError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vehicles WHERE archived_at IS NULL
         ORDER BY position ASC, created_at ASC, id ASC",
    )?;
    let vehicles = stmt
        .query_map([], vehicle_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(vehicles)
}

/// Legt ein Fahrzeug an. Neue Fahrzeuge kommen ans Ende der Liste. Ein
/// bereits abgeschlossen angelegtes Fahrzeug erhält im selben Commit seinen
/// unveränderlichen History-Snapshot.
pub fn create_vehicle(conn: &Connection, input: NewVehicle) -> Result<Vehicle, ApiError> {
    let customer_name = input.customer_name.trim().to_string();
    let vehicle_name = input.vehicle_name.trim().to_string();
    let license_plate = normalize_license_plate(&input.license_plate);
    let note = input.note.trim().to_string();
    validate_vehicle_text(&customer_name, &vehicle_name, &license_plate)?;

    let id = Uuid::new_v4().to_string();
    let tx = conn.unchecked_transaction()?;
    let timestamp = now(&tx)?;
    tx.execute(
        "INSERT INTO vehicles (
            id, customer_name, vehicle_name, license_plate, note,
            tuv_required, parts_ordered, parts_arrived, is_done,
            position, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            (SELECT COALESCE(MAX(position), -1) + 1 FROM vehicles), ?10, ?10
         )",
        params![
            id,
            customer_name,
            vehicle_name,
            license_plate,
            note,
            input.tuv_required,
            input.parts_ordered,
            input.parts_arrived,
            input.is_done,
            timestamp,
        ],
    )?;
    if input.is_done {
        insert_vehicle_history_snapshot(&tx, &id, &timestamp)?;
    }
    tx.commit()?;
    get_vehicle(conn, &id)
}

/// Aktualisiert die Textfelder eines Fahrzeugs (Teil-Patch).
pub fn update_vehicle(
    conn: &Connection,
    id: &str,
    patch: VehiclePatch,
) -> Result<Vehicle, ApiError> {
    let current = get_vehicle(conn, id)?;
    let customer_name = patch
        .customer_name
        .map(|value| value.trim().to_string())
        .unwrap_or(current.customer_name);
    let vehicle_name = patch
        .vehicle_name
        .map(|value| value.trim().to_string())
        .unwrap_or(current.vehicle_name);
    let license_plate = patch
        .license_plate
        .map(|value| normalize_license_plate(&value))
        .unwrap_or(current.license_plate);
    let note = patch
        .note
        .map(|value| value.trim().to_string())
        .unwrap_or(current.note);
    validate_vehicle_text(&customer_name, &vehicle_name, &license_plate)?;

    let timestamp = now(conn)?;
    conn.execute(
        "UPDATE vehicles
         SET customer_name = ?2, vehicle_name = ?3, license_plate = ?4, note = ?5, updated_at = ?6
         WHERE id = ?1",
        params![id, customer_name, vehicle_name, license_plate, note, timestamp],
    )?;
    get_vehicle(conn, id)
}

fn get_vehicle_history_by_source(
    conn: &Connection,
    source_vehicle_id: &str,
) -> Result<Option<VehicleHistory>, ApiError> {
    Ok(conn
        .query_row(
            "SELECT * FROM vehicle_history WHERE source_vehicle_id = ?1",
            [source_vehicle_id],
            vehicle_history_from_row,
        )
        .optional()?)
}

/// Fügt den Snapshot nur dann ein, wenn er noch nicht existiert. Die Prüfung
/// und der INSERT laufen in derselben Transaktion wie der Statuswechsel.
fn insert_vehicle_history_snapshot(
    conn: &Connection,
    source_vehicle_id: &str,
    timestamp: &str,
) -> Result<(), ApiError> {
    if get_vehicle_history_by_source(conn, source_vehicle_id)?.is_some() {
        return Ok(());
    }
    let vehicle = get_vehicle(conn, source_vehicle_id)?;
    if !vehicle.is_done {
        return Err(ApiError::validation(
            "isDone",
            "Nur abgeschlossene Fahrzeuge können in die Historie übernommen werden",
        ));
    }

    conn.execute(
        "INSERT OR IGNORE INTO vehicle_history (
            id, source_vehicle_id, customer_name, vehicle_name, license_plate, note,
            tuv_required, parts_ordered, parts_arrived, is_done, completed_at,
            archived_at, vehicle_created_at, snapshot_created_at
         )
         SELECT ?1, id, customer_name, vehicle_name, license_plate, note,
                tuv_required, parts_ordered, parts_arrived, is_done, ?3,
                archived_at, created_at, ?3
         FROM vehicles WHERE id = ?2",
        params![Uuid::new_v4().to_string(), source_vehicle_id, timestamp],
    )?;
    Ok(())
}

/// Erzeugt explizit einen idempotenten History-Snapshot. Ein unbekanntes oder
/// noch nicht abgeschlossenes Fahrzeug wird backendseitig abgelehnt.
pub fn create_vehicle_history_snapshot(
    conn: &Connection,
    source_vehicle_id: &str,
) -> Result<VehicleHistory, ApiError> {
    let tx = conn.unchecked_transaction()?;
    let timestamp = now(&tx)?;
    insert_vehicle_history_snapshot(&tx, source_vehicle_id, &timestamp)?;
    let history = get_vehicle_history_by_source(&tx, source_vehicle_id)?
        .ok_or_else(|| ApiError::database("Fahrzeughistorie konnte nicht erstellt werden"))?;
    tx.commit()?;
    Ok(history)
}

/// Abgeschlossene Fahrzeuge, jüngster Abschluss zuerst.
pub fn list_completed_vehicle_history(conn: &Connection) -> Result<Vec<VehicleHistory>, ApiError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM vehicle_history
         ORDER BY completed_at DESC, snapshot_created_at DESC, id ASC",
    )?;
    let history = stmt
        .query_map([], vehicle_history_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(history)
}

/// Schaltet genau ein Statusfeld um. Andere Status bleiben unberührt. Beim
/// Setzen von `is_done` wird atomar ein einmaliger Snapshot angelegt.
pub fn update_vehicle_status(
    conn: &Connection,
    id: &str,
    field: VehicleStatusField,
    value: bool,
) -> Result<Vehicle, ApiError> {
    let tx = conn.unchecked_transaction()?;
    let timestamp = now(&tx)?;
    let changed = tx.execute(
        &format!(
            "UPDATE vehicles SET {} = ?2, updated_at = ?3 WHERE id = ?1",
            field.column()
        ),
        params![id, value, timestamp],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found("Fahrzeug nicht gefunden"));
    }
    if field == VehicleStatusField::IsDone && value {
        insert_vehicle_history_snapshot(&tx, id, &timestamp)?;
    }
    tx.commit()?;
    get_vehicle(conn, id)
}

/// Speichert die per Drag-and-drop festgelegte Reihenfolge.
/// Die Position entspricht dem Index in der übergebenen Liste.
pub fn reorder_vehicles(conn: &mut Connection, ids: &[String]) -> Result<Vec<Vehicle>, ApiError> {
    let tx = conn.transaction()?;
    let timestamp: String =
        tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })?;
    for (index, id) in ids.iter().enumerate() {
        let changed = tx.execute(
            "UPDATE vehicles SET position = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, index as i64, timestamp],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found("Fahrzeug nicht gefunden"));
        }
    }
    tx.commit()?;
    list_vehicles(conn)
}

pub fn archive_vehicle(conn: &Connection, id: &str) -> Result<Vehicle, ApiError> {
    let tx = conn.unchecked_transaction()?;
    let current = get_vehicle(&tx, id)?;
    let archived_at = match current.archived_at {
        Some(value) => value,
        None => {
            let timestamp = now(&tx)?;
            tx.execute(
                "UPDATE vehicles
                 SET archived_at = ?2, updated_at = ?2
                 WHERE id = ?1 AND archived_at IS NULL",
                params![id, timestamp],
            )?;
            timestamp
        }
    };
    tx.execute(
        "UPDATE vehicle_history
         SET archived_at = COALESCE(archived_at, ?2)
         WHERE source_vehicle_id = ?1",
        params![id, archived_at],
    )?;
    tx.commit()?;
    get_vehicle(conn, id)
}

pub fn restore_vehicle(conn: &Connection, id: &str) -> Result<Vehicle, ApiError> {
    let timestamp = now(conn)?;
    let changed = conn.execute(
        "UPDATE vehicles SET archived_at = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, timestamp],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found("Fahrzeug nicht gefunden"));
    }
    get_vehicle(conn, id)
}

// ---------- Kundenvorschläge ----------

/// Führt identische Kundennamen (ohne Beachtung der Groß-/Kleinschreibung)
/// zusammen und behält den Kontext der zuletzt verwendeten Fahrzeugzeile.
pub fn list_customer_suggestions(conn: &Connection) -> Result<Vec<CustomerSuggestion>, ApiError> {
    let mut stmt = conn.prepare(
        "SELECT id, customer_name, vehicle_name, license_plate,
                COALESCE(archived_at, updated_at, created_at) AS last_used_at
         FROM vehicles
         WHERE trim(customer_name) <> ''
         UNION ALL
         SELECT source_vehicle_id AS id, customer_name, vehicle_name, license_plate,
                completed_at AS last_used_at
         FROM vehicle_history
         WHERE trim(customer_name) <> ''",
    )?;
    let candidates = stmt
        .query_map([], |row| {
            let vehicle_name: String = row.get("vehicle_name")?;
            let license_plate: String = row.get("license_plate")?;
            Ok(CustomerSuggestion {
                id: row.get("id")?,
                customer_name: row.get::<_, String>("customer_name")?.trim().to_string(),
                vehicle_name: (!vehicle_name.trim().is_empty())
                    .then(|| vehicle_name.trim().to_string()),
                license_plate: (!license_plate.trim().is_empty())
                    .then(|| license_plate.trim().to_string()),
                last_used_at: row.get("last_used_at")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut merged = std::collections::HashMap::<String, CustomerSuggestion>::new();
    for candidate in candidates {
        let key = candidate.customer_name.to_lowercase();
        let replace = merged
            .get(&key)
            .map(|current| {
                candidate.last_used_at > current.last_used_at
                    || (candidate.last_used_at == current.last_used_at && candidate.id > current.id)
            })
            .unwrap_or(true);
        if replace {
            merged.insert(key, candidate);
        }
    }
    let mut suggestions: Vec<_> = merged.into_values().collect();
    suggestions.sort_by(|a, b| {
        b.last_used_at
            .cmp(&a.last_used_at)
            .then_with(|| a.customer_name.cmp(&b.customer_name))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(suggestions)
}

// ---------- UI-Präferenzen ----------

pub const VEHICLE_COLUMN_ORDER_DEFAULT: [&str; 8] = [
    "customerName",
    "vehicleName",
    "licensePlate",
    "tuvRequired",
    "partsOrdered",
    "partsArrived",
    "isDone",
    "note",
];
const UI_PREFERENCES_VERSION: i64 = 3;
const DEFAULT_PAYMENTS_PANEL_HEIGHT: i64 = 240;
const MIN_PAYMENTS_PANEL_HEIGHT: i64 = 160;
const MAX_PAYMENTS_PANEL_HEIGHT: i64 = 1200;

fn default_vehicle_column_order() -> Vec<String> {
    VEHICLE_COLUMN_ORDER_DEFAULT
        .iter()
        .map(|id| (*id).to_string())
        .collect()
}

pub fn normalize_vehicle_column_order(column_order: &[String]) -> Vec<String> {
    let mut normalized = Vec::with_capacity(VEHICLE_COLUMN_ORDER_DEFAULT.len());
    for id in column_order {
        if VEHICLE_COLUMN_ORDER_DEFAULT.contains(&id.as_str()) && !normalized.contains(id) {
            normalized.push(id.clone());
        }
    }
    if normalized.is_empty() {
        return default_vehicle_column_order();
    }
    for id in VEHICLE_COLUMN_ORDER_DEFAULT {
        if !normalized.iter().any(|current| current == id) {
            normalized.push(id.to_string());
        }
    }
    normalized
}

pub fn normalize_vehicle_hidden_columns(
    hidden_columns: &[String],
    column_order: &[String],
) -> Vec<String> {
    let mut normalized = Vec::with_capacity(VEHICLE_COLUMN_ORDER_DEFAULT.len() - 1);
    for id in hidden_columns {
        if VEHICLE_COLUMN_ORDER_DEFAULT.contains(&id.as_str()) && !normalized.contains(id) {
            normalized.push(id.clone());
        }
    }
    if normalized.len() == VEHICLE_COLUMN_ORDER_DEFAULT.len() {
        let visible_fallback = column_order
            .first()
            .map(String::as_str)
            .unwrap_or(VEHICLE_COLUMN_ORDER_DEFAULT[0]);
        normalized.retain(|id| id != visible_fallback);
    }
    normalized
}

fn persist_ui_preferences(
    conn: &Connection,
    preferences: &UiPreferences,
) -> Result<UiPreferences, ApiError> {
    let order = serde_json::to_string(&preferences.vehicle_column_order).map_err(|_| {
        ApiError::database("Oberflächenpräferenzen konnten nicht gespeichert werden")
    })?;
    let hidden_columns =
        serde_json::to_string(&preferences.vehicle_hidden_columns).map_err(|_| {
            ApiError::database("Oberflächenpräferenzen konnten nicht gespeichert werden")
        })?;
    conn.execute(
        "INSERT INTO ui_preferences
            (id, version, payments_panel_collapsed, payments_panel_height,
             vehicle_column_order, vehicle_hidden_columns)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            version = excluded.version,
            payments_panel_collapsed = excluded.payments_panel_collapsed,
            payments_panel_height = excluded.payments_panel_height,
            vehicle_column_order = excluded.vehicle_column_order,
            vehicle_hidden_columns = excluded.vehicle_hidden_columns",
        params![
            UI_PREFERENCES_VERSION,
            preferences.payments_panel_collapsed,
            preferences.payments_panel_height,
            order,
            hidden_columns
        ],
    )?;
    Ok(preferences.clone())
}

pub fn get_ui_preferences(conn: &Connection) -> Result<UiPreferences, ApiError> {
    let stored = conn
        .query_row(
            "SELECT version, payments_panel_collapsed, payments_panel_height,
                    vehicle_column_order, vehicle_hidden_columns
             FROM ui_preferences WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;

    let preferences = match stored {
        Some((UI_PREFERENCES_VERSION, collapsed, height, order_json, hidden_json)) => {
            let parsed_order = serde_json::from_str::<Vec<String>>(&order_json).unwrap_or_default();
            let vehicle_column_order = normalize_vehicle_column_order(&parsed_order);
            let parsed_hidden =
                serde_json::from_str::<Vec<String>>(&hidden_json).unwrap_or_default();
            UiPreferences {
                payments_panel_collapsed: collapsed == 1,
                payments_panel_height: height
                    .clamp(MIN_PAYMENTS_PANEL_HEIGHT, MAX_PAYMENTS_PANEL_HEIGHT),
                vehicle_hidden_columns: normalize_vehicle_hidden_columns(
                    &parsed_hidden,
                    &vehicle_column_order,
                ),
                vehicle_column_order,
            }
        }
        _ => UiPreferences {
            payments_panel_collapsed: false,
            payments_panel_height: DEFAULT_PAYMENTS_PANEL_HEIGHT,
            vehicle_column_order: default_vehicle_column_order(),
            vehicle_hidden_columns: Vec::new(),
        },
    };
    persist_ui_preferences(conn, &preferences)
}

pub fn update_payments_panel_collapsed(
    conn: &Connection,
    collapsed: bool,
) -> Result<UiPreferences, ApiError> {
    let mut preferences = get_ui_preferences(conn)?;
    preferences.payments_panel_collapsed = collapsed;
    persist_ui_preferences(conn, &preferences)
}

pub fn update_payments_panel_height(
    conn: &Connection,
    height: i64,
) -> Result<UiPreferences, ApiError> {
    let mut preferences = get_ui_preferences(conn)?;
    preferences.payments_panel_height =
        height.clamp(MIN_PAYMENTS_PANEL_HEIGHT, MAX_PAYMENTS_PANEL_HEIGHT);
    persist_ui_preferences(conn, &preferences)
}

pub fn update_vehicle_column_order(
    conn: &Connection,
    column_order: &[String],
) -> Result<UiPreferences, ApiError> {
    let mut preferences = get_ui_preferences(conn)?;
    preferences.vehicle_column_order = normalize_vehicle_column_order(column_order);
    persist_ui_preferences(conn, &preferences)
}

pub fn update_vehicle_hidden_columns(
    conn: &Connection,
    hidden_columns: &[String],
) -> Result<UiPreferences, ApiError> {
    let mut preferences = get_ui_preferences(conn)?;
    preferences.vehicle_hidden_columns =
        normalize_vehicle_hidden_columns(hidden_columns, &preferences.vehicle_column_order);
    persist_ui_preferences(conn, &preferences)
}

// ---------- Zahlungen ----------

pub fn get_payment(conn: &Connection, id: &str) -> Result<Payment, ApiError> {
    conn.query_row(
        "SELECT * FROM payments WHERE id = ?1",
        [id],
        payment_from_row,
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => ApiError::not_found("Zahlung nicht gefunden"),
        other => other.into(),
    })
}

/// Offene Zahlungen: weder bezahlt noch archiviert, älteste zuerst.
pub fn list_open_payments(conn: &Connection) -> Result<Vec<Payment>, ApiError> {
    let mut stmt = conn.prepare(
        "SELECT * FROM payments WHERE paid_at IS NULL AND archived_at IS NULL
         ORDER BY created_at ASC, id ASC",
    )?;
    let payments = stmt
        .query_map([], payment_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(payments)
}

pub fn create_payment(conn: &Connection, input: NewPayment) -> Result<Payment, ApiError> {
    let customer_name = input.customer_name.trim().to_string();
    let note = input.note.trim().to_string();
    validate_payment_values(&customer_name, input.amount_cents)?;

    let id = Uuid::new_v4().to_string();
    let timestamp = now(conn)?;
    conn.execute(
        "INSERT INTO payments (id, customer_name, amount_cents, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, customer_name, input.amount_cents, note, timestamp],
    )?;
    get_payment(conn, &id)
}

pub fn update_payment(
    conn: &Connection,
    id: &str,
    patch: PaymentPatch,
) -> Result<Payment, ApiError> {
    let current = get_payment(conn, id)?;
    let customer_name = patch
        .customer_name
        .map(|value| value.trim().to_string())
        .unwrap_or(current.customer_name);
    let amount_cents = patch.amount_cents.unwrap_or(current.amount_cents);
    let note = patch
        .note
        .map(|value| value.trim().to_string())
        .unwrap_or(current.note);
    validate_payment_values(&customer_name, amount_cents)?;

    let timestamp = now(conn)?;
    conn.execute(
        "UPDATE payments
         SET customer_name = ?2, amount_cents = ?3, note = ?4, updated_at = ?5
         WHERE id = ?1",
        params![id, customer_name, amount_cents, note, timestamp],
    )?;
    get_payment(conn, id)
}

pub fn mark_payment_paid(conn: &Connection, id: &str) -> Result<Payment, ApiError> {
    let timestamp = now(conn)?;
    let changed = conn.execute(
        "UPDATE payments SET paid_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, timestamp],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found("Zahlung nicht gefunden"));
    }
    get_payment(conn, id)
}

/// Macht „Bezahlt“ rückgängig – die Zahlung ist danach wieder offen.
pub fn restore_payment(conn: &Connection, id: &str) -> Result<Payment, ApiError> {
    let timestamp = now(conn)?;
    let changed = conn.execute(
        "UPDATE payments SET paid_at = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, timestamp],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found("Zahlung nicht gefunden"));
    }
    get_payment(conn, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("In-Memory-Datenbank");
        migrate(&mut conn).expect("Migration");
        conn
    }

    fn vehicle_input(customer: &str, vehicle: &str, plate: &str) -> NewVehicle {
        NewVehicle {
            customer_name: customer.to_string(),
            vehicle_name: vehicle.to_string(),
            license_plate: plate.to_string(),
            ..NewVehicle::default()
        }
    }

    #[test]
    fn migration_erzeugt_schema_und_ist_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);

        // Zweiter Lauf darf nichts kaputt machen.
        migrate(&mut conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(tables.contains(&"vehicles".to_string()));
        assert!(tables.contains(&"payments".to_string()));
        assert!(tables.contains(&"hidden_entries".to_string()));
        assert!(tables.contains(&"vehicle_history".to_string()));
        assert!(tables.contains(&"hidden_entry_history".to_string()));
        assert!(tables.contains(&"ui_preferences".to_string()));
    }

    #[test]
    fn migration_uebernimmt_bereits_abgeschlossene_fahrzeuge_einmalig() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute_batch(MIGRATIONS[1]).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "INSERT INTO vehicles (
                id, customer_name, vehicle_name, license_plate,
                tuv_required, parts_ordered, parts_arrived, is_done,
                position, created_at, updated_at, archived_at
             ) VALUES (
                'alt-fertig', 'Alt', 'Golf', 'M-A 1',
                1, 1, 1, 1, 0,
                '2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z',
                '2024-03-01T00:00:00.000Z'
             )",
            [],
        )
        .unwrap();

        migrate(&mut conn).unwrap();
        let rows = list_completed_vehicle_history(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_vehicle_id, "alt-fertig");
        assert_eq!(rows[0].completed_at, "2024-02-01T00:00:00.000Z");
        assert_eq!(
            rows[0].archived_at.as_deref(),
            Some("2024-03-01T00:00:00.000Z")
        );
        migrate(&mut conn).unwrap();
        assert_eq!(list_completed_vehicle_history(&conn).unwrap().len(), 1);
    }

    #[test]
    fn fahrzeug_anlegen_normalisiert_und_validiert() {
        let conn = test_conn();
        let vehicle = create_vehicle(
            &conn,
            vehicle_input("  Müller, Anna ", " VW Golf ", "  m  ab 1234 "),
        )
        .unwrap();
        assert_eq!(vehicle.customer_name, "Müller, Anna");
        assert_eq!(vehicle.vehicle_name, "VW Golf");
        assert_eq!(vehicle.license_plate, "M AB 1234");
        assert!(!vehicle.is_done);
        assert!(vehicle.archived_at.is_none());

        let err = create_vehicle(&conn, vehicle_input("", "VW Golf", "")).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(err.field.as_deref(), Some("customerName"));

        let err = create_vehicle(&conn, vehicle_input("Müller", "", "  ")).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(err.field.as_deref(), Some("vehicleName"));

        // Kennzeichen allein genügt als Fahrzeugangabe.
        let vehicle = create_vehicle(&conn, vehicle_input("Huber", "", "ro-fh 356")).unwrap();
        assert_eq!(vehicle.license_plate, "RO-FH 356");
    }

    #[test]
    fn neues_fahrzeug_steht_unten() {
        let conn = test_conn();
        let first = create_vehicle(&conn, vehicle_input("Erster", "Golf", "")).unwrap();
        let second = create_vehicle(&conn, vehicle_input("Zweiter", "Passat", "")).unwrap();
        let list = list_vehicles(&conn).unwrap();
        assert_eq!(
            list.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str()],
        );
        assert!(second.position > first.position);
    }

    #[test]
    fn fahrzeug_texte_aktualisieren() {
        let conn = test_conn();
        let vehicle = create_vehicle(&conn, vehicle_input("Alt", "Golf", "m-ab 1")).unwrap();

        let updated = update_vehicle(
            &conn,
            &vehicle.id,
            VehiclePatch {
                customer_name: Some("Neu".to_string()),
                license_plate: Some(" eb e- x  9 ".to_string()),
                ..VehiclePatch::default()
            },
        )
        .unwrap();
        assert_eq!(updated.customer_name, "Neu");
        assert_eq!(updated.vehicle_name, "Golf");
        assert_eq!(updated.license_plate, "EB E- X 9");

        // Leerer Kunde wird abgelehnt, der alte Wert bleibt erhalten.
        let err = update_vehicle(
            &conn,
            &vehicle.id,
            VehiclePatch {
                customer_name: Some("   ".to_string()),
                ..VehiclePatch::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(
            get_vehicle(&conn, &vehicle.id).unwrap().customer_name,
            "Neu"
        );

        let err = update_vehicle(&conn, "fehlt", VehiclePatch::default()).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn status_umschalten_ohne_nebenwirkungen() {
        let conn = test_conn();
        let vehicle = create_vehicle(&conn, vehicle_input("Kunde", "Golf", "")).unwrap();

        let updated =
            update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::PartsArrived, true)
                .unwrap();
        assert!(updated.parts_arrived);
        // „Teile angekommen“ darf andere Status nicht ungefragt ändern.
        assert!(!updated.parts_ordered);
        assert!(!updated.tuv_required);
        assert!(!updated.is_done);

        let updated =
            update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::IsDone, true).unwrap();
        assert!(updated.is_done);
        assert!(updated.parts_arrived);

        let updated =
            update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::PartsArrived, false)
                .unwrap();
        assert!(!updated.parts_arrived);
        assert!(updated.is_done);

        let err =
            update_vehicle_status(&conn, "fehlt", VehicleStatusField::IsDone, true).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn reihenfolge_wird_gespeichert() {
        let mut conn = test_conn();
        let a = create_vehicle(&conn, vehicle_input("A", "Golf", "")).unwrap();
        let b = create_vehicle(&conn, vehicle_input("B", "Passat", "")).unwrap();
        let c = create_vehicle(&conn, vehicle_input("C", "Corsa", "")).unwrap();

        // Aktuelle Reihenfolge: c, b, a – neu: a, c, b.
        let order = vec![a.id.clone(), c.id.clone(), b.id.clone()];
        let list = reorder_vehicles(&mut conn, &order).unwrap();
        assert_eq!(
            list.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            vec![a.id.as_str(), c.id.as_str(), b.id.as_str()],
        );
        assert_eq!(list[0].position, 0);
        assert_eq!(list[2].position, 2);

        // Unbekannte ID: Fehler, ursprüngliche Reihenfolge bleibt erhalten.
        let err =
            reorder_vehicles(&mut conn, &vec![b.id.clone(), "fehlt".to_string()]).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let list = list_vehicles(&conn).unwrap();
        assert_eq!(
            list.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            vec![a.id.as_str(), c.id.as_str(), b.id.as_str()],
        );
    }

    #[test]
    fn archivieren_und_wiederherstellen() {
        let conn = test_conn();
        let vehicle = create_vehicle(&conn, vehicle_input("Kunde", "Golf", "")).unwrap();

        let archived = archive_vehicle(&conn, &vehicle.id).unwrap();
        assert!(archived.archived_at.is_some());
        assert!(list_vehicles(&conn).unwrap().is_empty());

        let restored = restore_vehicle(&conn, &vehicle.id).unwrap();
        assert!(restored.archived_at.is_none());
        assert_eq!(list_vehicles(&conn).unwrap().len(), 1);

        let err = archive_vehicle(&conn, "fehlt").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn fahrzeughistorie_ist_atomar_idempotent_und_unveraenderlich() {
        let conn = test_conn();
        let vehicle = create_vehicle(&conn, vehicle_input("Kunde", "Golf", "M-A 1")).unwrap();

        // Ein Fehler beim History-INSERT muss auch den Statuswechsel zurückrollen.
        conn.execute_batch(
            "CREATE TRIGGER fail_vehicle_history
             BEFORE INSERT ON vehicle_history
             BEGIN SELECT RAISE(ABORT, 'test'); END;",
        )
        .unwrap();
        assert!(
            update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::IsDone, true).is_err()
        );
        assert!(!get_vehicle(&conn, &vehicle.id).unwrap().is_done);
        conn.execute_batch("DROP TRIGGER fail_vehicle_history;")
            .unwrap();

        update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::IsDone, true).unwrap();
        let first = create_vehicle_history_snapshot(&conn, &vehicle.id).unwrap();
        let again = create_vehicle_history_snapshot(&conn, &vehicle.id).unwrap();
        assert_eq!(first, again);
        assert_eq!(list_completed_vehicle_history(&conn).unwrap().len(), 1);

        // Spätere Änderungen und erneutes Abschließen verändern den fachlichen
        // Snapshot nicht.
        update_vehicle(
            &conn,
            &vehicle.id,
            VehiclePatch {
                customer_name: Some("Geändert".to_string()),
                vehicle_name: Some("Passat".to_string()),
                license_plate: Some("B-Z 9".to_string()),
                note: None,
            },
        )
        .unwrap();
        update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::PartsOrdered, true).unwrap();
        update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::IsDone, false).unwrap();
        update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::IsDone, true).unwrap();
        assert_eq!(
            create_vehicle_history_snapshot(&conn, &vehicle.id).unwrap(),
            first
        );

        // Nur das einmalige Archiv-Metadatum wird nachgetragen und bleibt auch
        // bei wiederholtem Archivieren sowie Wiederherstellen erhalten.
        let archived = archive_vehicle(&conn, &vehicle.id).unwrap();
        let archived_at = archived.archived_at.clone().unwrap();
        let history = &list_completed_vehicle_history(&conn).unwrap()[0];
        assert_eq!(history.archived_at.as_deref(), Some(archived_at.as_str()));
        assert_eq!(history.customer_name, first.customer_name);
        assert_eq!(history.vehicle_name, first.vehicle_name);
        assert_eq!(history.license_plate, first.license_plate);
        assert_eq!(history.parts_ordered, first.parts_ordered);
        assert_eq!(
            archive_vehicle(&conn, &vehicle.id).unwrap().archived_at,
            Some(archived_at.clone())
        );
        restore_vehicle(&conn, &vehicle.id).unwrap();
        assert_eq!(
            list_completed_vehicle_history(&conn).unwrap()[0]
                .archived_at
                .as_deref(),
            Some(archived_at.as_str())
        );
    }

    #[test]
    fn abgeschlossenes_fahrzeug_bekommt_bereits_beim_anlegen_einen_snapshot() {
        let conn = test_conn();
        let mut input = vehicle_input("Direkt", "Corsa", "");
        input.is_done = true;
        let vehicle = create_vehicle(&conn, input).unwrap();
        let rows = list_completed_vehicle_history(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_vehicle_id, vehicle.id);
        assert_eq!(rows[0].customer_name, "Direkt");

        // Auch beim Anlegen ist Fahrzeug + Snapshot ein Commit.
        conn.execute_batch(
            "CREATE TRIGGER fail_vehicle_history_create
             BEFORE INSERT ON vehicle_history
             BEGIN SELECT RAISE(ABORT, 'test'); END;",
        )
        .unwrap();
        let mut failing = vehicle_input("Rollback", "Golf", "");
        failing.is_done = true;
        assert!(create_vehicle(&conn, failing).is_err());
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vehicles WHERE customer_name = 'Rollback'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn fahrzeughistorie_hat_stabile_sortierung() {
        let conn = test_conn();
        let mut ids = Vec::new();
        for customer in ["A", "B", "C"] {
            let mut input = vehicle_input(customer, "Golf", "");
            input.is_done = true;
            let vehicle = create_vehicle(&conn, input).unwrap();
            ids.push(
                create_vehicle_history_snapshot(&conn, &vehicle.id)
                    .unwrap()
                    .id,
            );
        }
        conn.execute(
            "UPDATE vehicle_history
             SET completed_at = '2025-01-01T10:00:00.000Z',
                 snapshot_created_at = '2025-01-01T10:00:00.000Z'",
            [],
        )
        .unwrap();
        ids.sort();
        let first = list_completed_vehicle_history(&conn).unwrap();
        let second = list_completed_vehicle_history(&conn).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.into_iter().map(|row| row.id).collect::<Vec<_>>(), ids);
    }

    #[test]
    fn ui_preferences_reparieren_ungueltige_werte_und_bleiben_persistent() {
        let conn = test_conn();
        let default = get_ui_preferences(&conn).unwrap();
        assert!(!default.payments_panel_collapsed);
        assert_eq!(default.payments_panel_height, DEFAULT_PAYMENTS_PANEL_HEIGHT);
        assert_eq!(default.vehicle_column_order, default_vehicle_column_order());
        assert!(default.vehicle_hidden_columns.is_empty());

        let order = vec![
            "isDone".to_string(),
            "unbekannt".to_string(),
            "isDone".to_string(),
            "customerName".to_string(),
        ];
        let updated = update_vehicle_column_order(&conn, &order).unwrap();
        assert_eq!(updated.vehicle_column_order[0], "isDone");
        assert_eq!(updated.vehicle_column_order[1], "customerName");
        assert_eq!(
            updated.vehicle_column_order.len(),
            VEHICLE_COLUMN_ORDER_DEFAULT.len()
        );
        assert!(!updated
            .vehicle_column_order
            .contains(&"unbekannt".to_string()));
        assert!(
            update_payments_panel_collapsed(&conn, true)
                .unwrap()
                .payments_panel_collapsed
        );
        assert!(get_ui_preferences(&conn).unwrap().payments_panel_collapsed);
        assert_eq!(
            update_payments_panel_height(&conn, 420)
                .unwrap()
                .payments_panel_height,
            420
        );
        assert_eq!(
            get_ui_preferences(&conn).unwrap().payments_panel_height,
            420
        );
        let all_hidden = default_vehicle_column_order();
        let hidden = update_vehicle_hidden_columns(&conn, &all_hidden).unwrap();
        assert_eq!(
            hidden.vehicle_hidden_columns.len(),
            VEHICLE_COLUMN_ORDER_DEFAULT.len() - 1
        );
        assert!(!hidden
            .vehicle_hidden_columns
            .contains(&"isDone".to_string()));
        assert_eq!(
            get_ui_preferences(&conn).unwrap().vehicle_hidden_columns,
            hidden.vehicle_hidden_columns
        );

        // Beschädigte/neuere persistierte Werte fallen auf einen validierten
        // Default zurück und werden direkt repariert.
        conn.execute(
            "UPDATE ui_preferences
             SET version = 999, payments_panel_collapsed = 7,
                 vehicle_column_order = 'kein-json'
             WHERE id = 1",
            [],
        )
        .unwrap();
        let repaired = get_ui_preferences(&conn).unwrap();
        assert_eq!(repaired, default);
        let stored: (i64, i64, String) = conn
            .query_row(
                "SELECT version, payments_panel_collapsed, vehicle_column_order
                 FROM ui_preferences WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored.0, UI_PREFERENCES_VERSION);
        assert_eq!(stored.1, 0);
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&stored.2).unwrap(),
            default.vehicle_column_order
        );
    }

    #[test]
    fn kundenvorschlaege_stammen_nur_aus_fahrzeugen_und_fahrzeughistorie() {
        let conn = test_conn();
        let vehicle = create_vehicle(&conn, vehicle_input("Anna", "Golf", "M-A 1")).unwrap();
        update_vehicle_status(&conn, &vehicle.id, VehicleStatusField::IsDone, true).unwrap();
        update_vehicle(
            &conn,
            &vehicle.id,
            VehiclePatch {
                customer_name: Some("ANNA".to_string()),
                vehicle_name: Some("Passat".to_string()),
                license_plate: Some("M-B 2".to_string()),
                note: None,
            },
        )
        .unwrap();
        create_vehicle(&conn, vehicle_input("Berta", "Corsa", "M-C 3")).unwrap();
        create_payment(
            &conn,
            NewPayment {
                customer_name: "Nur Zahlung".to_string(),
                amount_cents: 100,
                note: String::new(),
            },
        )
        .unwrap();
        // Eine reine History-Zeile simuliert einen inzwischen entfernten
        // Fahrzeugbestand und muss weiterhin Vorschläge liefern.
        conn.execute(
            "INSERT INTO vehicle_history (
                id, source_vehicle_id, customer_name, vehicle_name, license_plate,
                tuv_required, parts_ordered, parts_arrived, is_done, completed_at,
                archived_at, vehicle_created_at, snapshot_created_at
             ) VALUES (
                'history-only', 'deleted-source', 'Historie', 'Kadett', 'M-H 4',
                0, 0, 0, 1, '2030-01-01T00:00:00.000Z', NULL,
                '2020-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
             )",
            [],
        )
        .unwrap();

        let suggestions = list_customer_suggestions(&conn).unwrap();
        assert_eq!(
            suggestions
                .iter()
                .filter(|item| item.customer_name.eq_ignore_ascii_case("anna"))
                .count(),
            1
        );
        assert!(suggestions.iter().any(|item| item.customer_name == "Berta"));
        assert!(suggestions
            .iter()
            .any(|item| item.customer_name == "Historie"));
        assert!(!suggestions
            .iter()
            .any(|item| item.customer_name == "Nur Zahlung"));
        assert_eq!(suggestions[0].customer_name, "Historie");
        assert_eq!(suggestions[0].vehicle_name.as_deref(), Some("Kadett"));
    }

    #[test]
    fn zahlung_speichert_cent_betraege_exakt() {
        let conn = test_conn();
        let payment = create_payment(
            &conn,
            NewPayment {
                customer_name: "Schneider".to_string(),
                amount_cents: 48650,
                note: " Bremsen ".to_string(),
            },
        )
        .unwrap();
        assert_eq!(payment.amount_cents, 48650);
        assert_eq!(payment.note, "Bremsen");

        // Beträge liegen in der Datenbank als Integer, nicht als Gleitkommazahl.
        let stored_type: String = conn
            .query_row(
                "SELECT typeof(amount_cents) FROM payments WHERE id = ?1",
                [&payment.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_type, "integer");

        let err = create_payment(
            &conn,
            NewPayment {
                customer_name: "Schneider".to_string(),
                amount_cents: 0,
                note: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(err.field.as_deref(), Some("amountCents"));

        let err = create_payment(
            &conn,
            NewPayment {
                customer_name: "  ".to_string(),
                amount_cents: 100,
                note: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(err.field.as_deref(), Some("customerName"));
    }

    #[test]
    fn zahlung_aktualisieren() {
        let conn = test_conn();
        let payment = create_payment(
            &conn,
            NewPayment {
                customer_name: "Lang".to_string(),
                amount_cents: 12990,
                note: String::new(),
            },
        )
        .unwrap();

        let updated = update_payment(
            &conn,
            &payment.id,
            PaymentPatch {
                amount_cents: Some(13500),
                note: Some("Inspektion".to_string()),
                ..PaymentPatch::default()
            },
        )
        .unwrap();
        assert_eq!(updated.amount_cents, 13500);
        assert_eq!(updated.note, "Inspektion");
        assert_eq!(updated.customer_name, "Lang");

        let err = update_payment(
            &conn,
            &payment.id,
            PaymentPatch {
                amount_cents: Some(-1),
                ..PaymentPatch::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(get_payment(&conn, &payment.id).unwrap().amount_cents, 13500);
    }

    #[test]
    fn open_erzeugt_neue_datenbank_und_meldet_defekte_dateien_verstaendlich() {
        let dir = tempfile::tempdir().unwrap();

        // Frischer Pfad: Datenbank wird angelegt und migriert.
        let path = dir.path().join("neu.db");
        let conn = open(&path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), current_schema_version());
        drop(conn);

        // Defekte Datei: verständlicher Fehler ohne rohe SQLite-Details,
        // die Datei bleibt unverändert (nichts wird überschrieben).
        let broken = dir.path().join("defekt.db");
        std::fs::write(&broken, b"das ist keine sqlite-datenbank, nur text").unwrap();
        let err = open(&broken).unwrap_err();
        assert_eq!(err.code, ErrorCode::Database);
        assert!(!err.message.to_lowercase().contains("sqlite"));
        assert!(!err.message.contains("malformed"));
        let bytes = std::fs::read(&broken).unwrap();
        assert!(bytes.starts_with(b"das ist keine sqlite-datenbank"));
    }

    #[test]
    fn grosse_datenmengen_bleiben_schnell_abrufbar() {
        // Zieldaten aus den Abnahmekriterien: 250 aktive und 1.000 archivierte
        // Fahrzeuge sowie 500 Zahlungen. Die Abfragen müssen dabei deutlich
        // unter einer Sekunde bleiben (großzügige Schranke für langsame CI).
        let mut conn = test_conn();
        {
            let tx = conn.transaction().unwrap();
            let timestamp: String = tx
                .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                    row.get(0)
                })
                .unwrap();
            for index in 0..1250 {
                let archived_at: Option<&String> =
                    if index >= 250 { Some(&timestamp) } else { None };
                tx.execute(
                    "INSERT INTO vehicles (
                        id, customer_name, vehicle_name, license_plate,
                        tuv_required, parts_ordered, parts_arrived, is_done,
                        position, created_at, updated_at, archived_at
                     ) VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, ?5, ?6, ?6, ?7)",
                    params![
                        format!("fz-{index}"),
                        format!("Kunde {index}"),
                        format!("Fahrzeug {index}"),
                        format!("M-XX {index}"),
                        index as i64,
                        timestamp,
                        archived_at,
                    ],
                )
                .unwrap();
            }
            for index in 0..500 {
                tx.execute(
                    "INSERT INTO payments (id, customer_name, amount_cents, note, created_at, updated_at)
                     VALUES (?1, ?2, ?3, '', ?4, ?4)",
                    params![format!("zh-{index}"), format!("Kunde {index}"), 100 + index as i64, timestamp],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }

        let start = std::time::Instant::now();
        assert_eq!(list_vehicles(&conn).unwrap().len(), 250);
        assert_eq!(list_open_payments(&conn).unwrap().len(), 500);

        // Komplette Neupriorisierung aller 250 aktiven Fahrzeuge in einer
        // Transaktion – der teuerste Alltagsvorgang.
        let ids: Vec<String> = list_vehicles(&conn)
            .unwrap()
            .into_iter()
            .rev()
            .map(|vehicle| vehicle.id)
            .collect();
        assert_eq!(reorder_vehicles(&mut conn, &ids).unwrap().len(), 250);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(1),
            "Listen- und Reorder-Abfragen dauern zu lange: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn zahlung_bezahlt_und_rueckgaengig() {
        let conn = test_conn();
        let payment = create_payment(
            &conn,
            NewPayment {
                customer_name: "Öztürk".to_string(),
                amount_cents: 124000,
                note: String::new(),
            },
        )
        .unwrap();
        assert_eq!(list_open_payments(&conn).unwrap().len(), 1);

        let paid = mark_payment_paid(&conn, &payment.id).unwrap();
        assert!(paid.paid_at.is_some());
        assert!(list_open_payments(&conn).unwrap().is_empty());

        let restored = restore_payment(&conn, &payment.id).unwrap();
        assert!(restored.paid_at.is_none());
        assert_eq!(list_open_payments(&conn).unwrap().len(), 1);

        let err = mark_payment_paid(&conn, "fehlt").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
