use serde::{Deserialize, Serialize};

/// Fahrzeug, wie es in der Datenbank liegt und ans Frontend geht.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    pub id: String,
    pub customer_name: String,
    pub vehicle_name: String,
    pub license_plate: String,
    pub tuv_required: bool,
    pub parts_ordered: bool,
    pub parts_arrived: bool,
    pub is_done: bool,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

/// Unveränderlicher fachlicher Stand beim ersten Abschluss eines Fahrzeugs.
/// Nur `archived_at` darf später einmalig ergänzt werden.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VehicleHistory {
    pub id: String,
    pub source_vehicle_id: String,
    pub customer_name: String,
    pub vehicle_name: String,
    pub license_plate: String,
    pub tuv_required: bool,
    pub parts_ordered: bool,
    pub parts_arrived: bool,
    pub is_done: bool,
    pub completed_at: String,
    pub archived_at: Option<String>,
    pub vehicle_created_at: String,
    pub snapshot_created_at: String,
}

/// Nicht geheime Kundenvorschläge aus Fahrzeugbestand und Fahrzeughistorie.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomerSuggestion {
    pub id: String,
    pub customer_name: String,
    pub vehicle_name: Option<String>,
    pub license_plate: Option<String>,
    pub last_used_at: String,
}

/// Persistente, versionierte Oberflächenpräferenzen.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferences {
    pub payments_panel_collapsed: bool,
    pub vehicle_column_order: Vec<String>,
}

/// Eingabe für ein neues Fahrzeug. Statusfelder dürfen bereits gesetzt sein,
/// weil die Entwurfszeile im Frontend vor dem Speichern umgeschaltet werden kann.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewVehicle {
    pub customer_name: String,
    #[serde(default)]
    pub vehicle_name: String,
    #[serde(default)]
    pub license_plate: String,
    #[serde(default)]
    pub tuv_required: bool,
    #[serde(default)]
    pub parts_ordered: bool,
    #[serde(default)]
    pub parts_arrived: bool,
    #[serde(default)]
    pub is_done: bool,
}

/// Teil-Aktualisierung der Textfelder eines Fahrzeugs.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehiclePatch {
    pub customer_name: Option<String>,
    pub vehicle_name: Option<String>,
    pub license_plate: Option<String>,
}

/// Statusfelder, die mit einem Klick umgeschaltet werden.
/// Es gibt bewusst keine automatischen Folgeänderungen zwischen den Feldern.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VehicleStatusField {
    TuvRequired,
    PartsOrdered,
    PartsArrived,
    IsDone,
}

impl VehicleStatusField {
    pub fn column(self) -> &'static str {
        match self {
            VehicleStatusField::TuvRequired => "tuv_required",
            VehicleStatusField::PartsOrdered => "parts_ordered",
            VehicleStatusField::PartsArrived => "parts_arrived",
            VehicleStatusField::IsDone => "is_done",
        }
    }
}

/// Offene Zahlung. Beträge liegen grundsätzlich als Cent-Integer vor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Payment {
    pub id: String,
    pub customer_name: String,
    pub amount_cents: i64,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    pub paid_at: Option<String>,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPayment {
    pub customer_name: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentPatch {
    pub customer_name: Option<String>,
    pub amount_cents: Option<i64>,
    pub note: Option<String>,
}

/// Versteckter Eintrag, wie er entschlüsselt ans Frontend geht. In der
/// Datenbank liegen Name, Betrag und Notiz ausschließlich verschlüsselt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HiddenEntry {
    pub id: String,
    pub name: String,
    pub amount_cents: i64,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

/// Entschlüsselte Ansicht eines unveränderlichen Secret-History-Snapshots.
/// Die fachlichen Felder liegen in SQLite ausschließlich verschlüsselt vor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretHistoryEntry {
    pub id: String,
    pub source_hidden_entry_id: String,
    pub name: String,
    pub amount_cents: i64,
    pub note: String,
    pub completed_or_archived_at: String,
    pub completed_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHiddenEntry {
    pub name: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenEntryPatch {
    pub name: Option<String>,
    pub amount_cents: Option<i64>,
    pub note: Option<String>,
}
