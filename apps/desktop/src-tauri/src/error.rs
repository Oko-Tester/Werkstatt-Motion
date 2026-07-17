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
