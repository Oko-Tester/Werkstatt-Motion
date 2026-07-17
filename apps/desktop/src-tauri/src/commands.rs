use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

use crate::db;
use crate::error::ApiError;
use crate::models::{
    NewPayment, NewVehicle, Payment, PaymentPatch, Vehicle, VehiclePatch, VehicleStatusField,
};

/// Gemeinsamer Datenbankzugriff für alle Commands.
pub struct Db(pub Mutex<Connection>);

impl Db {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, ApiError> {
        self.0
            .lock()
            .map_err(|_| ApiError::database("Datenbankverbindung nicht verfügbar"))
    }
}

// ---------- Fahrzeuge ----------

#[tauri::command]
pub fn list_vehicles(state: State<'_, Db>) -> Result<Vec<Vehicle>, ApiError> {
    let conn = state.lock()?;
    db::list_vehicles(&conn)
}

#[tauri::command]
pub fn create_vehicle(state: State<'_, Db>, input: NewVehicle) -> Result<Vehicle, ApiError> {
    let conn = state.lock()?;
    db::create_vehicle(&conn, input)
}

#[tauri::command]
pub fn update_vehicle(
    state: State<'_, Db>,
    id: String,
    patch: VehiclePatch,
) -> Result<Vehicle, ApiError> {
    let conn = state.lock()?;
    db::update_vehicle(&conn, &id, patch)
}

#[tauri::command]
pub fn update_vehicle_status(
    state: State<'_, Db>,
    id: String,
    field: VehicleStatusField,
    value: bool,
) -> Result<Vehicle, ApiError> {
    let conn = state.lock()?;
    db::update_vehicle_status(&conn, &id, field, value)
}

#[tauri::command]
pub fn reorder_vehicles(state: State<'_, Db>, ids: Vec<String>) -> Result<Vec<Vehicle>, ApiError> {
    let mut conn = state.lock()?;
    db::reorder_vehicles(&mut conn, &ids)
}

#[tauri::command]
pub fn archive_vehicle(state: State<'_, Db>, id: String) -> Result<Vehicle, ApiError> {
    let conn = state.lock()?;
    db::archive_vehicle(&conn, &id)
}

#[tauri::command]
pub fn restore_vehicle(state: State<'_, Db>, id: String) -> Result<Vehicle, ApiError> {
    let conn = state.lock()?;
    db::restore_vehicle(&conn, &id)
}

// ---------- Zahlungen ----------

#[tauri::command]
pub fn list_open_payments(state: State<'_, Db>) -> Result<Vec<Payment>, ApiError> {
    let conn = state.lock()?;
    db::list_open_payments(&conn)
}

#[tauri::command]
pub fn create_payment(state: State<'_, Db>, input: NewPayment) -> Result<Payment, ApiError> {
    let conn = state.lock()?;
    db::create_payment(&conn, input)
}

#[tauri::command]
pub fn update_payment(
    state: State<'_, Db>,
    id: String,
    patch: PaymentPatch,
) -> Result<Payment, ApiError> {
    let conn = state.lock()?;
    db::update_payment(&conn, &id, patch)
}

#[tauri::command]
pub fn mark_payment_paid(state: State<'_, Db>, id: String) -> Result<Payment, ApiError> {
    let conn = state.lock()?;
    db::mark_payment_paid(&conn, &id)
}

#[tauri::command]
pub fn restore_payment(state: State<'_, Db>, id: String) -> Result<Payment, ApiError> {
    let conn = state.lock()?;
    db::restore_payment(&conn, &id)
}
