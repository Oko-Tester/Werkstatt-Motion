import { invoke } from "@tauri-apps/api/core";
import type { ApiError, Payment, Vehicle, VehicleStatusField } from "./types";

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
