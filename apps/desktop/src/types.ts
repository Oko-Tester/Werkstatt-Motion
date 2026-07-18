/** Fahrzeug, wie es das Rust-Backend liefert (SQLite). */
export interface Vehicle {
  id: string;
  customerName: string;
  vehicleName: string;
  licensePlate: string;
  note: string;
  tuvRequired: boolean;
  partsOrdered: boolean;
  partsArrived: boolean;
  isDone: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** Offene Zahlung. Beträge grundsätzlich als Integer in Cent. */
export interface Payment {
  id: string;
  customerName: string;
  amountCents: number;
  note: string;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  archivedAt: string | null;
}

/** Statusfelder, die per Ein-Klick umgeschaltet werden. */
export type VehicleStatusField = "tuvRequired" | "partsOrdered" | "partsArrived" | "isDone";

/** Direkt bearbeitbare Textfelder eines Fahrzeugs. */
export type VehicleTextField = "customerName" | "vehicleName" | "licensePlate" | "note";

/** Stabile fachliche IDs der verschiebbaren Fahrzeugspalten. */
export const VEHICLE_COLUMN_IDS = [
  "customerName",
  "vehicleName",
  "licensePlate",
  "tuvRequired",
  "partsOrdered",
  "partsArrived",
  "isDone",
  "note",
] as const;

export type VehicleColumnId = (typeof VEHICLE_COLUMN_IDS)[number];

/** Direkt bearbeitbare Textfelder einer Zahlung. */
export type PaymentTextField = "customerName" | "note";

/** Strukturierter Fehler aus dem Rust-Backend. */
export interface ApiError {
  code:
    | "validation"
    | "not_found"
    | "database"
    | "crypto"
    | "key_missing"
    | "keystore_unavailable"
    | "backup";
  message: string;
  field?: string;
}

/**
 * Versteckter Eintrag, wie ihn das Rust-Backend entschlüsselt liefert.
 * In SQLite liegen Name, Betrag und Notiz ausschließlich verschlüsselt.
 */
export interface HiddenEntry {
  id: string;
  name: string;
  amountCents: number;
  note: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** Neue, noch nicht gespeicherte Zeile im versteckten Bereich. */
export interface HiddenEntryDraft {
  draftId: string;
  name: string;
  amountCents: number | null;
  note: string;
}

/** Direkt bearbeitbare Textfelder eines versteckten Eintrags. */
export type HiddenTextField = "name" | "note";

/** Zustand des versteckten Bereichs (Schlüssel geladen oder Fehlerzustand). */
export interface HiddenStatus {
  unlocked: boolean;
  error?: ApiError;
}

/** Unveränderlicher fachlicher Snapshot eines abgeschlossenen Fahrzeugs. */
export interface VehicleHistory {
  id: string;
  sourceVehicleId: string;
  customerName: string;
  vehicleName: string;
  licensePlate: string;
  note: string;
  tuvRequired: boolean;
  partsOrdered: boolean;
  partsArrived: boolean;
  isDone: boolean;
  completedAt: string;
  archivedAt: string | null;
  vehicleCreatedAt: string;
  snapshotCreatedAt: string;
}

/** Entschlüsselte Ansicht eines verschlüsselten Secret-History-Snapshots. */
export interface SecretHistoryEntry {
  id: string;
  sourceHiddenEntryId: string;
  name: string;
  amountCents: number;
  note: string;
  completedOrArchivedAt: string;
  completedAt: string;
  createdAt: string;
}

/** Nicht geheime Kundenvorschläge ausschließlich aus Fahrzeugdaten. */
export interface CustomerSuggestion {
  id: string;
  customerName: string;
  vehicleName: string | null;
  licensePlate: string | null;
  lastUsedAt: string;
}

/** Persistente Oberflächenpräferenzen aus SQLite. */
export interface UiPreferences {
  paymentsPanelCollapsed: boolean;
  paymentsPanelHeight: number;
  vehicleColumnOrder: VehicleColumnId[];
  vehicleHiddenColumns: VehicleColumnId[];
}

/**
 * Neue, noch nicht gespeicherte Fahrzeugzeile. Sie lebt nur im Frontend,
 * bis die Pflichtfelder (Kunde und Fahrzeug oder Kennzeichen) gefüllt sind.
 */
export interface VehicleDraft {
  draftId: string;
  customerName: string;
  vehicleName: string;
  licensePlate: string;
  note: string;
  tuvRequired: boolean;
  partsOrdered: boolean;
  partsArrived: boolean;
  isDone: boolean;
}

/** Neue, noch nicht gespeicherte Zahlungszeile. */
export interface PaymentDraft {
  draftId: string;
  customerName: string;
  amountCents: number | null;
  note: string;
}

/** Fehlermeldungen je Zeile und Feld, direkt am Eingabefeld angezeigt. */
export type FieldErrors = Record<string, Record<string, string>>;
