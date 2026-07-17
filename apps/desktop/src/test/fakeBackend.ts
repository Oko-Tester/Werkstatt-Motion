import { mockIPC } from "@tauri-apps/api/mocks";
import type { ApiError, HiddenEntry, Payment, Vehicle } from "../types";

/**
 * In-Memory-Nachbildung des Rust-Backends für Frontend-Tests.
 * Semantik (Validierung, Normalisierung, Positionen) entspricht src-tauri/src/db.rs.
 */

export interface VehicleSeed {
  customerName: string;
  vehicleName?: string;
  licensePlate?: string;
  tuvRequired?: boolean;
  partsOrdered?: boolean;
  partsArrived?: boolean;
  isDone?: boolean;
}

export interface PaymentSeed {
  customerName: string;
  amountCents: number;
  note?: string;
}

export interface HiddenSeed {
  name: string;
  amountCents: number;
  note?: string;
}

/** Zustand der Fake-Datenbank für Backup-Snapshots. */
interface Snapshot {
  createdAt: string;
  vehicles: Vehicle[];
  payments: Payment[];
  hiddenEntries: HiddenEntry[];
}

export interface FakeBackend {
  /** Alle Fahrzeuge inklusive archivierter. */
  vehicles: Vehicle[];
  /** Alle Zahlungen inklusive bezahlter. */
  payments: Payment[];
  /** Alle versteckten Einträge inklusive archivierter (im Fake im Klartext –
   *  die echte Verschlüsselung ist im Rust-Backend getestet). */
  hiddenEntries: HiddenEntry[];
  /** Erstellte Backups (Snapshots) in Reihenfolge. */
  backups: Snapshot[];
  /** Aufgerufene Commands in Reihenfolge. */
  calls: string[];
  /** Lässt den nächsten Aufruf des Commands mit einem Fehler scheitern. */
  planFailure: (cmd: string, error?: ApiError) => void;
  /** Simuliert einen abgebrochenen nativen Dialog für den nächsten Aufruf. */
  planCancel: (cmd: "create_backup" | "prepare_restore") => void;
}

function validationError(field: string, message: string): ApiError {
  return { code: "validation", message, field };
}

function notFound(message: string): ApiError {
  return { code: "not_found", message };
}

function normalizeLicensePlate(input: string): string {
  return input.split(/\s+/).filter(Boolean).join(" ").toUpperCase();
}

function validateVehicleText(customerName: string, vehicleName: string, licensePlate: string) {
  if (customerName.trim() === "") {
    throw validationError("customerName", "Kunde darf nicht leer sein");
  }
  if (vehicleName.trim() === "" && licensePlate.trim() === "") {
    throw validationError("vehicleName", "Fahrzeug oder Kennzeichen angeben");
  }
}

function validatePaymentValues(customerName: string, amountCents: number) {
  if (customerName.trim() === "") {
    throw validationError("customerName", "Kunde darf nicht leer sein");
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw validationError("amountCents", "Betrag muss größer als 0 sein");
  }
}

function validateHiddenValues(name: string, amountCents: number) {
  if (name.trim() === "") {
    throw validationError("name", "Bezeichnung darf nicht leer sein");
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw validationError("amountCents", "Betrag muss größer als 0 sein");
  }
}

