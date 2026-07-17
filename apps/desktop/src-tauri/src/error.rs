use serde::Serialize;

/// Strukturierter Fehler für das Frontend: Code für die Fallunterscheidung,
/// Meldung für die Anzeige, optionales Feld für Validierungsfehler am Eingabefeld.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Validation,
    NotFound,
    Database,
    /// Ver- oder Entschlüsselung fehlgeschlagen (z. B. manipulierte Daten).
    Crypto,
    /// Schlüssel fehlt, obwohl bereits verschlüsselte Daten existieren.
    KeyMissing,
    /// Der Schlüsselspeicher des Betriebssystems ist nicht erreichbar.
    KeystoreUnavailable,
    /// Backup ist ungültig, beschädigt oder nicht lesbar.
    Backup,
}

impl ApiError {
    pub fn validation(field: &str, message: &str) -> Self {
        Self {
            code: ErrorCode::Validation,
            message: message.to_string(),
            field: Some(field.to_string()),
        }
    }

    pub fn not_found(message: &str) -> Self {
        Self {
            code: ErrorCode::NotFound,
            message: message.to_string(),
            field: None,
        }
    }

    pub fn database(message: &str) -> Self {
        Self {
            code: ErrorCode::Database,
            message: message.to_string(),
            field: None,
        }
    }

    /// Bewusst ohne Details: Krypto-Fehlermeldungen dürfen weder Klartext
    /// noch Schlüsselmaterial noch Herstellerdetails enthalten.
    pub fn crypto() -> Self {
        Self {
            code: ErrorCode::Crypto,
            message: "Verschlüsselte Daten konnten nicht verarbeitet werden".to_string(),
            field: None,
        }
    }

    pub fn key_missing() -> Self {
        Self {
            code: ErrorCode::KeyMissing,
            message: "Schlüssel nicht gefunden, aber es existieren bereits verschlüsselte \
                      Einträge. Es wird kein neuer Schlüssel erzeugt, um die Daten nicht \
                      unlesbar zu machen."
                .to_string(),
            field: None,
        }
    }

    pub fn keystore_unavailable() -> Self {
        Self {
            code: ErrorCode::KeystoreUnavailable,
            message: "Der Schlüsselspeicher des Betriebssystems ist nicht erreichbar".to_string(),
            field: None,
        }
    }

    pub fn backup(message: &str) -> Self {
        Self {
            code: ErrorCode::Backup,
            message: message.to_string(),
            field: None,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        ApiError::database(&format!("Datenbankfehler: {err}"))
    }
}
