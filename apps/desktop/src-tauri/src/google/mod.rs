//! Optionale Verbindung zu Google Kalender.
//!
//! Die App legt im Google-Konto einen eigenen Kalender „Werkstatt Motion“ an und
//! spiegelt dort die Termine der Fahrzeuge – nur in diese Richtung, nur zum
//! Ansehen. Geschrieben wird ausschließlich in diesen Kalender (Berechtigung
//! `calendar.app.created`); andere Kalender des Kontos kann die App weder lesen
//! noch ändern. Ohne Verbindung läuft sie wie bisher vollständig offline.
//!
//! Regeln:
//! - Der Abgleich ist immer vollständig: Aus den Fahrzeugen entsteht die Soll-Liste
//!   der Termine, aus Google die Ist-Liste, der Unterschied wird angewendet. Es gibt
//!   keine Warteschlange und keinen Zwischenstand; ein misslungener Lauf wird beim
//!   nächsten einfach nachgeholt.
//! - Das Anmelde-Token (Refresh-Token) liegt im Schlüsselspeicher des Betriebssystems,
//!   alles andere in `google.json` neben der Datenbank (wie `sicherung.json`).
//! - Jeder Netzaufruf läuft in Rust; die Oberfläche spricht nie mit Google.

mod api;
mod events;
mod oauth;
mod sync;
#[cfg(test)]
mod testing;

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::ApiError;
use crate::models::Vehicle;

pub use api::{ReqwestApi, Urls};
pub use oauth::open_in_browser;
pub use sync::{connect, disconnect, sync_now, Context};

use events::PreviewEvent;

/// Dateiname der Einstellungen neben der Datenbank.
pub const SETTINGS_FILE: &str = "google.json";

/// Name des Eintrags im Schlüsselspeicher des Betriebssystems.
pub const TOKEN_ENTRY: &str = "google-refresh-token";

/// Name des Kalenders bei Google.
pub const CALENDAR_NAME: &str = "Werkstatt Motion";

/// Beschreibung des Kalenders bei Google.
pub const CALENDAR_DESCRIPTION: &str =
    "Termine aus Werkstatt Motion. Nur zum Ansehen: Änderungen hier überschreibt die App beim nächsten Abgleich.";

/// Die einzige Kalender-Berechtigung: eigene Kalender anlegen und darin Termine verwalten.
pub const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.app.created";

/// So lange wartet die App auf die Anmeldung im Browser.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);

/// Zugangsdaten der App bei Google (OAuth-Client vom Typ „Desktop“). Bei Desktop-Apps sind
/// sie laut Google kein Geheimnis; sie stecken beim Bauen im Programm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCredentials {
    pub id: String,
    pub secret: String,
}

/// Die beim Bauen eingesetzten Zugangsdaten (`WERKSTATT_GOOGLE_CLIENT_ID` und
/// `WERKSTATT_GOOGLE_CLIENT_SECRET`). Ohne Kennung bleibt die Funktion aus.
pub fn client_credentials() -> Option<ClientCredentials> {
    let id = option_env!("WERKSTATT_GOOGLE_CLIENT_ID")?.trim();
    if id.is_empty() {
        return None;
    }
    let secret = option_env!("WERKSTATT_GOOGLE_CLIENT_SECRET")
        .unwrap_or("")
        .trim();
    Some(ClientCredentials {
        id: id.to_string(),
        secret: secret.to_string(),
    })
}

/// Was in den Terminen bei Google steht.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Content {
    /// Nur das Fahrzeug: Kundenname und Kennzeichen bleiben in der App.
    #[default]
    Short,
    /// Kunde, Fahrzeug und Kennzeichen.
    Full,
}

impl Content {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "short" => Some(Content::Short),
            "full" => Some(Content::Full),
            _ => None,
        }
    }
}

