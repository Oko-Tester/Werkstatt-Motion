use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::backup::{self, ValidatedBackup, BACKUP_FILE_EXTENSION};
use crate::crypto::SecretKey;
use crate::db;
use crate::error::ApiError;
use crate::hidden;
use crate::keys::{self, KeyMaterial, KeyStore};
use crate::models::{
    HiddenEntry, HiddenEntryPatch, NewHiddenEntry, NewPayment, NewVehicle, Payment, PaymentPatch,
    Vehicle, VehiclePatch, VehicleStatusField,
};

/// Datenbankzustand: Die App startet auch, wenn die Datenbank nicht geöffnet
/// oder migriert werden konnte – Commands liefern dann den gespeicherten
/// Fehler, und eine Wiederherstellung aus einem Backup bleibt möglich.
pub struct DbState {
    pub conn: Option<Connection>,
    /// Grund, falls die Datenbank beim Start nicht nutzbar war.
    pub startup_error: Option<ApiError>,
}

impl DbState {
    fn conn(&self) -> Result<&Connection, ApiError> {
        self.conn.as_ref().ok_or_else(|| self.unavailable())
    }

    fn conn_mut(&mut self) -> Result<&mut Connection, ApiError> {
        let error = self.unavailable();
        self.conn.as_mut().ok_or(error)
    }

    fn unavailable(&self) -> ApiError {
        self.startup_error
            .clone()
            .unwrap_or_else(|| ApiError::database("Die Datenbank ist nicht verfügbar"))
    }
}

/// Gemeinsamer Datenbankzugriff für alle Commands.
pub struct Db(pub Mutex<DbState>);

impl Db {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, DbState>, ApiError> {
        self.0
            .lock()
            .map_err(|_| ApiError::database("Datenbankverbindung nicht verfügbar"))
    }
}

/// Schlüsselmaterial und vorbereitete Wiederherstellung. Der Master-Key lebt
/// ausschließlich hier im Rust-Backend und wird nie ans Frontend übertragen.
pub struct VaultState {
    pub store: Box<dyn KeyStore>,
    pub keys: Option<KeyMaterial>,
    /// Grund, falls kein Schlüssel geladen werden konnte.
    pub key_error: Option<ApiError>,
    /// Validiertes Backup, das auf die Bestätigung wartet.
    pub staged: Option<ValidatedBackup>,
}

pub struct Vault(pub Mutex<VaultState>);

impl Vault {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, VaultState>, ApiError> {
        self.0
            .lock()
            .map_err(|_| ApiError::database("Schlüsselverwaltung nicht verfügbar"))
    }

    /// Liefert den Master-Key oder den gespeicherten Fehlerzustand.
    fn master_key(&self) -> Result<SecretKey, ApiError> {
        let state = self.lock()?;
        require_key(&state)
    }
}

/// Speicherorte der App (Datenbankdatei, automatische Sicherungen).
pub struct StoragePaths {
    pub db_path: PathBuf,
    pub backups_dir: PathBuf,
}

fn require_key(state: &VaultState) -> Result<SecretKey, ApiError> {
    match &state.keys {
        Some(material) => Ok(material.master_key.clone()),
        None => Err(state
            .key_error
            .clone()
            .unwrap_or_else(ApiError::keystore_unavailable)),
    }
}

// ---------- Fahrzeuge ----------

#[tauri::command]
pub fn list_vehicles(state: State<'_, Db>) -> Result<Vec<Vehicle>, ApiError> {
    let state = state.lock()?;
    db::list_vehicles(state.conn()?)
}

#[tauri::command]
pub fn create_vehicle(state: State<'_, Db>, input: NewVehicle) -> Result<Vehicle, ApiError> {
    let state = state.lock()?;
    db::create_vehicle(state.conn()?, input)
}

#[tauri::command]
pub fn update_vehicle(
    state: State<'_, Db>,
    id: String,
    patch: VehiclePatch,
) -> Result<Vehicle, ApiError> {
    let state = state.lock()?;
    db::update_vehicle(state.conn()?, &id, patch)
}

#[tauri::command]
pub fn update_vehicle_status(
    state: State<'_, Db>,
    id: String,
    field: VehicleStatusField,
    value: bool,
) -> Result<Vehicle, ApiError> {
    let state = state.lock()?;
    db::update_vehicle_status(state.conn()?, &id, field, value)
}

#[tauri::command]
pub fn reorder_vehicles(state: State<'_, Db>, ids: Vec<String>) -> Result<Vec<Vehicle>, ApiError> {
    let mut state = state.lock()?;
    db::reorder_vehicles(state.conn_mut()?, &ids)
}

#[tauri::command]
pub fn archive_vehicle(state: State<'_, Db>, id: String) -> Result<Vehicle, ApiError> {
    let state = state.lock()?;
    db::archive_vehicle(state.conn()?, &id)
}

