import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  ApiError,
  CustomerSuggestion,
  HiddenEntry,
  Payment,
  SecretHistoryEntry,
  UiPreferences,
  Vehicle,
  VehicleColumnId,
  VehicleHistory,
} from "../types";
import { VEHICLE_COLUMN_IDS } from "../types";

/**
 * In-Memory-Nachbildung des Rust-Backends für Frontend-Tests.
 * Sie bildet insbesondere die Session-Grenze des Secret-Bereichs, unveränderliche
 * Historien, persistente UI-Präferenzen und Backup-Restores ab.
 */

export interface VehicleSeed {
  customerName: string;
  vehicleName?: string;
  licensePlate?: string;
  note?: string;
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

interface Snapshot {
  createdAt: string;
  vehicles: Vehicle[];
  vehicleHistory: VehicleHistory[];
  payments: Payment[];
  hiddenEntries: HiddenEntry[];
  secretHistory: SecretHistoryEntry[];
  preferences: UiPreferences;
}

export interface FakeBackend {
  vehicles: Vehicle[];
  vehicleHistory: VehicleHistory[];
  payments: Payment[];
  /** Im Fake Klartext; die echte Verschlüsselung wird in Rust getestet. */
  hiddenEntries: HiddenEntry[];
  secretHistory: SecretHistoryEntry[];
  preferences: UiPreferences;
  backups: Snapshot[];
  calls: string[];
  callPayloads: Array<{ cmd: string; payload: Record<string, unknown> }>;
  activeSessionTokens: Set<string>;
  planFailure: (cmd: string, error?: ApiError) => void;
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

function normalizeColumnOrder(input: readonly string[]): VehicleColumnId[] {
  const known = new Set<string>();
  const normalized: VehicleColumnId[] = [];
  for (const id of input) {
    if ((VEHICLE_COLUMN_IDS as readonly string[]).includes(id) && !known.has(id)) {
      known.add(id);
      normalized.push(id as VehicleColumnId);
    }
  }
  if (normalized.length === 0) return [...VEHICLE_COLUMN_IDS];
  for (const id of VEHICLE_COLUMN_IDS) {
    if (!known.has(id)) normalized.push(id);
  }
  return normalized;
}

function normalizeHiddenColumns(
  input: readonly string[],
  columnOrder: readonly VehicleColumnId[],
): VehicleColumnId[] {
  const hidden = input.filter(
    (id, index, items): id is VehicleColumnId =>
      (VEHICLE_COLUMN_IDS as readonly string[]).includes(id) && items.indexOf(id) === index,
  );
  return hidden.length === VEHICLE_COLUMN_IDS.length
    ? hidden.filter((id) => id !== columnOrder[0])
    : hidden;
}

export function installFakeBackend(seed?: {
  vehicles?: VehicleSeed[];
  payments?: PaymentSeed[];
  hidden?: HiddenSeed[];
  hiddenError?: ApiError;
  uiPreferences?: Partial<UiPreferences>;
}): FakeBackend {
  let idCounter = 0;
  let clock = 0;
  let sessionCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;
  const nextTimestamp = () => new Date(1700000000000 + ++clock * 1000).toISOString();

  const vehicles: Vehicle[] = (seed?.vehicles ?? []).map((entry, index) => {
    const timestamp = nextTimestamp();
    return {
      id: nextId("v"),
      customerName: entry.customerName,
      vehicleName: entry.vehicleName ?? "",
      licensePlate: entry.licensePlate ?? "",
      note: entry.note ?? "",
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

  const vehicleHistory: VehicleHistory[] = [];
  for (const vehicle of vehicles) {
    if (vehicle.isDone) {
      vehicleHistory.push({
        id: nextId("vh"),
        sourceVehicleId: vehicle.id,
        customerName: vehicle.customerName,
        vehicleName: vehicle.vehicleName,
        licensePlate: vehicle.licensePlate,
        note: vehicle.note,
        tuvRequired: vehicle.tuvRequired,
        partsOrdered: vehicle.partsOrdered,
        partsArrived: vehicle.partsArrived,
        isDone: true,
        completedAt: vehicle.updatedAt,
        archivedAt: vehicle.archivedAt,
        vehicleCreatedAt: vehicle.createdAt,
        snapshotCreatedAt: vehicle.updatedAt,
      });
    }
  }

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
  const secretHistory: SecretHistoryEntry[] = [];

  const preferences: UiPreferences = {
    paymentsPanelCollapsed: seed?.uiPreferences?.paymentsPanelCollapsed ?? false,
    paymentsPanelHeight: seed?.uiPreferences?.paymentsPanelHeight ?? 240,
    vehicleColumnOrder: normalizeColumnOrder(seed?.uiPreferences?.vehicleColumnOrder ?? []),
    vehicleHiddenColumns: normalizeHiddenColumns(
      seed?.uiPreferences?.vehicleHiddenColumns ?? [],
      normalizeColumnOrder(seed?.uiPreferences?.vehicleColumnOrder ?? []),
    ),
  };

  const backups: Snapshot[] = [];
  let stagedRestore: Snapshot | null = null;
  const calls: string[] = [];
  const callPayloads: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const failures = new Map<string, ApiError>();
  const cancels = new Set<string>();
  const activeSessionTokens = new Set<string>();

  function requireHiddenAccess() {
    if (seed?.hiddenError) throw seed.hiddenError;
  }

  function requireSession(args: Record<string, unknown>): string {
    const token = typeof args.sessionToken === "string" ? args.sessionToken : "";
    if (token === "" || !activeSessionTokens.has(token)) {
      throw validationError("sessionToken", "Secret-Sitzung ist ungültig oder beendet");
    }
    return token;
  }

  function findVehicle(id: string): Vehicle {
    const vehicle = vehicles.find((entry) => entry.id === id);
    if (!vehicle) throw notFound("Fahrzeug nicht gefunden");
    return vehicle;
  }

  function findPayment(id: string): Payment {
    const payment = payments.find((entry) => entry.id === id);
    if (!payment) throw notFound("Zahlung nicht gefunden");
    return payment;
  }

  function findHiddenEntry(id: string): HiddenEntry {
    const entry = hiddenEntries.find((item) => item.id === id);
    if (!entry) throw notFound("Eintrag nicht gefunden");
    return entry;
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

  function listHiddenEntries(): HiddenEntry[] {
    return hiddenEntries
      .filter((entry) => entry.archivedAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((entry) => ({ ...entry }));
  }

  function ensureVehicleHistory(vehicle: Vehicle, completedAt: string): VehicleHistory {
    const existing = vehicleHistory.find((item) => item.sourceVehicleId === vehicle.id);
    if (existing) return existing;
    const snapshot: VehicleHistory = {
      id: nextId("vh"),
      sourceVehicleId: vehicle.id,
      customerName: vehicle.customerName,
      vehicleName: vehicle.vehicleName,
      licensePlate: vehicle.licensePlate,
      note: vehicle.note,
      tuvRequired: vehicle.tuvRequired,
      partsOrdered: vehicle.partsOrdered,
      partsArrived: vehicle.partsArrived,
      isDone: true,
      completedAt,
      archivedAt: vehicle.archivedAt,
      vehicleCreatedAt: vehicle.createdAt,
      snapshotCreatedAt: completedAt,
    };
    vehicleHistory.push(snapshot);
    return snapshot;
  }

  function ensureSecretHistory(entry: HiddenEntry, archivedAt: string): SecretHistoryEntry {
    const existing = secretHistory.find((item) => item.sourceHiddenEntryId === entry.id);
    if (existing) return existing;
    const snapshot: SecretHistoryEntry = {
      id: nextId("sh"),
      sourceHiddenEntryId: entry.id,
      name: entry.name,
      amountCents: entry.amountCents,
      note: entry.note,
      completedOrArchivedAt: archivedAt,
      completedAt: archivedAt,
      createdAt: archivedAt,
    };
    secretHistory.push(snapshot);
    return snapshot;
  }

  function listSuggestions(): CustomerSuggestion[] {
    const candidates: CustomerSuggestion[] = [
      ...vehicles
        .filter((vehicle) => vehicle.customerName.trim() !== "")
        .map((vehicle) => ({
          id: vehicle.id,
          customerName: vehicle.customerName.trim(),
          vehicleName: vehicle.vehicleName.trim() || null,
          licensePlate: vehicle.licensePlate.trim() || null,
          lastUsedAt: vehicle.archivedAt ?? vehicle.updatedAt ?? vehicle.createdAt,
        })),
      ...vehicleHistory
        .filter((history) => history.customerName.trim() !== "")
        .map((history) => ({
          id: history.sourceVehicleId,
          customerName: history.customerName.trim(),
          vehicleName: history.vehicleName.trim() || null,
          licensePlate: history.licensePlate.trim() || null,
          lastUsedAt: history.completedAt,
        })),
    ];
    const merged = new Map<string, CustomerSuggestion>();
    for (const candidate of candidates) {
      const key = candidate.customerName.toLocaleLowerCase("de-DE");
      const current = merged.get(key);
      if (
        !current ||
        candidate.lastUsedAt > current.lastUsedAt ||
        (candidate.lastUsedAt === current.lastUsedAt && candidate.id > current.id)
      ) {
        merged.set(key, candidate);
      }
    }
    return [...merged.values()]
      .sort(
        (a, b) =>
          b.lastUsedAt.localeCompare(a.lastUsedAt) ||
          a.customerName.localeCompare(b.customerName, "de-DE") ||
          a.id.localeCompare(b.id),
      )
      .map((item) => ({ ...item }));
  }

  function cloneSnapshot(snapshot: Snapshot): Snapshot {
    return {
      createdAt: snapshot.createdAt,
      vehicles: snapshot.vehicles.map((item) => ({ ...item })),
      vehicleHistory: snapshot.vehicleHistory.map((item) => ({ ...item })),
      payments: snapshot.payments.map((item) => ({ ...item })),
      hiddenEntries: snapshot.hiddenEntries.map((item) => ({ ...item })),
      secretHistory: snapshot.secretHistory.map((item) => ({ ...item })),
      preferences: {
        paymentsPanelCollapsed: snapshot.preferences.paymentsPanelCollapsed,
        paymentsPanelHeight: snapshot.preferences.paymentsPanelHeight,
        vehicleColumnOrder: [...snapshot.preferences.vehicleColumnOrder],
        vehicleHiddenColumns: [...snapshot.preferences.vehicleHiddenColumns],
      },
    };
  }

  function takeSnapshot(): Snapshot {
    return cloneSnapshot({
      createdAt: nextTimestamp(),
      vehicles,
      vehicleHistory,
      payments,
      hiddenEntries,
      secretHistory,
      preferences,
    });
  }

  function applySnapshot(snapshot: Snapshot) {
    const copy = cloneSnapshot(snapshot);
    vehicles.splice(0, vehicles.length, ...copy.vehicles);
    vehicleHistory.splice(0, vehicleHistory.length, ...copy.vehicleHistory);
    payments.splice(0, payments.length, ...copy.payments);
    hiddenEntries.splice(0, hiddenEntries.length, ...copy.hiddenEntries);
    secretHistory.splice(0, secretHistory.length, ...copy.secretHistory);
    preferences.paymentsPanelCollapsed = copy.preferences.paymentsPanelCollapsed;
    preferences.paymentsPanelHeight = copy.preferences.paymentsPanelHeight;
    preferences.vehicleColumnOrder = copy.preferences.vehicleColumnOrder;
    preferences.vehicleHiddenColumns = copy.preferences.vehicleHiddenColumns;
  }

  mockIPC((cmd, payload) => {
    calls.push(cmd);
    const args = (payload ?? {}) as Record<string, unknown>;
    callPayloads.push({ cmd, payload: { ...args } });
    const planned = failures.get(cmd);
    if (planned) {
      failures.delete(cmd);
      throw planned;
    }

    switch (cmd) {
      case "list_vehicles":
        return listVehicles();
      case "create_vehicle": {
        const input = args.input as Record<string, unknown>;
        const customerName = String(input.customerName ?? "").trim();
        const vehicleName = String(input.vehicleName ?? "").trim();
        const licensePlate = normalizeLicensePlate(String(input.licensePlate ?? ""));
        const note = String(input.note ?? "").trim();
        validateVehicleText(customerName, vehicleName, licensePlate);
        const timestamp = nextTimestamp();
        const vehicle: Vehicle = {
          id: nextId("v"),
          customerName,
          vehicleName,
          licensePlate,
          note,
          tuvRequired: Boolean(input.tuvRequired),
          partsOrdered: Boolean(input.partsOrdered),
          partsArrived: Boolean(input.partsArrived),
          isDone: Boolean(input.isDone),
          position: Math.max(-1, ...vehicles.map((entry) => entry.position)) + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        };
        vehicles.push(vehicle);
        if (vehicle.isDone) ensureVehicleHistory(vehicle, timestamp);
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
        const note = (patch.note ?? vehicle.note).trim();
        validateVehicleText(customerName, vehicleName, licensePlate);
        Object.assign(vehicle, {
          customerName,
          vehicleName,
          licensePlate,
          note,
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
        if (field === "isDone" && vehicle.isDone) ensureVehicleHistory(vehicle, vehicle.updatedAt);
        return { ...vehicle };
      }
      case "create_vehicle_history_snapshot": {
        const vehicle = findVehicle(String(args.id));
        if (!vehicle.isDone) {
          throw validationError(
            "isDone",
            "Nur abgeschlossene Fahrzeuge können in die Historie übernommen werden",
          );
        }
        return { ...ensureVehicleHistory(vehicle, nextTimestamp()) };
      }
      case "list_completed_vehicle_history":
        return vehicleHistory
          .slice()
          .sort(
            (a, b) =>
              b.completedAt.localeCompare(a.completedAt) ||
              b.snapshotCreatedAt.localeCompare(a.snapshotCreatedAt) ||
              a.id.localeCompare(b.id),
          )
          .map((item) => ({ ...item }));
      case "list_customer_suggestions":
        return listSuggestions();
      case "get_ui_preferences":
        return {
          paymentsPanelCollapsed: preferences.paymentsPanelCollapsed,
          paymentsPanelHeight: preferences.paymentsPanelHeight,
          vehicleColumnOrder: [...preferences.vehicleColumnOrder],
          vehicleHiddenColumns: [...preferences.vehicleHiddenColumns],
        };
      case "update_payments_panel_collapsed":
        preferences.paymentsPanelCollapsed = Boolean(args.collapsed);
        return {
          paymentsPanelCollapsed: preferences.paymentsPanelCollapsed,
          paymentsPanelHeight: preferences.paymentsPanelHeight,
          vehicleColumnOrder: [...preferences.vehicleColumnOrder],
          vehicleHiddenColumns: [...preferences.vehicleHiddenColumns],
        };
      case "update_payments_panel_height":
        preferences.paymentsPanelHeight = Math.min(
          1200,
          Math.max(160, Number(args.height)),
        );
        return {
          paymentsPanelCollapsed: preferences.paymentsPanelCollapsed,
          paymentsPanelHeight: preferences.paymentsPanelHeight,
          vehicleColumnOrder: [...preferences.vehicleColumnOrder],
          vehicleHiddenColumns: [...preferences.vehicleHiddenColumns],
        };
      case "update_vehicle_column_order":
        preferences.vehicleColumnOrder = normalizeColumnOrder(args.columnOrder as string[]);
        return {
          paymentsPanelCollapsed: preferences.paymentsPanelCollapsed,
          paymentsPanelHeight: preferences.paymentsPanelHeight,
          vehicleColumnOrder: [...preferences.vehicleColumnOrder],
          vehicleHiddenColumns: [...preferences.vehicleHiddenColumns],
        };
      case "update_vehicle_hidden_columns":
        preferences.vehicleHiddenColumns = normalizeHiddenColumns(
          args.hiddenColumns as string[],
          preferences.vehicleColumnOrder,
        );
        return {
          paymentsPanelCollapsed: preferences.paymentsPanelCollapsed,
          paymentsPanelHeight: preferences.paymentsPanelHeight,
          vehicleColumnOrder: [...preferences.vehicleColumnOrder],
          vehicleHiddenColumns: [...preferences.vehicleHiddenColumns],
        };
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
        vehicle.archivedAt ??= nextTimestamp();
        vehicle.updatedAt = vehicle.archivedAt;
        const snapshot = vehicleHistory.find((item) => item.sourceVehicleId === vehicle.id);
        if (snapshot) snapshot.archivedAt ??= vehicle.archivedAt;
        return { ...vehicle };
      }
      case "restore_vehicle": {
        const vehicle = findVehicle(String(args.id));
        vehicle.archivedAt = null;
        vehicle.updatedAt = nextTimestamp();
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
        return seed?.hiddenError ? { unlocked: false, error: seed.hiddenError } : { unlocked: true };
      case "begin_secret_session": {
        requireHiddenAccess();
        const token = `secret-session-${++sessionCounter}`;
        activeSessionTokens.add(token);
        return token;
      }
      case "end_secret_session": {
        const token = requireSession(args);
        activeSessionTokens.delete(token);
        return null;
      }
      case "list_hidden_entries":
        requireSession(args);
        requireHiddenAccess();
        return listHiddenEntries();
      case "list_hidden_entry_history":
      case "list_secret_history":
        requireSession(args);
        requireHiddenAccess();
        return secretHistory
          .slice()
          .sort(
            (a, b) =>
              b.completedAt.localeCompare(a.completedAt) ||
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id),
          )
          .map((item) => ({ ...item }));
      case "create_hidden_entry": {
        requireSession(args);
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
        requireSession(args);
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
        requireSession(args);
        requireHiddenAccess();
        const entry = findHiddenEntry(String(args.id));
        entry.archivedAt ??= nextTimestamp();
        entry.updatedAt = entry.archivedAt;
        ensureSecretHistory(entry, entry.archivedAt);
        return { ...entry };
      }
      case "restore_hidden_entry": {
        requireSession(args);
        requireHiddenAccess();
        const entry = findHiddenEntry(String(args.id));
        entry.archivedAt = null;
        entry.updatedAt = nextTimestamp();
        return { ...entry };
      }
      case "create_backup": {
        if (cancels.delete(cmd)) return { saved: false, path: null };
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
        stagedRestore = cloneSnapshot(snapshot);
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
        activeSessionTokens.clear();
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
    vehicleHistory,
    payments,
    hiddenEntries,
    secretHistory,
    preferences,
    backups,
    calls,
    callPayloads,
    activeSessionTokens,
    planFailure: (cmd, error) => {
      failures.set(cmd, error ?? { code: "database", message: "Speichern fehlgeschlagen" });
    },
    planCancel: (cmd) => {
      cancels.add(cmd);
    },
  };
}