/// Einstellungen und Stand der Verbindung (ohne Geheimnisse), in `google.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct GoogleSettings {
    /// Das verbundene Google-Konto. Ohne Eintrag ist die App nicht verbunden.
    pub email: Option<String>,
    /// Kennung des Kalenders „Werkstatt Motion“ bei Google.
    pub calendar_id: Option<String>,
    pub content: Content,
    /// Ende des letzten gelungenen Abgleichs (Sekunden seit 1970).
    pub last_sync_at: Option<i64>,
    pub last_sync_count: Option<u32>,
    /// Meldung des letzten misslungenen Abgleichs; nach einem gelungenen leer.
    pub last_error: Option<String>,
    /// Der Zugang ist abgelaufen oder widerrufen: Der Nutzer muss neu verbinden.
    pub needs_reconnect: bool,
}

impl GoogleSettings {
    pub fn is_connected(&self) -> bool {
        self.email.is_some()
    }
}

/// Liest die Einstellungen. Fehlt die Datei oder ist sie unlesbar, gilt „nicht verbunden“.
pub fn load_settings(path: &Path) -> GoogleSettings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Schreibt die Einstellungen atomar: erst vollständig unter temporärem Namen, dann umbenennen.
pub fn save_settings(path: &Path, settings: &GoogleSettings) -> Result<(), ApiError> {
    let failed = || ApiError::google("Die Google-Einstellung konnte nicht gespeichert werden");
    let dir = path.parent().ok_or_else(failed)?;
    std::fs::create_dir_all(dir).map_err(|_| failed())?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| failed())?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|_| failed())?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|_| failed())?;
    file.persist(path).map_err(|_| failed())?;
    Ok(())
}

/// Alles, was schiefgehen kann – mit der Meldung, die der Nutzer liest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoogleError {
    /// Keine Verbindung zu Google (offline, Zeitüberschreitung, Zertifikat).
    Network,
    /// Die Anmeldung im Browser wurde nicht rechtzeitig abgeschlossen.
    Timeout,
    /// Der Nutzer hat die Anmeldung mit dem Knopf abgebrochen.
    Cancelled,
    /// Der Zugriff wurde in Google nicht erlaubt.
    Denied,
    /// Zugang widerrufen oder abgelaufen: neu verbinden.
    InvalidGrant,
    /// Google lehnt die Zugangs-ID dieser App ab.
    InvalidClient,
    /// Die Kalender-Schnittstelle ist im Google-Projekt der App nicht eingeschaltet.
    ApiDisabled,
    /// Kalender oder Termin gibt es bei Google nicht (mehr).
    NotFound,
    /// Google bremst vorübergehend.
    RateLimited,
    /// Das Häkchen für den Kalender wurde bei der Anmeldung nicht gesetzt.
    MissingCalendarAccess,
    /// Google hat keinen dauerhaften Zugang erteilt.
    NoLongTermAccess,
    /// Fehler auf Googles Seite (5xx).
    Server(u16),
    /// Google hat die Anfrage abgelehnt (4xx, nicht weiter eingeordnet).
    Rejected(u16),
    /// Lokaler Anschluss für die Anmeldung nicht verfügbar.
    Local,
}

impl GoogleError {
    pub fn message(&self) -> String {
        match self {
            GoogleError::Network => {
                "Keine Verbindung zu Google. Der nächste Versuch läuft automatisch.".to_string()
            }
            GoogleError::Timeout => "Die Anmeldung bei Google wurde nicht rechtzeitig \
                                     abgeschlossen. Bitte noch einmal verbinden."
                .to_string(),
            GoogleError::Cancelled => "Die Anmeldung wurde abgebrochen.".to_string(),
            GoogleError::Denied => "Der Zugriff wurde in Google nicht erlaubt.".to_string(),
            GoogleError::InvalidGrant => "Die Verbindung zu Google ist abgelaufen oder wurde \
                                          widerrufen. Bitte neu verbinden."
                .to_string(),
            GoogleError::InvalidClient => "Google hat die Zugangs-ID dieser App abgelehnt. \
                                           Diese Version ist nicht richtig eingerichtet."
                .to_string(),
            GoogleError::ApiDisabled => "Die Kalender-Schnittstelle ist im Google-Projekt dieser \
                                         App nicht eingeschaltet."
                .to_string(),
            GoogleError::NotFound => {
                "Der Kalender oder Termin existiert bei Google nicht (mehr).".to_string()
            }
            GoogleError::RateLimited => "Google hat die Anfragen vorübergehend begrenzt. Der \
                                         nächste Versuch läuft automatisch."
                .to_string(),
            GoogleError::MissingCalendarAccess => "Der Zugriff auf den Kalender wurde in Google \
                                                   nicht erlaubt. Bitte neu verbinden und alle \
                                                   Häkchen setzen."
                .to_string(),
            GoogleError::NoLongTermAccess => {
                "Google hat keinen dauerhaften Zugang erteilt. Bitte neu verbinden.".to_string()
            }
            GoogleError::Server(code) => format!(
                "Google meldet einen Fehler ({code}). Der nächste Versuch läuft automatisch."
            ),
            GoogleError::Rejected(code) => format!("Google hat die Anfrage abgelehnt ({code})."),
            GoogleError::Local => {
                "Die Anmeldung konnte auf diesem Computer nicht gestartet werden.".to_string()
            }
        }
    }