#[tauri::command]
pub fn restore_vehicle(state: State<'_, Db>, id: String) -> Result<Vehicle, ApiError> {
    let state = state.lock()?;
    db::restore_vehicle(state.conn()?, &id)
}

// ---------- Zahlungen ----------

#[tauri::command]
pub fn list_open_payments(state: State<'_, Db>) -> Result<Vec<Payment>, ApiError> {
    let state = state.lock()?;
    db::list_open_payments(state.conn()?)
}

#[tauri::command]
pub fn create_payment(state: State<'_, Db>, input: NewPayment) -> Result<Payment, ApiError> {
    let state = state.lock()?;
    db::create_payment(state.conn()?, input)
}

#[tauri::command]
pub fn update_payment(
    state: State<'_, Db>,
    id: String,
    patch: PaymentPatch,
) -> Result<Payment, ApiError> {
    let state = state.lock()?;
    db::update_payment(state.conn()?, &id, patch)
}

#[tauri::command]
pub fn mark_payment_paid(state: State<'_, Db>, id: String) -> Result<Payment, ApiError> {
    let state = state.lock()?;
    db::mark_payment_paid(state.conn()?, &id)
}

#[tauri::command]
pub fn restore_payment(state: State<'_, Db>, id: String) -> Result<Payment, ApiError> {
    let state = state.lock()?;
    db::restore_payment(state.conn()?, &id)
}

// ---------- Versteckter Bereich ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenStatus {
    /// `true`, wenn der Schlüssel geladen ist und Einträge lesbar sind.
    pub unlocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

#[tauri::command]
pub fn hidden_status(vault: State<'_, Vault>) -> Result<HiddenStatus, ApiError> {
    let state = vault.lock()?;
    Ok(HiddenStatus {
        unlocked: state.keys.is_some(),
        error: state.key_error.clone(),
    })
}

#[tauri::command]
pub fn list_hidden_entries(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
) -> Result<Vec<HiddenEntry>, ApiError> {
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::list_entries(state.conn()?, &key)
}

#[tauri::command]
pub fn create_hidden_entry(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    input: NewHiddenEntry,
) -> Result<HiddenEntry, ApiError> {
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::create_entry(state.conn()?, &key, input)
}

#[tauri::command]
pub fn update_hidden_entry(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    id: String,
    patch: HiddenEntryPatch,
) -> Result<HiddenEntry, ApiError> {
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::update_entry(state.conn()?, &key, &id, patch)
}

#[tauri::command]
pub fn archive_hidden_entry(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    id: String,
) -> Result<HiddenEntry, ApiError> {
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::archive_entry(state.conn()?, &key, &id)
}

#[tauri::command]
pub fn restore_hidden_entry(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    id: String,
) -> Result<HiddenEntry, ApiError> {
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::restore_entry(state.conn()?, &key, &id)
}

// ---------- Backup und Wiederherstellung ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub saved: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub cancelled: bool,
    pub created_at: Option<String>,
    pub file_name: Option<String>,
    pub vehicle_count: Option<i64>,
    pub payment_count: Option<i64>,
    pub hidden_count: Option<i64>,
}

impl RestorePreview {
    fn cancelled() -> Self {
        Self {
            cancelled: true,
            created_at: None,
            file_name: None,
            vehicle_count: None,
            payment_count: None,
            hidden_count: None,
        }
    }
}

/// Erstellt ein Backup über den nativen Speichern-Dialog. Async, damit der
/// blockierende Dialog nicht auf dem Hauptthread läuft.
#[tauri::command]
pub async fn create_backup(
    app: tauri::AppHandle,
    vault: State<'_, Vault>,
    db: State<'_, Db>,
) -> Result<BackupResult, ApiError> {
    // Schlüssel klonen, damit während des Dialogs kein Lock gehalten wird.
    let keys = {
        let state = vault.lock()?;
        match &state.keys {
            Some(material) => KeyMaterial {
                master_key: material.master_key.clone(),
                recovery_code: material.recovery_code.clone(),
            },
            None => {
                return Err(state
                    .key_error
                    .clone()
                    .unwrap_or_else(ApiError::keystore_unavailable))
            }
        }
    };

    let date = {
        let state = db.lock()?;
        db::now(state.conn()?)?
            .split('T')
            .next()
            .unwrap_or("backup")
            .to_string()
    };
    let picked = app
        .dialog()
        .file()
        .add_filter("Werkstatt-Backup", &[BACKUP_FILE_EXTENSION])
        .set_file_name(&format!("werkstatt-backup-{date}.{BACKUP_FILE_EXTENSION}"))
        .blocking_save_file();
    let Some(file_path) = picked else {
        return Ok(BackupResult { saved: false, path: None });
    };
    let path = file_path
        .into_path()
        .map_err(|_| ApiError::backup("Ungültiger Speicherort"))?;

    let bytes = {
        let state = db.lock()?;
        backup::create_backup_bytes(state.conn()?, &keys)?
    };
    std::fs::write(&path, bytes)
        .map_err(|_| ApiError::backup("Backup-Datei konnte nicht geschrieben werden"))?;
    Ok(BackupResult {
        saved: true,
        path: Some(path.display().to_string()),
    })
}

