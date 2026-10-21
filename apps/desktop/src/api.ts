import { invoke } from "@tauri-apps/api/core";
import type {
  ApiError,
  CustomerSuggestion,
  HiddenEntry,
  HiddenStatus,
  Payment,
  SecretHistoryEntry,
  UiPreferences,
  Vehicle,
  VehicleColumnId,
  VehicleHistory,
  VehicleStatusField,
} from "./types";

/**
 * Einzige Stelle, an der das Frontend mit dem Rust-Backend spricht.
 * Alle Datenbankzugriffe laufen über diese Tauri-Commands.
 */

export interface NewVehicleInput {
  customerName: string;
  vehicleName?: string;
  licensePlate?: string;
  note?: string;
  tuvRequired?: boolean;
  partsOrdered?: boolean;
  partsArrived?: boolean;
  isDone?: boolean;
  /** Optionaler Werkstatttermin, der gleich mit dem Fahrzeug gespeichert wird. */
  appointmentAt?: string | null;
}

export type VehiclePatch = Partial<
  Pick<Vehicle, "customerName" | "vehicleName" | "licensePlate" | "note">
>;

export interface NewPaymentInput {
  vehicleId?: string | null;
  customerName: string;
  amountCents: number;
  note?: string;
}

export type PaymentPatch = Partial<
  Pick<Payment, "vehicleId" | "customerName" | "amountCents" | "note">
>;

export function listVehicles(): Promise<Vehicle[]> {
  return invoke("list_vehicles");
}

export function createVehicle(input: NewVehicleInput): Promise<Vehicle> {
  return invoke("create_vehicle", { input });
}

export function updateVehicle(id: string, patch: VehiclePatch): Promise<Vehicle> {
  return invoke("update_vehicle", { id, patch });
}

export function updateVehicleAppointment(
  id: string,
  appointmentAt: string | null,
): Promise<Vehicle> {
  return invoke("update_vehicle_appointment", { id, appointmentAt });
}

export function updateVehicleStatus(
  id: string,
  field: VehicleStatusField,
  value: boolean,
): Promise<Vehicle> {
  return invoke("update_vehicle_status", { id, field, value });
}

export function reorderVehicles(ids: string[]): Promise<Vehicle[]> {
  return invoke("reorder_vehicles", { ids });
}

export function archiveVehicle(id: string): Promise<Vehicle> {
  return invoke("archive_vehicle", { id });
}

export function restoreVehicle(id: string): Promise<Vehicle> {
  return invoke("restore_vehicle", { id });
}

export function listCompletedVehicleHistory(): Promise<VehicleHistory[]> {
  return invoke("list_completed_vehicle_history");
}

export function listCustomerSuggestions(): Promise<CustomerSuggestion[]> {
  return invoke("list_customer_suggestions");
}

export function getUiPreferences(): Promise<UiPreferences> {
  return invoke("get_ui_preferences");
}

export function updatePaymentsPanelCollapsed(collapsed: boolean): Promise<UiPreferences> {
  return invoke("update_payments_panel_collapsed", { collapsed });
}

export function updatePaymentsPanelHeight(height: number): Promise<UiPreferences> {
  return invoke("update_payments_panel_height", { height });
}

export function updateVehicleColumnOrder(columnOrder: VehicleColumnId[]): Promise<UiPreferences> {
  return invoke("update_vehicle_column_order", { columnOrder });
}

export function updateVehicleHiddenColumns(
  hiddenColumns: VehicleColumnId[],
): Promise<UiPreferences> {
  return invoke("update_vehicle_hidden_columns", { hiddenColumns });
}

export function listOpenPayments(): Promise<Payment[]> {
  return invoke("list_open_payments");
}

export function listPaidPayments(): Promise<Payment[]> {
  return invoke("list_paid_payments");
}

export function createPayment(input: NewPaymentInput): Promise<Payment> {
  return invoke("create_payment", { input });
}

export function updatePayment(id: string, patch: PaymentPatch): Promise<Payment> {
  return invoke("update_payment", { id, patch });
}

export function markPaymentPaid(id: string): Promise<Payment> {
  return invoke("mark_payment_paid", { id });
}

export function restorePayment(id: string): Promise<Payment> {
  return invoke("restore_payment", { id });
}

// ---------- Versteckter Bereich ----------

export interface NewHiddenEntryInput {
  name: string;
  amountCents: number;
  note?: string;
}

export type HiddenEntryPatch = Partial<Pick<HiddenEntry, "name" | "amountCents" | "note">>;

export function hiddenStatus(): Promise<HiddenStatus> {
  return invoke("hidden_status");
}

/** Erstellt eine flüchtige Klartext-Sitzung; der Token bleibt ausschließlich im React-State. */
export function beginSecretSession(): Promise<string> {
  return invoke("begin_secret_session");
}

export function endSecretSession(sessionToken: string): Promise<void> {
  return invoke("end_secret_session", { sessionToken });
}

export function listHiddenEntries(sessionToken: string): Promise<HiddenEntry[]> {
  return invoke("list_hidden_entries", { sessionToken });
}

