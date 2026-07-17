import { invoke } from "@tauri-apps/api/core";
import type {
  ApiError,
  HiddenEntry,
  HiddenStatus,
  Payment,
  Vehicle,
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
  tuvRequired?: boolean;
  partsOrdered?: boolean;
  partsArrived?: boolean;
  isDone?: boolean;
}

export type VehiclePatch = Partial<
  Pick<Vehicle, "customerName" | "vehicleName" | "licensePlate">
>;

export interface NewPaymentInput {
  customerName: string;
  amountCents: number;
  note?: string;
}

export type PaymentPatch = Partial<Pick<Payment, "customerName" | "amountCents" | "note">>;

export function listVehicles(): Promise<Vehicle[]> {
  return invoke("list_vehicles");
}

export function createVehicle(input: NewVehicleInput): Promise<Vehicle> {
  return invoke("create_vehicle", { input });
}

export function updateVehicle(id: string, patch: VehiclePatch): Promise<Vehicle> {
  return invoke("update_vehicle", { id, patch });
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

export function listOpenPayments(): Promise<Payment[]> {
  return invoke("list_open_payments");
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

export function listHiddenEntries(): Promise<HiddenEntry[]> {
  return invoke("list_hidden_entries");
}

export function createHiddenEntry(input: NewHiddenEntryInput): Promise<HiddenEntry> {
  return invoke("create_hidden_entry", { input });
}

export function updateHiddenEntry(id: string, patch: HiddenEntryPatch): Promise<HiddenEntry> {
  return invoke("update_hidden_entry", { id, patch });
}

export function archiveHiddenEntry(id: string): Promise<HiddenEntry> {
  return invoke("archive_hidden_entry", { id });
}

export function restoreHiddenEntry(id: string): Promise<HiddenEntry> {
  return invoke("restore_hidden_entry", { id });
}

// ---------- Backup und Wiederherstellung ----------

export interface BackupResult {
  saved: boolean;
  path: string | null;
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