/// Erster Schritt der Wiederherstellung: Datei über den nativen Dialog
/// wählen und vollständig validieren. Die aktuelle Datenbank bleibt unberührt.
#[tauri::command]
pub async fn prepare_restore(
    app: tauri::AppHandle,
    vault: State<'_, Vault>,
) -> Result<RestorePreview, ApiError> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Werkstatt-Backup", &[BACKUP_FILE_EXTENSION])
        .blocking_pick_file();
    let Some(file_path) = picked else {
        return Ok(RestorePreview::cancelled());
    };
    let path = file_path
        .into_path()
        .map_err(|_| ApiError::backup("Ungültige Datei"))?;
    let bytes = std::fs::read(&path)
        .map_err(|_| ApiError::backup("Backup-Datei konnte nicht gelesen werden"))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string());

    let mut state = vault.lock()?;
    let current_key = state.keys.as_ref().map(|keys| keys.master_key.clone());
    // Falls der Master-Key nicht geladen werden konnte, hilft womöglich noch
    // der gespeicherte Wiederherstellungscode beim Entsperren des Backups.
    let recovery_code = match state.keys.as_ref() {
        Some(keys) => Some(keys.recovery_code.clone()),
        None => keys::read_recovery_code(state.store.as_ref()).unwrap_or(None),
    };
    let validated =
        backup::validate_backup_bytes(&bytes, file_name, current_key.as_ref(), recovery_code.as_ref())?;

    let preview = RestorePreview {
        cancelled: false,
        created_at: Some(validated.created_at.clone()),
        file_name: validated.file_name.clone(),
        vehicle_count: Some(validated.vehicle_count),
        payment_count: Some(validated.payment_count),
        hidden_count: Some(validated.hidden_count),
    };
    state.staged = Some(validated);
    Ok(preview)
}

/// Zweiter Schritt: bestätigte Wiederherstellung. Sichert vorher den
/// aktuellen Zustand automatisch und tauscht die Datenbank atomar aus.
/// Funktioniert auch als Reparaturweg, wenn die aktuelle Datenbank nicht
/// nutzbar ist – dann wird die defekte Datei beiseitegelegt statt gesichert.
#[tauri::command]
pub async fn confirm_restore(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    paths: State<'_, StoragePaths>,
) -> Result<(), ApiError> {
    let mut vault_state = vault.lock()?;
    let staged = vault_state
        .staged
        .take()
        .ok_or_else(|| ApiError::backup("Keine geprüfte Backup-Datei ausgewählt"))?;
    let mut db_state = db.lock()?;

    // 1. Automatische Sicherung des aktuellen Zustands. Ein richtiges
    //    Safety-Backup braucht Datenbank UND Schlüssel; fehlt eines von
    //    beiden, wird die aktuelle Datei stattdessen roh ins
    //    Backup-Verzeichnis kopiert, damit nichts verloren geht.
    match (db_state.conn.as_ref(), vault_state.keys.as_ref()) {
        (Some(conn), Some(keys)) => {
            backup::write_safety_backup(conn, keys, &paths.backups_dir)?;
        }
        _ => backup::preserve_broken_database(&paths.db_path, &paths.backups_dir),
    }

    // 2. Falls das Backup einen anderen Schlüssel mitbringt, zuerst den
    //    Schlüsselspeicher aktualisieren – schlägt das fehl, bleibt alles beim Alten.
    if staged.key_changed {
        keys::store_master_key(vault_state.store.as_ref(), &staged.master_key)?;
    }

    // 3. Datenbank atomar austauschen.
    if let Err(err) = backup::swap_database(&mut db_state.conn, &paths.db_path, &staged.db_bytes) {
        if staged.key_changed {
            if let Some(previous) = &vault_state.keys {
                let _ = keys::store_master_key(vault_state.store.as_ref(), &previous.master_key);
            }
        }
        return Err(err);
    }
    db_state.startup_error = None;

    match vault_state.keys.as_mut() {
        Some(material) => material.master_key = staged.master_key.clone(),
        None => {
            // Der Schlüssel aus dem Backup steht jetzt im Schlüsselspeicher:
            // Material neu laden, damit der versteckte Bereich sofort nutzbar
            // ist (Reparaturweg bei zuvor fehlendem Schlüssel).
            match keys::load_or_init(vault_state.store.as_ref(), true) {
                Ok(material) => {
                    vault_state.keys = Some(material);
                    vault_state.key_error = None;
                }
                Err(err) => vault_state.key_error = Some(err),
            }
        }
    }
    Ok(())
}

/// Bricht eine vorbereitete Wiederherstellung ab.
#[tauri::command]
pub fn cancel_restore(vault: State<'_, Vault>) -> Result<(), ApiError> {
    vault.lock()?.staged = None;
    Ok(())
}
