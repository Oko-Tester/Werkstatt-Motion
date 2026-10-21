use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::backup::{self, BackupStatus, ValidatedBackup, BACKUP_FILE_EXTENSION};
use crate::crypto::{self, SecretKey};
use crate::db;
use crate::error::ApiError;
use crate::hidden;
use crate::keys::{self, KeyMaterial, KeyStore};
use crate::models::{
    CustomerSuggestion, HiddenEntry, HiddenEntryPatch, NewHiddenEntry, NewPayment, NewVehicle,
    Payment, PaymentPatch, SecretHistoryEntry, UiPreferences, Vehicle, VehicleHistory,
    VehiclePatch, VehicleStatusField,
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

/// Flüchtige Berechtigungen für Klartextzugriffe auf den versteckten Bereich.
/// Es werden ausschließlich zufällige Tokens im Prozessspeicher gehalten; ein
/// Neustart oder Drop beendet damit automatisch alle Sitzungen.
#[derive(Default)]
pub struct SecretSessions(Mutex<HashSet<String>>);

impl SecretSessions {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashSet<String>>, ApiError> {
        self.0
            .lock()
            .map_err(|_| ApiError::database("Secret-Sitzungen sind nicht verfügbar"))
    }

    fn begin(&self) -> Result<String, ApiError> {
        let mut sessions = self.lock()?;
        loop {
            let token = URL_SAFE_NO_PAD.encode(crypto::random_bytes(32));
            if sessions.insert(token.clone()) {
                return Ok(token);
            }
        }
    }

    fn require(&self, token: &str) -> Result<(), ApiError> {
        if token.is_empty() || !self.lock()?.contains(token) {
            return Err(ApiError::validation(
                "sessionToken",
                "Secret-Sitzung ist ungültig oder beendet",
            ));
        }
        Ok(())
    }

    fn end(&self, token: &str) -> Result<(), ApiError> {
        if token.is_empty() || !self.lock()?.remove(token) {
            return Err(ApiError::validation(
                "sessionToken",
                "Secret-Sitzung ist ungültig oder beendet",
            ));
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), ApiError> {
        self.lock()?.clear();
        Ok(())
    }
}

/// Speicherorte der App (Datenbankdatei, automatische Sicherungen).
pub struct StoragePaths {
    pub db_path: PathBuf,
    pub backups_dir: PathBuf,
    /// Backup-Einstellungen (zweiter Speicherort), neben der Datenbank.
    pub settings_path: PathBuf,
}

/// Ordner der installierten Programmdatei. Bei einem AppImage zeigt
/// `current_exe()` in einen schreibgeschützten Mount (`/tmp/.mount_…`);
/// gemeint ist dann der Ordner, in dem die AppImage-Datei selbst liegt.
#[cfg(target_os = "linux")]
fn appimage_dir() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os("APPIMAGE")?);
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(PathBuf::from)
}

#[cfg(not(target_os = "linux"))]
fn appimage_dir() -> Option<PathBuf> {
    None
}

/// Systemweite Installationsorte gehören unter Linux root und werden von der
/// Paketverwaltung verwaltet. Sicherungen haben dort nichts verloren: Als
/// Nutzer darf man dort nicht schreiben, und ein Paket-Update würde die
/// Dateien mitnehmen.
#[cfg(target_os = "linux")]
fn is_system_location(dir: &Path) -> bool {
    ["/usr", "/opt", "/snap", "/app", "/bin", "/sbin", "/nix"]
        .iter()
        .any(|prefix| dir.starts_with(prefix))
}

#[cfg(not(target_os = "linux"))]
fn is_system_location(_dir: &Path) -> bool {
    false
}

fn installation_dir() -> Option<PathBuf> {
    appimage_dir().or_else(|| std::env::current_exe().ok()?.parent().map(PathBuf::from))
}