export function installFakeBackend(seed?: {
  vehicles?: VehicleSeed[];
  payments?: PaymentSeed[];
  hidden?: HiddenSeed[];
  /** Simuliert einen Fehlerzustand der Schlüsselverwaltung. */
  hiddenError?: ApiError;
}): FakeBackend {
  let idCounter = 0;
  let clock = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;
  const nextTimestamp = () => new Date(1700000000000 + ++clock * 1000).toISOString();

  const vehicles: Vehicle[] = (seed?.vehicles ?? []).map((entry, index) => {
    const timestamp = nextTimestamp();
    return {
      id: nextId("v"),
      customerName: entry.customerName,
      vehicleName: entry.vehicleName ?? "",
      licensePlate: entry.licensePlate ?? "",
      tuvRequired: entry.tuvRequired ?? false,
      partsOrdered: entry.partsOrdered ?? false,
      partsArrived: entry.partsArrived ?? false,
      isDone: entry.isDone ?? false,
      position: index,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
  });

  const payments: Payment[] = (seed?.payments ?? []).map((entry) => {
    const timestamp = nextTimestamp();
    return {
      id: nextId("p"),
      customerName: entry.customerName,
      amountCents: entry.amountCents,
      note: entry.note ?? "",
      createdAt: timestamp,
      updatedAt: timestamp,
      paidAt: null,
      archivedAt: null,
    };
  });

  const hiddenEntries: HiddenEntry[] = (seed?.hidden ?? []).map((entry) => {
    const timestamp = nextTimestamp();
    return {
      id: nextId("h"),
      name: entry.name,
      amountCents: entry.amountCents,
      note: entry.note ?? "",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
  });

  const backups: Snapshot[] = [];
  let stagedRestore: Snapshot | null = null;

  const calls: string[] = [];
  const failures = new Map<string, ApiError>();
  const cancels = new Set<string>();

  function requireHiddenAccess() {
    if (seed?.hiddenError) {
      throw seed.hiddenError;
    }
  }

  function findHiddenEntry(id: string): HiddenEntry {
    const entry = hiddenEntries.find((item) => item.id === id);
    if (!entry) {
      throw notFound("Eintrag nicht gefunden");
    }
    return entry;
  }

  function listHiddenEntries(): HiddenEntry[] {
    return hiddenEntries
      .filter((entry) => entry.archivedAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((entry) => ({ ...entry }));
  }

  function takeSnapshot(): Snapshot {
    return {
      createdAt: nextTimestamp(),
      vehicles: vehicles.map((entry) => ({ ...entry })),
      payments: payments.map((entry) => ({ ...entry })),
      hiddenEntries: hiddenEntries.map((entry) => ({ ...entry })),
    };
  }

  function applySnapshot(snapshot: Snapshot) {
    vehicles.splice(0, vehicles.length, ...snapshot.vehicles.map((entry) => ({ ...entry })));
    payments.splice(0, payments.length, ...snapshot.payments.map((entry) => ({ ...entry })));
    hiddenEntries.splice(
      0,
      hiddenEntries.length,
      ...snapshot.hiddenEntries.map((entry) => ({ ...entry })),
    );
  }

  function findVehicle(id: string): Vehicle {
    const vehicle = vehicles.find((entry) => entry.id === id);
    if (!vehicle) {
      throw notFound("Fahrzeug nicht gefunden");
    }
    return vehicle;
  }

  function findPayment(id: string): Payment {
    const payment = payments.find((entry) => entry.id === id);
    if (!payment) {
      throw notFound("Zahlung nicht gefunden");
    }
    return payment;
  }

  function listVehicles(): Vehicle[] {
    return vehicles
      .filter((entry) => entry.archivedAt === null)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
      .map((entry) => ({ ...entry }));
  }

  function listOpenPayments(): Payment[] {
    return payments
      .filter((entry) => entry.paidAt === null && entry.archivedAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((entry) => ({ ...entry }));
  }

  mockIPC((cmd, payload) => {
    calls.push(cmd);
    const planned = failures.get(cmd);
    if (planned) {
      failures.delete(cmd);
      throw planned;
    }
    const args = (payload ?? {}) as Record<string, unknown>;

    switch (cmd) {
      case "list_vehicles":
        return listVehicles();
      case "create_vehicle": {
        const input = args.input as Record<string, unknown>;
        const customerName = String(input.customerName ?? "").trim();
        const vehicleName = String(input.vehicleName ?? "").trim();
        const licensePlate = normalizeLicensePlate(String(input.licensePlate ?? ""));
        validateVehicleText(customerName, vehicleName, licensePlate);
        const timestamp = nextTimestamp();
        const vehicle: Vehicle = {
          id: nextId("v"),
          customerName,
          vehicleName,
          licensePlate,
          tuvRequired: Boolean(input.tuvRequired),
          partsOrdered: Boolean(input.partsOrdered),
          partsArrived: Boolean(input.partsArrived),
          isDone: Boolean(input.isDone),
          position: Math.min(0, ...vehicles.map((entry) => entry.position)) - 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        };
        vehicles.push(vehicle);
        return { ...vehicle };
      }
      case "update_vehicle": {
        const vehicle = findVehicle(String(args.id));
        const patch = args.patch as Record<string, string | undefined>;
        const customerName = (patch.customerName ?? vehicle.customerName).trim();
        const vehicleName = (patch.vehicleName ?? vehicle.vehicleName).trim();
        const licensePlate =
          patch.licensePlate === undefined
            ? vehicle.licensePlate
            : normalizeLicensePlate(patch.licensePlate);
        validateVehicleText(customerName, vehicleName, licensePlate);
        Object.assign(vehicle, {
          customerName,
          vehicleName,
          licensePlate,
          updatedAt: nextTimestamp(),
        });
        return { ...vehicle };
      }
      case "update_vehicle_status": {
        const vehicle = findVehicle(String(args.id));
        const field = String(args.field) as
          | "tuvRequired"
          | "partsOrdered"
          | "partsArrived"
          | "isDone";
        vehicle[field] = Boolean(args.value);
        vehicle.updatedAt = nextTimestamp();
        return { ...vehicle };
      }
      case "reorder_vehicles": {
        const ids = args.ids as string[];
        ids.forEach((id) => findVehicle(id));
        ids.forEach((id, index) => {
          findVehicle(id).position = index;
        });
        return listVehicles();
      }
      case "archive_vehicle": {
        const vehicle = findVehicle(String(args.id));
        vehicle.archivedAt = nextTimestamp();
        return { ...vehicle };
      }
      case "restore_vehicle": {
        const vehicle = findVehicle(String(args.id));
        vehicle.archivedAt = null;
        return { ...vehicle };
      }
      case "list_open_payments":
        return listOpenPayments();
      case "create_payment": {
        const input = args.input as Record<string, unknown>;
        const customerName = String(input.customerName ?? "").trim();
        const amountCents = Number(input.amountCents ?? 0);
        const note = String(input.note ?? "").trim();
        validatePaymentValues(customerName, amountCents);
        const timestamp = nextTimestamp();
        const payment: Payment = {
          id: nextId("p"),
          customerName,
          amountCents,
          note,
          createdAt: timestamp,
          updatedAt: timestamp,
          paidAt: null,
          archivedAt: null,
        };
        payments.push(payment);
        return { ...payment };
      }
      case "update_payment": {
        const payment = findPayment(String(args.id));
        const patch = args.patch as Record<string, unknown>;
        const customerName = String(patch.customerName ?? payment.customerName).trim();
        const amountCents = Number(patch.amountCents ?? payment.amountCents);
        const note = String(patch.note ?? payment.note).trim();
        validatePaymentValues(customerName, amountCents);
        Object.assign(payment, { customerName, amountCents, note, updatedAt: nextTimestamp() });
        return { ...payment };
      }
      case "mark_payment_paid": {
        const payment = findPayment(String(args.id));
        payment.paidAt = nextTimestamp();
        return { ...payment };
      }
      case "restore_payment": {
        const payment = findPayment(String(args.id));
        payment.paidAt = null;
        return { ...payment };
      }
      case "hidden_status":
        return seed?.hiddenError
          ? { unlocked: false, error: seed.hiddenError }
          : { unlocked: true };
      case "list_hidden_entries":
        requireHiddenAccess();
        return listHiddenEntries();
      case "create_hidden_entry": {
        requireHiddenAccess();
        const input = args.input as Record<string, unknown>;
        const name = String(input.name ?? "").trim();
        const amountCents = Number(input.amountCents ?? 0);
        const note = String(input.note ?? "").trim();
        validateHiddenValues(name, amountCents);
        const timestamp = nextTimestamp();
        const entry: HiddenEntry = {
          id: nextId("h"),
          name,
          amountCents,
          note,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        };
        hiddenEntries.push(entry);
        return { ...entry };
      }
      case "update_hidden_entry": {
        requireHiddenAccess();
        const entry = findHiddenEntry(String(args.id));
        const patch = args.patch as Record<string, unknown>;
        const name = String(patch.name ?? entry.name).trim();
        const amountCents = Number(patch.amountCents ?? entry.amountCents);
        const note = String(patch.note ?? entry.note).trim();
        validateHiddenValues(name, amountCents);
        Object.assign(entry, { name, amountCents, note, updatedAt: nextTimestamp() });
        return { ...entry };
      }
      case "archive_hidden_entry": {
        requireHiddenAccess();
        const entry = findHiddenEntry(String(args.id));
        entry.archivedAt = nextTimestamp();
        return { ...entry };
      }
      case "restore_hidden_entry": {
        requireHiddenAccess();
        const entry = findHiddenEntry(String(args.id));
        entry.archivedAt = null;
        return { ...entry };
      }
      case "create_backup": {
        if (cancels.delete(cmd)) {
          return { saved: false, path: null };
        }
        const snapshot = takeSnapshot();
        backups.push(snapshot);
        return { saved: true, path: "/backups/test.werkstattbackup" };
      }
      case "prepare_restore": {
        if (cancels.delete(cmd)) {
          return {
            cancelled: true,
            createdAt: null,
            fileName: null,
            vehicleCount: null,
            paymentCount: null,
            hiddenCount: null,
          };
        }
        const snapshot = backups[backups.length - 1];
        if (!snapshot) {
          throw { code: "backup", message: "Backup-Datei ist ungültig oder beschädigt" };
        }
        stagedRestore = snapshot;
        return {
          cancelled: false,
          createdAt: snapshot.createdAt,
          fileName: "test.werkstattbackup",
          vehicleCount: snapshot.vehicles.filter((entry) => entry.archivedAt === null).length,
          paymentCount: snapshot.payments.filter(
            (entry) => entry.paidAt === null && entry.archivedAt === null,
          ).length,
          hiddenCount: snapshot.hiddenEntries.filter((entry) => entry.archivedAt === null).length,
        };
      }
      case "confirm_restore": {
        if (!stagedRestore) {
          throw { code: "backup", message: "Keine geprüfte Backup-Datei ausgewählt" };
        }
        applySnapshot(stagedRestore);
        stagedRestore = null;
        return null;
      }
      case "cancel_restore":
        stagedRestore = null;
        return null;
      default:
        throw notFound(`Unbekannter Command: ${cmd}`);
    }
  });

  return {
    vehicles,
    payments,
    hiddenEntries,
    backups,
    calls,
    planFailure: (cmd, error) => {
      failures.set(cmd, error ?? { code: "database", message: "Speichern fehlgeschlagen" });
    },
    planCancel: (cmd) => {
      cancels.add(cmd);
    },
  };
}
