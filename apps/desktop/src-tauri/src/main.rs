#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod commands;
mod crypto;
mod db;
mod error;
mod hidden;
mod keys;
mod models;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

use commands::{Db, StoragePaths, Vault, VaultState};
use keys::KeyStore;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Datenbank liegt im App-Datenverzeichnis des Betriebssystems,
            // nicht im Installationsordner.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("werkstatt.db");
            let mut conn = Connection::open(&db_path)?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "foreign_keys", "ON")?;
            db::migrate(&mut conn)?;

            // Master-Key aus dem Schlüsselspeicher des Betriebssystems laden
            // oder beim allerersten Start erzeugen. Scheitert das, startet die
            // App trotzdem – der versteckte Bereich meldet dann einen klaren
            // Fehlerzustand und erzeugt insbesondere KEINEN neuen Schlüssel,
            // solange verschlüsselte Einträge existieren.
            let has_encrypted_data = hidden::count_entries(&conn)? > 0;
            let store: Box<dyn KeyStore> = Box::new(keys::OsKeyStore);
            let (key_material, key_error) = match keys::load_or_init(store.as_ref(), has_encrypted_data)
            {
                Ok(material) => (Some(material), None),
                Err(err) => (None, Some(err)),
            };

            app.manage(Db(Mutex::new(conn)));
            app.manage(Vault(Mutex::new(VaultState {
                store,
                keys: key_material,
                key_error,
                staged: None,
            })));
            app.manage(StoragePaths {
                db_path,
                backups_dir: data_dir.join("backups"),
            });
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
            commands::hidden_status,
            commands::list_hidden_entries,
            commands::create_hidden_entry,
            commands::update_hidden_entry,
            commands::archive_hidden_entry,
            commands::restore_hidden_entry,
            commands::create_backup,
            commands::prepare_restore,
            commands::confirm_restore,
            commands::cancel_restore,
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Tauri-Anwendung");
}