/// Ablageorte für die Sicherung vor einem Update, in dieser Reihenfolge:
/// neben der installierten Programmdatei (dort ist sie ohne laufende App
/// auffindbar) und – falls das nicht geht – im Backup-Ordner der App-Daten,
/// wo auch die täglichen Sicherungen liegen. Der zweite Ort ist immer dabei,
/// damit ein Update nie an fehlenden Schreibrechten scheitert.
fn update_backup_targets(
    install_dir: Option<PathBuf>,
    data_backups_dir: &Path,
) -> Vec<backup::UpdateBackupTarget> {
    let mut targets = Vec::new();
    if let Some(install_dir) = install_dir.filter(|dir| !is_system_location(dir)) {
        targets.push(backup::UpdateBackupTarget::next_to_installation(
            &install_dir,
        ));
    }
    let app_data = backup::UpdateBackupTarget::app_data(data_backups_dir);
    if !targets.iter().any(|target| target.dir == app_data.dir) {
        targets.push(app_data);
    }
    targets
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
pub fn update_vehicle_appointment(
    state: State<'_, Db>,
    id: String,
    appointment_at: Option<String>,
) -> Result<Vehicle, ApiError> {
    let state = state.lock()?;
    db::update_vehicle_appointment(state.conn()?, &id, appointment_at)
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

#[tauri::command]
pub fn create_vehicle_history_snapshot(
    state: State<'_, Db>,
    id: String,
) -> Result<VehicleHistory, ApiError> {
    let state = state.lock()?;
    db::create_vehicle_history_snapshot(state.conn()?, &id)
}

#[tauri::command]
pub fn list_completed_vehicle_history(
    state: State<'_, Db>,
) -> Result<Vec<VehicleHistory>, ApiError> {
    let state = state.lock()?;
    db::list_completed_vehicle_history(state.conn()?)
}

#[tauri::command]
pub fn list_customer_suggestions(
    state: State<'_, Db>,
) -> Result<Vec<CustomerSuggestion>, ApiError> {
    let state = state.lock()?;
    db::list_customer_suggestions(state.conn()?)
}

// ---------- UI-Präferenzen ----------

#[tauri::command]
pub fn get_ui_preferences(state: State<'_, Db>) -> Result<UiPreferences, ApiError> {
    let state = state.lock()?;
    db::get_ui_preferences(state.conn()?)
}

#[tauri::command]
pub fn update_payments_panel_collapsed(
    state: State<'_, Db>,
    collapsed: bool,
) -> Result<UiPreferences, ApiError> {
    let state = state.lock()?;
    db::update_payments_panel_collapsed(state.conn()?, collapsed)
}

#[tauri::command]
pub fn update_payments_panel_height(
    state: State<'_, Db>,
    height: i64,
) -> Result<UiPreferences, ApiError> {
    let state = state.lock()?;
    db::update_payments_panel_height(state.conn()?, height)
}

#[tauri::command]
pub fn update_vehicle_column_order(
    state: State<'_, Db>,
    column_order: Vec<String>,
) -> Result<UiPreferences, ApiError> {
    let state = state.lock()?;
    db::update_vehicle_column_order(state.conn()?, &column_order)
}

#[tauri::command]
pub fn update_vehicle_hidden_columns(
    state: State<'_, Db>,
    hidden_columns: Vec<String>,
) -> Result<UiPreferences, ApiError> {
    let state = state.lock()?;
    db::update_vehicle_hidden_columns(state.conn()?, &hidden_columns)
}

// ---------- Zahlungen ----------

#[tauri::command]
pub fn list_open_payments(state: State<'_, Db>) -> Result<Vec<Payment>, ApiError> {
    let state = state.lock()?;
    db::list_open_payments(state.conn()?)
}

#[tauri::command]
pub fn list_paid_payments(state: State<'_, Db>) -> Result<Vec<Payment>, ApiError> {
    let state = state.lock()?;
    db::list_paid_payments(state.conn()?)
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
pub fn begin_secret_session(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    sessions: State<'_, SecretSessions>,
) -> Result<String, ApiError> {
    let key = vault.master_key()?;
    let state = db.lock()?;
    // Eine Sitzung wird erst ausgestellt, nachdem Altbestand und vorhandene
    // History authentifiziert sowie fehlende Archiv-Snapshots nachgezogen sind.
    hidden::verify_all(state.conn()?, &key)?;
    hidden::backfill_archived_history(state.conn()?, &key)?;
    hidden::verify_all(state.conn()?, &key)?;
    sessions.begin()
}

#[tauri::command]
pub fn end_secret_session(
    sessions: State<'_, SecretSessions>,
    session_token: String,
) -> Result<(), ApiError> {
    sessions.end(&session_token)
}

#[tauri::command]
pub fn list_hidden_entries(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    sessions: State<'_, SecretSessions>,
    session_token: String,
) -> Result<Vec<HiddenEntry>, ApiError> {
    sessions.require(&session_token)?;
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::list_entries(state.conn()?, &key)
}

#[tauri::command]
pub fn create_hidden_entry(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    sessions: State<'_, SecretSessions>,
    session_token: String,
    input: NewHiddenEntry,
) -> Result<HiddenEntry, ApiError> {
    sessions.require(&session_token)?;
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::create_entry(state.conn()?, &key, input)
}

#[tauri::command]
pub fn update_hidden_entry(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    sessions: State<'_, SecretSessions>,
    session_token: String,
    id: String,
    patch: HiddenEntryPatch,
) -> Result<HiddenEntry, ApiError> {
    sessions.require(&session_token)?;
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::update_entry(state.conn()?, &key, &id, patch)
}

#[tauri::command]
pub fn archive_hidden_entry(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    sessions: State<'_, SecretSessions>,
    session_token: String,
    id: String,
) -> Result<HiddenEntry, ApiError> {
    sessions.require(&session_token)?;
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::archive_entry(state.conn()?, &key, &id)
}

#[tauri::command]
pub fn restore_hidden_entry(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    sessions: State<'_, SecretSessions>,
    session_token: String,
    id: String,
) -> Result<HiddenEntry, ApiError> {
    sessions.require(&session_token)?;
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::restore_entry(state.conn()?, &key, &id)
}

#[tauri::command]
pub fn list_hidden_entry_history(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    sessions: State<'_, SecretSessions>,
    session_token: String,
) -> Result<Vec<SecretHistoryEntry>, ApiError> {
    sessions.require(&session_token)?;
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::backfill_archived_history(state.conn()?, &key)?;
    hidden::list_history(state.conn()?, &key)
}

/// Kompakter Alias für Clients, die den fachlichen Namen „Secret History“
/// verwenden. Beide Commands haben identische Session-Pflichten.
#[tauri::command]
pub fn list_secret_history(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    sessions: State<'_, SecretSessions>,
    session_token: String,
) -> Result<Vec<SecretHistoryEntry>, ApiError> {
    sessions.require(&session_token)?;
    let key = vault.master_key()?;
    let state = db.lock()?;
    hidden::backfill_archived_history(state.conn()?, &key)?;
    hidden::list_history(state.conn()?, &key)
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
pub struct UpdateBackupResult {
    pub path: String,
    /// false, wenn die Sicherung nicht neben der Installation, sondern im
    /// Datenordner der App gelandet ist (z. B. Linux-Paketinstallation).
    pub next_to_installation: bool,
}

/// Ergebnis der Kopie in den zweiten Speicherort.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondBackupOutcome {
    /// true, wenn heute eine neue Kopie geschrieben wurde.
    pub created: bool,
    pub path: Option<String>,
    /// Grund, falls der zweite Ordner gerade nicht erreichbar ist.
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBackupResult {
    pub created: bool,
    pub path: String,
    /// `None`, wenn kein zweiter Speicherort eingerichtet ist.
    pub second: Option<SecondBackupOutcome>,
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
        return Ok(BackupResult {
            saved: false,
            path: None,
        });
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

/// Klont das Schlüsselmaterial, damit während langsamer Dateioperationen kein
/// Lock gehalten wird.
fn clone_keys(vault: &Vault) -> Result<KeyMaterial, ApiError> {
    let state = vault.lock()?;
    match &state.keys {
        Some(material) => Ok(KeyMaterial {
            master_key: material.master_key.clone(),
            recovery_code: material.recovery_code.clone(),
        }),
        None => Err(state
            .key_error
            .clone()
            .unwrap_or_else(ApiError::keystore_unavailable)),
    }
}

/// Erstellt bei Bedarf die heutige automatische Sicherung, entfernt tägliche
/// Backups außerhalb des 14-Tage-Aufbewahrungsfensters und kopiert sie – falls
/// eingerichtet – in den zweiten Speicherort. Async, weil ein Netzlaufwerk oder
/// USB-Stick langsam sein kann und die Oberfläche nicht darauf warten soll.
#[tauri::command]
pub async fn create_daily_backup(
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    paths: State<'_, StoragePaths>,
) -> Result<DailyBackupResult, ApiError> {
    let keys = clone_keys(&vault)?;
    // Die Tage nur einmal bestimmen: Vergeht während der Sicherung Mitternacht,
    // dürfen lokale Datei und Kopie nicht unter verschiedenen Tagen laufen.
    let (result, today, cutoff_date) = {
        let state = db.lock()?;
        let conn = state.conn()?;
        let (today, cutoff_date) = backup::daily_dates(conn)?;
        let result = backup::write_daily_backup_for_dates(
            conn,
            &keys,
            &paths.backups_dir,
            &today,
            &cutoff_date,
        )?;
        (result, today, cutoff_date)
    };

    // Der zweite Ordner gehört nicht mehr zur Datenbanksperre: Er kann langsam
    // sein, und ein Fehler dort darf die lokale Sicherung nie entwerten.
    let second = backup::load_backup_settings(&paths.settings_path)
        .second_dir
        .map(|dir| {
            match backup::mirror_daily_backup(&result.path, Path::new(&dir), &today, &cutoff_date) {
                Ok(mirrored) => SecondBackupOutcome {
                    created: mirrored.created,
                    path: Some(mirrored.path.display().to_string()),
                    error: None,
                },
                Err(err) => SecondBackupOutcome {
                    created: false,
                    path: None,
                    error: Some(err.message),
                },
            }
        });

    Ok(DailyBackupResult {
        created: result.created,
        path: result.path.display().to_string(),
        second,
    })
}

/// Stand der Datensicherung für die Einstellungen: letzte Sicherungen und der
/// zweite Speicherort. Async, weil das Prüfen eines Netzlaufwerks dauern kann.
#[tauri::command]
pub async fn get_backup_status(paths: State<'_, StoragePaths>) -> Result<BackupStatus, ApiError> {
    Ok(backup::backup_status(
        &paths.backups_dir,
        &paths.settings_path,
    ))
}

/// Lässt den zweiten Speicherort über den nativen Ordner-Dialog wählen und
/// merkt ihn sich. Die App legt im gewählten Ordner einen eigenen Ordner an und
/// sichert nur dort. Bricht man den Dialog ab, bleibt alles wie es war.
#[tauri::command]
pub async fn choose_second_backup_dir(
    app: tauri::AppHandle,
    paths: State<'_, StoragePaths>,
) -> Result<BackupStatus, ApiError> {
    if let Some(picked) = app.dialog().file().blocking_pick_folder() {
        let dir = picked
            .into_path()
            .map_err(|_| ApiError::backup("Ungültiger Ordner"))?;
        backup::set_second_dir(
            &paths.settings_path,
            &paths.backups_dir,
            &dir,
            &backup::second_folder_name(),
        )?;
    }
    Ok(backup::backup_status(
        &paths.backups_dir,
        &paths.settings_path,
    ))
}

/// Entfernt den zweiten Speicherort. Bereits kopierte Sicherungen bleiben dort.
#[tauri::command]
pub async fn clear_second_backup_dir(
    paths: State<'_, StoragePaths>,
) -> Result<BackupStatus, ApiError> {
    backup::clear_second_dir(&paths.settings_path)?;
    Ok(backup::backup_status(
        &paths.backups_dir,
        &paths.settings_path,
    ))
}

/// „Jetzt sichern“: schreibt sofort eine Sicherung in den zweiten Speicherort.
/// Ist keiner eingerichtet, fragt sie wie das Menü „Backup“ nach dem Ziel.
#[tauri::command]
pub async fn backup_now(
    app: tauri::AppHandle,
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    paths: State<'_, StoragePaths>,
) -> Result<BackupResult, ApiError> {
    let Some(second_dir) = backup::load_backup_settings(&paths.settings_path).second_dir else {
        return create_backup(app, vault, db).await;
    };
    let keys = clone_keys(&vault)?;
    let (stamp, bytes) = {
        let state = db.lock()?;
        let conn = state.conn()?;
        (
            backup::manual_backup_stamp(conn)?,
            backup::create_backup_bytes(conn, &keys)?,
        )
    };
    // Wie bei der Tagessicherung läuft das Schreiben ohne Datenbanksperre: Ein
    // langsames Laufwerk soll die übrige App nicht aufhalten.
    let path = backup::write_manual_backup(Path::new(&second_dir), &stamp, &bytes)?;
    Ok(BackupResult {
        saved: true,
        path: Some(path.display().to_string()),
    })
}

/// Erstellt unmittelbar vor einem Update eine vollständige Sicherung: bevorzugt
/// im Ordner `Backups` neben der laufenden Programmdatei, sonst im Backup-Ordner
/// der App-Daten. Lässt sich an keinem der Orte eine vollständige Sicherung
/// schreiben, meldet der Command einen Fehler und verhindert dadurch die
/// Update-Installation.
#[tauri::command]
pub fn create_update_backup(
    target_version: String,
    vault: State<'_, Vault>,
    db: State<'_, Db>,
    paths: State<'_, StoragePaths>,
) -> Result<UpdateBackupResult, ApiError> {
    if target_version.trim().is_empty() || target_version.len() > 64 {
        return Err(ApiError::validation(
            "targetVersion",
            "Die Update-Version ist ungültig",
        ));
    }

    let targets = update_backup_targets(installation_dir(), &paths.backups_dir);

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
    let result = {
        let state = db.lock()?;
        backup::write_update_backup(
            state.conn()?,
            &keys,
            &targets,
            env!("CARGO_PKG_VERSION"),
            target_version.trim(),
        )?
    };
    Ok(UpdateBackupResult {
        path: result.path.display().to_string(),
        next_to_installation: result.next_to_installation,
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
    let validated = backup::validate_backup_bytes(
        &bytes,
        file_name,
        current_key.as_ref(),
        recovery_code.as_ref(),
    )?;

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
    sessions: State<'_, SecretSessions>,
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
    // Tokens dürfen eine ausgetauschte Datenbank bzw. einen ausgetauschten
    // Master-Key nicht überleben.
    sessions.clear()?;
    Ok(())
}

/// Bricht eine vorbereitete Wiederherstellung ab.
#[tauri::command]
pub fn cancel_restore(vault: State<'_, Vault>) -> Result<(), ApiError> {
    vault.lock()?.staged = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn secret_sessions_nutzen_zufaellige_fuechtige_tokens() {
        let sessions = SecretSessions::default();
        let first = sessions.begin().unwrap();
        let second = sessions.begin().unwrap();
        assert_ne!(first, second);
        assert_eq!(URL_SAFE_NO_PAD.decode(first.as_bytes()).unwrap().len(), 32);
        assert_eq!(URL_SAFE_NO_PAD.decode(second.as_bytes()).unwrap().len(), 32);
        sessions.require(&first).unwrap();
        sessions.require(&second).unwrap();

        sessions.end(&first).unwrap();
        let err = sessions.require(&first).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(err.field.as_deref(), Some("sessionToken"));
        // Andere Sitzungen bleiben gültig.
        sessions.require(&second).unwrap();

        // Ein neuer Prozesszustand kennt frühere Tokens nicht: Es gibt keine
        // Persistenz in SQLite, Dateisystem oder Schlüsselspeicher.
        let restarted = SecretSessions::default();
        assert_eq!(
            restarted.require(&second).unwrap_err().code,
            ErrorCode::Validation
        );
    }

    #[test]
    fn secret_session_end_und_clear_sind_strikt() {
        let sessions = SecretSessions::default();
        let a = sessions.begin().unwrap();
        let b = sessions.begin().unwrap();
        assert_eq!(
            sessions.end("ungueltig").unwrap_err().code,
            ErrorCode::Validation
        );
        sessions.clear().unwrap();
        assert_eq!(
            sessions.require(&a).unwrap_err().code,
            ErrorCode::Validation
        );
        assert_eq!(
            sessions.require(&b).unwrap_err().code,
            ErrorCode::Validation
        );
        assert_eq!(sessions.end(&a).unwrap_err().code, ErrorCode::Validation);
    }

    #[test]
    fn update_backup_hat_immer_den_datenordner_als_rueckfallebene() {
        let data_backups = PathBuf::from("/home/nutzer/.local/share/app/backups");

        // Beschreibbarer Installationsordner: erst dorthin, dann Datenordner.
        let install_dir = PathBuf::from("/home/nutzer/Anwendungen");
        let targets = update_backup_targets(Some(install_dir.clone()), &data_backups);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].dir, install_dir.join("Backups"));
        assert!(targets[0].next_to_installation);
        assert_eq!(targets[1].dir, data_backups);
        assert!(!targets[1].next_to_installation);

        // Unbekannter Installationsort: der Datenordner bleibt übrig, damit
        // ein Update nie ohne Sicherung dasteht.
        let targets = update_backup_targets(None, &data_backups);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].dir, data_backups);
        assert!(!targets[0].next_to_installation);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn systemweite_installationsorte_werden_uebersprungen() {
        let data_backups = PathBuf::from("/home/nutzer/.local/share/app/backups");

        // Paketinstallation (.deb): /usr/bin gehört root – kein Ablageort.
        for system_dir in [
            "/usr/bin",
            "/usr/lib/werkstatt-motion",
            "/opt/app",
            "/snap/x",
        ] {
            let targets = update_backup_targets(Some(PathBuf::from(system_dir)), &data_backups);
            assert_eq!(targets.len(), 1, "{system_dir} darf kein Ziel sein");
            assert_eq!(targets[0].dir, data_backups);
        }

        // Ein Ordner im Home des Nutzers (z. B. abgelegtes AppImage) zählt.
        let targets =
            update_backup_targets(Some(PathBuf::from("/home/nutzer/Apps")), &data_backups);
        assert_eq!(targets.len(), 2);
        assert!(targets[0].next_to_installation);
    }

    #[test]
    fn doppelter_ablageort_wird_nur_einmal_versucht() {
        // Portable Installation, deren Datenordner derselbe ist.
        let install_dir = PathBuf::from("/media/stick/werkstatt");
        let data_backups = install_dir.join("Backups");
        let targets = update_backup_targets(Some(install_dir), &data_backups);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].dir, data_backups);
        assert!(targets[0].next_to_installation);
    }
}
