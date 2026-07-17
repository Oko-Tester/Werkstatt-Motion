#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod error;
mod models;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

use commands::Db;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Datenbank liegt im App-Datenverzeichnis des Betriebssystems,
            // nicht im Installationsordner.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let mut conn = Connection::open(data_dir.join("werkstatt.db"))?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "foreign_keys", "ON")?;
            db::migrate(&mut conn)?;
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_vehicles,
            commands::create_vehicle,
            commands::update_vehicle,
            commands::update_vehicle_status,
            commands::reorder_vehicles,
            commands::archive_vehicle,
            commands::restore_vehicle,
            commands::list_open_payments,
            commands::create_payment,
            commands::update_payment,
            commands::mark_payment_paid,
            commands::restore_payment,
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Tauri-Anwendung");
}