    /// Hilft nur noch eine neue Anmeldung?
    pub fn needs_reconnect(&self) -> bool {
        matches!(
            self,
            GoogleError::InvalidGrant
                | GoogleError::MissingCalendarAccess
                | GoogleError::NoLongTermAccess
        )
    }
}

impl From<GoogleError> for ApiError {
    fn from(error: GoogleError) -> Self {
        ApiError::google(&error.message())
    }
}

/// Ablage des Anmelde-Tokens. In der App der Schlüsselspeicher des Betriebssystems.
pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<Zeroizing<String>>, ApiError>;
    fn save(&self, token: &str) -> Result<(), ApiError>;
    fn clear(&self) -> Result<(), ApiError>;
}

/// Gemeinsamer Zustand der Google-Befehle.
#[derive(Default)]
pub struct GoogleState {
    /// Nur ein Lauf gleichzeitig: Anmelden, Abgleichen, Trennen.
    pub gate: tokio::sync::Mutex<()>,
    pending: Mutex<Option<Pending>>,
}

struct Pending {
    url: String,
    cancel: Arc<AtomicBool>,
}

/// Hält fest, dass eine Anmeldung im Browser läuft, und räumt beim Verlassen auf.
pub struct PendingGuard<'a> {
    state: &'a GoogleState,
    pub cancel: Arc<AtomicBool>,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.state.pending.lock() {
            *pending = None;
        }
    }
}

impl GoogleState {
    /// Meldet die laufende Anmeldung an. Läuft schon eine, ist das ein Fehler.
    pub fn begin_pending(&self, url: &str) -> Result<PendingGuard<'_>, ApiError> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| ApiError::google("Die Anmeldung ist nicht verfügbar"))?;
        if pending.is_some() {
            return Err(ApiError::google("Die Anmeldung bei Google läuft schon"));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *pending = Some(Pending {
            url: url.to_string(),
            cancel: Arc::clone(&cancel),
        });
        Ok(PendingGuard {
            state: self,
            cancel,
        })
    }

    /// Die Adresse der laufenden Anmeldung – zum Kopieren, falls sich der Browser nicht öffnet.
    pub fn pending_url(&self) -> Option<String> {
        self.pending
            .lock()
            .ok()?
            .as_ref()
            .map(|pending| pending.url.clone())
    }

