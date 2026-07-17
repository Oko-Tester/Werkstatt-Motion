use rusqlite::{params, Connection, Row};
use uuid::Uuid;

use crate::error::ApiError;
use crate::models::{
    NewPayment, NewVehicle, Payment, PaymentPatch, Vehicle, VehiclePatch, VehicleStatusField,
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
];

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
    Ok(conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [],
        |row| row.get(0),
    )?)
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

// ---------- Fahrzeuge ----------

pub fn get_vehicle(conn: &Connection, id: &str) -> Result<Vehicle, ApiError> {
    conn.query_row("SELECT * FROM vehicles WHERE id = ?1", [id], vehicle_from_row)
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

/// Legt ein Fahrzeug an. Neue Fahrzeuge kommen an die Spitze der Liste.
pub fn create_vehicle(conn: &Connection, input: NewVehicle) -> Result<Vehicle, ApiError> {
    let customer_name = input.customer_name.trim().to_string();
    let vehicle_name = input.vehicle_name.trim().to_string();
    let license_plate = normalize_license_plate(&input.license_plate);
    validate_vehicle_text(&customer_name, &vehicle_name, &license_plate)?;

    let id = Uuid::new_v4().to_string();
    let timestamp = now(conn)?;
    conn.execute(
        "INSERT INTO vehicles (
            id, customer_name, vehicle_name, license_plate,
            tuv_required, parts_ordered, parts_arrived, is_done,
            position, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            (SELECT COALESCE(MIN(position), 1) - 1 FROM vehicles), ?9, ?9
         )",
        params![
            id,
            customer_name,
            vehicle_name,
            license_plate,
            input.tuv_required,
            input.parts_ordered,
            input.parts_arrived,
            input.is_done,
            timestamp,
        ],
    )?;
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
    validate_vehicle_text(&customer_name, &vehicle_name, &license_plate)?;

    let timestamp = now(conn)?;
    conn.execute(
        "UPDATE vehicles
         SET customer_name = ?2, vehicle_name = ?3, license_plate = ?4, updated_at = ?5
         WHERE id = ?1",
        params![id, customer_name, vehicle_name, license_plate, timestamp],
    )?;
    get_vehicle(conn, id)
}

/// Schaltet genau ein Statusfeld um. Andere Status bleiben unberührt.
pub fn update_vehicle_status(
    conn: &Connection,
    id: &str,
    field: VehicleStatusField,
    value: bool,
) -> Result<Vehicle, ApiError> {
    let timestamp = now(conn)?;
    let changed = conn.execute(
        &format!(
            "UPDATE vehicles SET {} = ?2, updated_at = ?3 WHERE id = ?1",
            field.column()
        ),
        params![id, value, timestamp],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found("Fahrzeug nicht gefunden"));
    }
    get_vehicle(conn, id)
}

/// Speichert die per Drag-and-drop festgelegte Reihenfolge.
/// Die Position entspricht dem Index in der übergebenen Liste.
pub fn reorder_vehicles(conn: &mut Connection, ids: &[String]) -> Result<Vec<Vehicle>, ApiError> {
    let tx = conn.transaction()?;
    let timestamp: String = tx.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [],
        |row| row.get(0),
    )?;
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
    let timestamp = now(conn)?;
    let changed = conn.execute(
        "UPDATE vehicles SET archived_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, timestamp],
    )?;
    if changed == 0 {
        return Err(ApiError::not_found("Fahrzeug nicht gefunden"));
    }
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

// ---------- Zahlungen ----------

pub fn get_payment(conn: &Connection, id: &str) -> Result<Payment, ApiError> {
    conn.query_row("SELECT * FROM payments WHERE id = ?1", [id], payment_from_row)
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
    }

    #[test]
    fn fahrzeug_anlegen_normalisiert_und_validiert() {
        let conn = test_conn();
        let vehicle =
            create_vehicle(&conn, vehicle_input("  Müller, Anna ", " VW Golf ", "  m  ab 1234 "))
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
    fn neues_fahrzeug_steht_oben() {
        let conn = test_conn();
        let first = create_vehicle(&conn, vehicle_input("Erster", "Golf", "")).unwrap();
        let second = create_vehicle(&conn, vehicle_input("Zweiter", "Passat", "")).unwrap();
        let list = list_vehicles(&conn).unwrap();
        assert_eq!(
            list.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()],
        );
        assert!(second.position < first.position);
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
        assert_eq!(get_vehicle(&conn, &vehicle.id).unwrap().customer_name, "Neu");

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