export function createHiddenEntry(
  sessionToken: string,
  input: NewHiddenEntryInput,
): Promise<HiddenEntry> {
  return invoke("create_hidden_entry", { sessionToken, input });
}

export function updateHiddenEntry(
  sessionToken: string,
  id: string,
  patch: HiddenEntryPatch,
): Promise<HiddenEntry> {
  return invoke("update_hidden_entry", { sessionToken, id, patch });
}

export function archiveHiddenEntry(sessionToken: string, id: string): Promise<HiddenEntry> {
  return invoke("archive_hidden_entry", { sessionToken, id });
}

export function restoreHiddenEntry(sessionToken: string, id: string): Promise<HiddenEntry> {
  return invoke("restore_hidden_entry", { sessionToken, id });
}

/** Fachlich benannter Client für den bevorzugten Rust-Command. */
export function listEncryptedSecretHistory(sessionToken: string): Promise<SecretHistoryEntry[]> {
  return invoke("list_hidden_entry_history", { sessionToken });
}

// ---------- Backup und Wiederherstellung ----------

export interface BackupResult {
  saved: boolean;
  path: string | null;
}

export interface UpdateBackupResult {
  path: string;
  /** false, wenn die Sicherung im Datenordner statt neben der Installation liegt. */
  nextToInstallation: boolean;
}

/** Ergebnis der Kopie in den zweiten Speicherort. */
export interface SecondBackupResult {
  /** true, wenn heute eine neue Kopie geschrieben wurde. */
  created: boolean;
  path: string | null;
  /** Grund, falls der zweite Ordner gerade nicht erreichbar ist. */
  error: string | null;
}

export interface DailyBackupResult {
  created: boolean;
  path: string;
  /** `null`, wenn kein zweiter Speicherort eingerichtet ist. */
  second: SecondBackupResult | null;
}

/** Stand der Datensicherung für die Einstellungen. */
export interface BackupStatus {
  /** Ordner der automatischen Sicherung auf diesem Computer. */
  localDir: string;
  /** Zeitpunkt der letzten Tagessicherung (Millisekunden seit 1970). */
  localLastAt: number | null;
  retentionDays: number;
  secondDir: string | null;
  /** Zeitpunkt der letzten Sicherung im zweiten Ordner (Millisekunden seit 1970). */
  secondLastAt: number | null;
  /** Grund, falls der zweite Ordner gerade nicht erreichbar ist. */
  secondError: string | null;
}

export interface RestorePreview {
  cancelled: boolean;
  createdAt: string | null;
  fileName: string | null;
  vehicleCount: number | null;
  paymentCount: number | null;
  hiddenCount: number | null;
}

/** Öffnet den nativen Speichern-Dialog und schreibt die Backup-Datei. */
export function createBackup(): Promise<BackupResult> {
  return invoke("create_backup");
}

/**
 * Erstellt höchstens ein automatisches Backup pro lokalem Kalendertag und
 * kopiert es – falls eingerichtet – in den zweiten Speicherort.
 */
export function createDailyBackup(): Promise<DailyBackupResult> {
  return invoke("create_daily_backup");
}

/** Letzte Sicherungen und zweiter Speicherort, gelesen aus den Dateien selbst. */
export function getBackupStatus(): Promise<BackupStatus> {
  return invoke("get_backup_status");
}

/** Öffnet den nativen Ordner-Dialog für den zweiten Speicherort. */
export function chooseSecondBackupDir(): Promise<BackupStatus> {
  return invoke("choose_second_backup_dir");
}

/** Entfernt den zweiten Speicherort; bereits kopierte Sicherungen bleiben dort. */
export function clearSecondBackupDir(): Promise<BackupStatus> {
  return invoke("clear_second_backup_dir");
}

/**
 * „Jetzt sichern“: schreibt sofort in den zweiten Speicherort. Ohne ihn fragt
 * sie wie `createBackup` über den Speichern-Dialog nach dem Ziel.
 */
export function backupNow(): Promise<BackupResult> {
  return invoke("backup_now");
}

/**
 * Sichert die Daten vor einem Update – bevorzugt neben der installierten
 * Programmdatei, sonst im Backup-Ordner der App-Daten.
 */
export function createUpdateBackup(targetVersion: string): Promise<UpdateBackupResult> {
  return invoke("create_update_backup", { targetVersion });
}

/** Öffnet den nativen Datei-Dialog und validiert das gewählte Backup. */
export function prepareRestore(): Promise<RestorePreview> {
  return invoke("prepare_restore");
}

/** Führt die zuvor validierte Wiederherstellung aus. */
export function confirmRestore(): Promise<void> {
  return invoke("confirm_restore");
}

export function cancelRestore(): Promise<void> {
  return invoke("cancel_restore");
}

/** Macht aus einem unbekannten Fehler einen anzeigbaren ApiError. */
export function toApiError(err: unknown): ApiError {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return err as ApiError;
  }
  return { code: "database", message: "Speichern fehlgeschlagen" };
}
