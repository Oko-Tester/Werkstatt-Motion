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

use tauri::Manager;

use commands::{Db, DbState, SecretSessions, StoragePaths, Vault, VaultState};
use error::ApiError;
use keys::KeyStore;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Datenbank liegt im App-Datenverzeichnis des Betriebssystems,
            // nicht im Installationsordner. Scheitert Öffnen oder Migration,
            // startet die App trotzdem: Die Oberfläche zeigt einen klaren,
            // nicht blockierenden Fehlerzustand, und eine Wiederherstellung
            // aus einem Backup bleibt als Reparaturweg möglich.
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("werkstatt.db");
            let (conn, db_error) = match std::fs::create_dir_all(&data_dir)
                .map_err(|_| {
                    ApiError::database("App-Datenverzeichnis konnte nicht angelegt werden")
                })
                .and_then(|()| db::open(&db_path))
            {
                Ok(conn) => (Some(conn), None),
                Err(err) => (None, Some(err)),
            };

            // Master-Key aus dem Schlüsselspeicher des Betriebssystems laden
            // oder beim allerersten Start erzeugen. Scheitert das, startet die
            // App trotzdem – der versteckte Bereich meldet dann einen klaren
            // Fehlerzustand und erzeugt insbesondere KEINEN neuen Schlüssel,
            // solange verschlüsselte Einträge existieren (oder der Bestand
            // mangels Datenbank unbekannt ist).
            let has_encrypted_data = match &conn {
                Some(conn) => hidden::count_encrypted_records(conn)
                    .map(|count| count > 0)
                    .unwrap_or(true),
                None => true,
            };
            let store: Box<dyn KeyStore> = Box::new(keys::OsKeyStore);
            let (mut key_material, mut key_error) =
                match keys::load_or_init(store.as_ref(), has_encrypted_data) {
                    Ok(material) => (Some(material), None),
                    Err(err) => (None, Some(err)),
                };

            // Nach einer Schema-Aktualisierung archivierte Altbestände sofort
            // sicher nachziehen. Der Backfill authentifiziert vorher Bestand
            // und vorhandene History; bei jedem Fehler bleibt die App aktiv,
            // aber der Klartextbereich wird bis zur Reparatur gesperrt.
            let backfill_error = match (conn.as_ref(), key_material.as_ref()) {
                (Some(conn), Some(material)) => {
                    hidden::backfill_archived_history(conn, &material.master_key).err()
                }
                _ => None,
            };
            if let Some(err) = backfill_error {
                key_material = None;
                key_error = Some(err);
            }

            app.manage(Db(Mutex::new(DbState {
                conn,
                startup_error: db_error,
            })));
            app.manage(Vault(Mutex::new(VaultState {
                store,
                keys: key_material,
                key_error,
                staged: None,
            })));
            app.manage(SecretSessions::default());
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
            commands::create_vehicle_history_snapshot,
            commands::list_completed_vehicle_history,
            commands::list_customer_suggestions,
            commands::get_ui_preferences,
            commands::update_payments_panel_collapsed,
            commands::update_payments_panel_height,
            commands::update_vehicle_column_order,
            commands::update_vehicle_hidden_columns,
            commands::list_open_payments,
            commands::list_paid_payments,
            commands::create_payment,
            commands::update_payment,
            commands::mark_payment_paid,
            commands::restore_payment,
            commands::hidden_status,
            commands::begin_secret_session,
            commands::end_secret_session,
            commands::list_hidden_entries,
            commands::create_hidden_entry,
            commands::update_hidden_entry,
            commands::archive_hidden_entry,
            commands::restore_hidden_entry,
            commands::list_hidden_entry_history,
            commands::list_secret_history,
            commands::create_backup,
            commands::prepare_restore,
            commands::confirm_restore,
            commands::cancel_restore,
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Tauri-Anwendung");
}