    /// Bricht eine laufende Anmeldung ab. Ohne laufende Anmeldung passiert nichts.
    pub fn cancel(&self) {
        if let Ok(pending) = self.pending.lock() {
            if let Some(pending) = pending.as_ref() {
                pending
                    .cancel
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }
}

/// Stand für die Oberfläche.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    /// Enthält diese Version die Zugangs-ID? Sonst ist die Funktion nicht verfügbar.
    pub configured: bool,
    pub connected: bool,
    pub email: Option<String>,
    pub content: Content,
    pub last_sync_at: Option<i64>,
    pub last_sync_count: Option<u32>,
    pub last_error: Option<String>,
    pub needs_reconnect: bool,
    /// Alle Termine, wie sie bei Google stehen würden, nach Zeit sortiert.
    pub events: Vec<PreviewEvent>,
}

pub fn build_status(
    settings: &GoogleSettings,
    configured: bool,
    vehicles: &[Vehicle],
) -> GoogleStatus {
    GoogleStatus {
        configured,
        connected: settings.is_connected(),
        email: settings.email.clone(),
        content: settings.content,
        last_sync_at: settings.last_sync_at,
        last_sync_count: settings.last_sync_count,
        last_error: settings.last_error.clone(),
        needs_reconnect: settings.needs_reconnect,
        events: events::build_events(vehicles, settings.content)
            .iter()
            .map(PreviewEvent::from)
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn einstellungen_ueberstehen_speichern_und_laden() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE);
        assert_eq!(load_settings(&path), GoogleSettings::default());

        let settings = GoogleSettings {
            email: Some("kollege@example.com".to_string()),
            calendar_id: Some("abc@group.calendar.google.com".to_string()),
            content: Content::Full,
            last_sync_at: Some(1_700_000_000),
            last_sync_count: Some(3),
            last_error: Some("Keine Verbindung".to_string()),
            needs_reconnect: true,
        };
        save_settings(&path, &settings).unwrap();
        assert_eq!(load_settings(&path), settings);

        // Überschreiben ersetzt die Datei vollständig und hinterlässt keine Reste.
        save_settings(&path, &GoogleSettings::default()).unwrap();
        assert_eq!(load_settings(&path), GoogleSettings::default());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![SETTINGS_FILE.to_string()]);
    }

    #[test]
    fn kaputte_oder_fremde_datei_heisst_nicht_verbunden() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE);
        std::fs::write(&path, b"das ist kein json").unwrap();
        assert!(!load_settings(&path).is_connected());
        std::fs::write(&path, br#"{"email": 5}"#).unwrap();
        assert!(!load_settings(&path).is_connected());
    }

    #[test]
    fn fehlende_felder_bekommen_standardwerte() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE);
        std::fs::write(&path, br#"{"email": "a@b.de", "content": "full"}"#).unwrap();
        let settings = load_settings(&path);
        assert_eq!(settings.email.as_deref(), Some("a@b.de"));
        assert_eq!(settings.content, Content::Full);
        assert!(!settings.needs_reconnect);
        assert_eq!(settings.calendar_id, None);
    }

    #[test]
    fn inhalt_wird_nur_aus_bekannten_werten_gelesen() {
        assert_eq!(Content::parse("short"), Some(Content::Short));
        assert_eq!(Content::parse("full"), Some(Content::Full));
        assert_eq!(Content::parse("alles"), None);
        assert_eq!(Content::default(), Content::Short);
    }

    #[test]
    fn meldungen_sind_deutsch_und_ohne_technische_details() {
        for error in [
            GoogleError::Network,
            GoogleError::Timeout,
            GoogleError::Cancelled,
            GoogleError::Denied,
            GoogleError::InvalidGrant,
            GoogleError::InvalidClient,
            GoogleError::ApiDisabled,
            GoogleError::NotFound,
            GoogleError::RateLimited,
            GoogleError::MissingCalendarAccess,
            GoogleError::NoLongTermAccess,
            GoogleError::Server(503),
            GoogleError::Rejected(400),
            GoogleError::Local,
        ] {
            let message = error.message();
            assert!(!message.is_empty());
            assert!(!message.to_lowercase().contains("token"), "{message}");
            assert_eq!(ApiError::from(error).message, message);
        }
        assert!(GoogleError::InvalidGrant.needs_reconnect());
        assert!(!GoogleError::Network.needs_reconnect());
    }

    #[test]
    fn nur_eine_anmeldung_gleichzeitig_und_abbrechen_wirkt() {
        let state = GoogleState::default();
        assert_eq!(state.pending_url(), None);
        let guard = state.begin_pending("https://example.test/auth").unwrap();
        assert_eq!(
            state.pending_url().as_deref(),
            Some("https://example.test/auth")
        );
        assert!(state.begin_pending("https://example.test/zweite").is_err());

        assert!(!guard.cancel.load(std::sync::atomic::Ordering::SeqCst));
        state.cancel();
        assert!(guard.cancel.load(std::sync::atomic::Ordering::SeqCst));

        drop(guard);
        assert_eq!(state.pending_url(), None);
        state.cancel();
        assert!(state.begin_pending("https://example.test/neu").is_ok());
    }
}
