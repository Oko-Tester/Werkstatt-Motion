import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import { toApiError } from "./api";
import { AppShell } from "./components/AppShell";
import { Header } from "./components/Header";
import { HiddenPanel } from "./components/HiddenPanel";
import { HistoryWorkspace } from "./components/HistoryWorkspace";
import { PaymentsPanel } from "./components/PaymentsPanel";
import { UndoBar } from "./components/UndoBar";
import { VehicleTable } from "./components/VehicleTable";
import { parseEuroInput } from "./money";
import { VEHICLE_COLUMN_IDS } from "./types";
import type {
  CustomerSuggestion,
  FieldErrors,
  HiddenEntry,
  HiddenEntryDraft,
  HiddenStatus,
  HiddenTextField,
  Payment,
  PaymentDraft,
  PaymentTextField,
  SecretHistoryEntry,
  Vehicle,
  VehicleColumnId,
  VehicleDraft,
  VehicleHistory,
  VehicleStatusField,
  VehicleTextField,
} from "./types";

interface UndoState {
  id: number;
  message: string;
  undo: () => void;
}

const UNDO_TIMEOUT_MS = 6000;
const NOTICE_TIMEOUT_MS = 6000;
const REORDER_DEBOUNCE_MS = 300;

function isDraftId(id: string): boolean {
  return id.startsWith("draft-");
}

function isVehicleDraftComplete(draft: VehicleDraft): boolean {
  return (
    draft.customerName.trim() !== "" &&
    (draft.vehicleName.trim() !== "" || draft.licensePlate.trim() !== "")
  );
}

function isVehicleDraftEmpty(draft: VehicleDraft): boolean {
  return (
    draft.customerName.trim() === "" &&
    draft.vehicleName.trim() === "" &&
    draft.licensePlate.trim() === "" &&
    !draft.tuvRequired &&
    !draft.partsOrdered &&
    !draft.partsArrived &&
    !draft.isDone
  );
}

function isPaymentDraftComplete(draft: PaymentDraft): boolean {
  return draft.customerName.trim() !== "" && draft.amountCents !== null && draft.amountCents > 0;
}

function isPaymentDraftEmpty(draft: PaymentDraft): boolean {
  return draft.customerName.trim() === "" && draft.amountCents === null && draft.note.trim() === "";
}

function isHiddenDraftComplete(draft: HiddenEntryDraft): boolean {
  return draft.name.trim() !== "" && draft.amountCents !== null && draft.amountCents > 0;
}

function isHiddenDraftEmpty(draft: HiddenEntryDraft): boolean {
  return draft.name.trim() === "" && draft.amountCents === null && draft.note.trim() === "";
}

export default function App() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleDrafts, setVehicleDrafts] = useState<VehicleDraft[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);
  const [customerSuggestions, setCustomerSuggestions] = useState<CustomerSuggestion[]>([]);
  const [paymentsCollapsed, setPaymentsCollapsed] = useState(false);
  const [vehicleColumnOrder, setVehicleColumnOrder] = useState<VehicleColumnId[]>([
    ...VEHICLE_COLUMN_IDS,
  ]);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [secretSessionToken, setSecretSessionToken] = useState<string | null>(null);
  const [hiddenStatus, setHiddenStatus] = useState<HiddenStatus | null>(null);
  const [hiddenEntries, setHiddenEntries] = useState<HiddenEntry[]>([]);
  const [hiddenDrafts, setHiddenDrafts] = useState<HiddenEntryDraft[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [vehicleHistory, setVehicleHistory] = useState<VehicleHistory[]>([]);
  const [secretHistory, setSecretHistory] = useState<SecretHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  // Spiegel der States für Handler, die nach dem Event (setTimeout) den
  // aktuellen Stand brauchen – z. B. das Verwerfen leerer Entwurfszeilen.
  const vehiclesRef = useRef(vehicles);
  vehiclesRef.current = vehicles;
  const vehicleDraftsRef = useRef(vehicleDrafts);
  vehicleDraftsRef.current = vehicleDrafts;
  const paymentsRef = useRef(payments);
  paymentsRef.current = payments;
  const paymentDraftsRef = useRef(paymentDrafts);
  paymentDraftsRef.current = paymentDrafts;
  const hiddenEntriesRef = useRef(hiddenEntries);
  hiddenEntriesRef.current = hiddenEntries;
  const hiddenDraftsRef = useRef(hiddenDrafts);
  hiddenDraftsRef.current = hiddenDrafts;
  const secretHistoryRef = useRef(secretHistory);
  secretHistoryRef.current = secretHistory;
  const hiddenOpenRef = useRef(hiddenOpen);
  hiddenOpenRef.current = hiddenOpen;
  const historyOpenRef = useRef(historyOpen);
  historyOpenRef.current = historyOpen;
  const secretSessionTokenRef = useRef(secretSessionToken);
  secretSessionTokenRef.current = secretSessionToken;
  const fieldErrorsRef = useRef(fieldErrors);
  fieldErrorsRef.current = fieldErrors;

  const counterRef = useRef(0);
  const creatingRef = useRef(new Set<string>());
  const secretOpeningRef = useRef(false);
  const orderSnapshotRef = useRef<Vehicle[] | null>(null);
  const reorderTimerRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ---------- Laden, Hinweise, Undo ----------

  async function loadCoreData() {
    setLoading(true);
    try {
      const [vehicleList, paymentList, suggestions, preferences] = await Promise.all([
        api.listVehicles(),
        api.listOpenPayments(),
        api.listCustomerSuggestions().catch(() => []),
        api.getUiPreferences().catch(() => ({
          paymentsPanelCollapsed: false,
          vehicleColumnOrder: [...VEHICLE_COLUMN_IDS],
        })),
      ]);
      setVehicles(vehicleList);
      setPayments(paymentList);
      setCustomerSuggestions(suggestions);
      setPaymentsCollapsed(preferences.paymentsPanelCollapsed);
      setVehicleColumnOrder(preferences.vehicleColumnOrder);
      setLoadError(null);
    } catch (err) {
      // Persistenter, nicht blockierender Fehlerzustand mit „Erneut laden“ –
      // z. B. wenn die Datenbank beim Start nicht verfügbar ist.
      setLoadError(toApiError(err).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCoreData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!undoState) {
      return;
    }
    const timer = window.setTimeout(() => setUndoState(null), UNDO_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [undoState]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Strg+F bzw. Cmd+F fokussiert die interne Suche statt der WebView-Suche.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(
    () => () => {
      if (reorderTimerRef.current !== null) {
        window.clearTimeout(reorderTimerRef.current);
      }
    },
    [],
  );

  useEffect(
    () => () => {
      const token = secretSessionTokenRef.current;
      if (token !== null) void api.endSecretSession(token).catch(() => undefined);
    },
    [],
  );

  async function refreshCustomerSuggestions() {
    try {
      setCustomerSuggestions(await api.listCustomerSuggestions());
    } catch {
      // Vorschläge sind Komfortfunktion; Kernaktionen dürfen nie darauf warten.
    }
  }

  function togglePaymentsCollapsed() {
    const next = !paymentsCollapsed;
    setPaymentsCollapsed(next);
    void api.updatePaymentsPanelCollapsed(next).catch((err) => {
      // Die Oberfläche bleibt für diese Sitzung im gewählten Zustand bedienbar.
      showNotice(toApiError(err).message);
    });
  }

  function changeVehicleColumnOrder(next: VehicleColumnId[]) {
    const focusedColumn =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>("th[data-column-id]")?.dataset.columnId
        : undefined;
    setVehicleColumnOrder(next);
    if (focusedColumn !== undefined) {
      window.setTimeout(() => {
        document
          .querySelector<HTMLButtonElement>(
            `th[data-column-id="${focusedColumn}"] .column-drag-handle`,
          )
          ?.focus();
      });
    }
    void api
      .updateVehicleColumnOrder(next)
      .then((preferences) => setVehicleColumnOrder(preferences.vehicleColumnOrder))
      .catch((err) => {
        // Ein Persistenzfehler nimmt dem Nutzer nicht die aktuelle Sitzungsanordnung.
        showNotice(toApiError(err).message);
      });
  }

  function showUndo(message: string, undo: () => void) {
    counterRef.current += 1;
    setUndoState({ id: counterRef.current, message, undo });
  }

  function showNotice(message: string) {
    counterRef.current += 1;
    setNotice({ id: counterRef.current, message });
  }

  function setFieldError(rowId: string, field: string, message: string) {
    setFieldErrors((prev) => ({ ...prev, [rowId]: { ...prev[rowId], [field]: message } }));
  }

  function clearFieldError(rowId: string, field?: string) {
    setFieldErrors((prev) => {
      if (!(rowId in prev)) {
        return prev;
      }
      const next = { ...prev };
      if (field === undefined) {
        delete next[rowId];
        return next;
      }
      const row = { ...next[rowId] };
      delete row[field];
      if (Object.keys(row).length === 0) {
        delete next[rowId];
      } else {
        next[rowId] = row;
      }
      return next;
    });
  }

  // ---------- Suche ----------

  const visibleVehicles = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query === "") {
      return vehicles;
    }
    return vehicles.filter((vehicle) =>
      [vehicle.customerName, vehicle.vehicleName, vehicle.licensePlate].some((text) =>
        text.toLowerCase().includes(query),
      ),
    );
  }, [vehicles, search]);

  // ---------- Fahrzeuge: anlegen ----------

  function addVehicle() {
    const draft: VehicleDraft = {
      draftId: `draft-v-${crypto.randomUUID()}`,
      customerName: "",
      vehicleName: "",
      licensePlate: "",
      tuvRequired: false,
      partsOrdered: false,
      partsArrived: false,
      isDone: false,
    };
    // Suche leeren, damit die neue Zeile sicher sichtbar ist.
    setSearch("");
    setVehicleDrafts((prev) => [draft, ...prev]);
    setAutoFocusId(draft.draftId);
  }

  function updateVehicleDraft(draftId: string, patch: Partial<VehicleDraft>) {
    const current = vehicleDraftsRef.current.find((draft) => draft.draftId === draftId);
    if (!current) {
      return;
    }
    const next = { ...current, ...patch };
    setVehicleDrafts((prev) => prev.map((draft) => (draft.draftId === draftId ? next : draft)));
    for (const field of Object.keys(patch)) {
      clearFieldError(draftId, field);
    }
  }

  async function createVehicleFromDraft(draft: VehicleDraft) {
    try {
      const created = await api.createVehicle({
        customerName: draft.customerName,
        vehicleName: draft.vehicleName,
        licensePlate: draft.licensePlate,
        tuvRequired: draft.tuvRequired,
        partsOrdered: draft.partsOrdered,
        partsArrived: draft.partsArrived,
        isDone: draft.isDone,
      });
      setVehicleDrafts((prev) => prev.filter((entry) => entry.draftId !== draft.draftId));
      clearFieldError(draft.draftId);
      setVehicles((prev) => [created, ...prev]);
      void refreshCustomerSuggestions();
    } catch (err) {
      const apiErr = toApiError(err);
      setFieldError(draft.draftId, apiErr.field ?? "customerName", apiErr.message);
    } finally {
      creatingRef.current.delete(draft.draftId);
    }
  }

  function handleVehicleDraftRowLeave(draftId: string) {
    // Nach dem Event prüfen, damit der Blur-Commit des Feldes schon im State ist.
    // Erst beim Verlassen der Zeile wird gespeichert – so stiehlt das Ersetzen
    // der Entwurfszeile niemandem den Fokus beim Weitertippen.
    window.setTimeout(() => {
      const draft = vehicleDraftsRef.current.find((entry) => entry.draftId === draftId);
      if (!draft || creatingRef.current.has(draftId)) {
        return;
      }
      if (isVehicleDraftEmpty(draft)) {
        // Leer verlassene neue Zeilen werden ohne Rückfrage verworfen.
        setVehicleDrafts((prev) => prev.filter((entry) => entry.draftId !== draftId));
        clearFieldError(draftId);
      } else if (isVehicleDraftComplete(draft)) {
        creatingRef.current.add(draftId);
        void createVehicleFromDraft(draft);
      } else {
        const existing = fieldErrorsRef.current[draftId] ?? {};
        if (draft.customerName.trim() === "" && existing.customerName === undefined) {
          setFieldError(draftId, "customerName", "Kunde angeben");
        } else if (draft.customerName.trim() !== "" && existing.vehicleName === undefined) {
          setFieldError(draftId, "vehicleName", "Fahrzeug oder Kennzeichen angeben");
        }
      }
    }, 0);
  }

  // ---------- Fahrzeuge: bearbeiten ----------

  function commitVehicleText(id: string, field: VehicleTextField, value: string) {
    if (isDraftId(id)) {
      updateVehicleDraft(id, { [field]: value });
      return;
    }
    void saveVehicleText(id, field, value);
  }

  async function saveVehicleText(id: string, field: VehicleTextField, value: string) {
    const vehicle = vehiclesRef.current.find((entry) => entry.id === id);
    if (!vehicle) {
      return;
    }
    clearFieldError(id, field);
    if (vehicle[field] === value) {
      return;
    }
    const previous = vehicle;
    setVehicles((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)),
    );
    try {
      const saved = await api.updateVehicle(id, { [field]: value });
      setVehicles((prev) => prev.map((entry) => (entry.id === id ? saved : entry)));
      void refreshCustomerSuggestions();
    } catch (err) {
      const apiErr = toApiError(err);
      setVehicles((prev) => prev.map((entry) => (entry.id === id ? previous : entry)));
      setFieldError(id, apiErr.field ?? field, apiErr.message);
    }
  }

  function toggleVehicleStatus(id: string, field: VehicleStatusField, value: boolean) {
    if (isDraftId(id)) {
      updateVehicleDraft(id, { [field]: value });
      return;
    }
    void saveVehicleStatus(id, field, value);
  }

  async function saveVehicleStatus(id: string, field: VehicleStatusField, value: boolean) {
    const previous = vehiclesRef.current.find((entry) => entry.id === id);
    if (!previous) {
      return;
    }
    setVehicles((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)),
    );
    try {
      const saved = await api.updateVehicleStatus(id, field, value);
      setVehicles((prev) => prev.map((entry) => (entry.id === id ? saved : entry)));
      if (field === "isDone") void refreshCustomerSuggestions();
    } catch (err) {
      setVehicles((prev) => prev.map((entry) => (entry.id === id ? previous : entry)));
      showNotice(toApiError(err).message);
    }
  }

  // ---------- Fahrzeuge: Reihenfolge ----------

  function moveVehicle(dragId: string, targetId: string) {
    if (orderSnapshotRef.current === null) {
      orderSnapshotRef.current = vehiclesRef.current;
    }
    setVehicles((prev) => {
      const from = prev.findIndex((vehicle) => vehicle.id === dragId);
      const to = prev.findIndex((vehicle) => vehicle.id === targetId);
      if (from === -1 || to === -1 || from === to) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    if (reorderTimerRef.current !== null) {
      window.clearTimeout(reorderTimerRef.current);
    }
    reorderTimerRef.current = window.setTimeout(() => {
      reorderTimerRef.current = null;
      void persistVehicleOrder();
    }, REORDER_DEBOUNCE_MS);
  }

  async function persistVehicleOrder() {
    const snapshot = orderSnapshotRef.current;
    orderSnapshotRef.current = null;
    if (snapshot === null) {
      return;
    }
    try {
      const list = await api.reorderVehicles(vehiclesRef.current.map((vehicle) => vehicle.id));
      setVehicles(list);
    } catch (err) {
      // Bei einem Speicherfehler wird die vorherige Reihenfolge wiederhergestellt.
      setVehicles(snapshot);
      showNotice(toApiError(err).message);
    }
  }

  // ---------- Fahrzeuge: archivieren ----------

  function archiveVehicle(id: string) {
    if (isDraftId(id)) {
      setVehicleDrafts((prev) => prev.filter((entry) => entry.draftId !== id));
      clearFieldError(id);
      return;
    }
    void archiveStoredVehicle(id);
  }

  async function archiveStoredVehicle(id: string) {
    const vehicle = vehiclesRef.current.find((entry) => entry.id === id);
    if (!vehicle) {
      return;
    }
    const previousList = vehiclesRef.current;
    setVehicles((prev) => prev.filter((entry) => entry.id !== id));
    try {
      await api.archiveVehicle(id);
      void refreshCustomerSuggestions();
      const name = vehicle.licensePlate || vehicle.customerName || "Fahrzeug";
      showUndo(`${name} archiviert`, () => {
        setUndoState(null);
        void undoArchiveVehicle(id);
      });
    } catch (err) {
      setVehicles(previousList);
      showNotice(toApiError(err).message);
    }
  }

  async function undoArchiveVehicle(id: string) {
    try {
      await api.restoreVehicle(id);
      setVehicles(await api.listVehicles());
      void refreshCustomerSuggestions();
    } catch (err) {
      showNotice(toApiError(err).message);
    }
  }

  // ---------- Zahlungen ----------

  function addPayment() {
    const draft: PaymentDraft = {
      draftId: `draft-p-${crypto.randomUUID()}`,
      customerName: "",
      amountCents: null,
      note: "",
    };
    setPaymentDrafts((prev) => [draft, ...prev]);
    setAutoFocusId(draft.draftId);
  }

  function updatePaymentDraft(draftId: string, patch: Partial<PaymentDraft>) {
    const current = paymentDraftsRef.current.find((draft) => draft.draftId === draftId);
    if (!current) {
      return;
    }
    const next = { ...current, ...patch };
    setPaymentDrafts((prev) => prev.map((draft) => (draft.draftId === draftId ? next : draft)));
    for (const field of Object.keys(patch)) {
      clearFieldError(draftId, field);
    }
  }

  async function createPaymentFromDraft(draft: PaymentDraft) {
    try {
      const created = await api.createPayment({
        customerName: draft.customerName,
        amountCents: draft.amountCents ?? 0,
        note: draft.note,
      });
      setPaymentDrafts((prev) => prev.filter((entry) => entry.draftId !== draft.draftId));
      clearFieldError(draft.draftId);
      setPayments((prev) => [...prev, created]);
    } catch (err) {
      const apiErr = toApiError(err);
      setFieldError(draft.draftId, apiErr.field ?? "customerName", apiErr.message);
    } finally {
      creatingRef.current.delete(draft.draftId);
    }
  }

  function handlePaymentDraftRowLeave(draftId: string) {
    window.setTimeout(() => {
      const draft = paymentDraftsRef.current.find((entry) => entry.draftId === draftId);
      if (!draft || creatingRef.current.has(draftId)) {
        return;
      }
      if (isPaymentDraftEmpty(draft)) {
        setPaymentDrafts((prev) => prev.filter((entry) => entry.draftId !== draftId));
        clearFieldError(draftId);
      } else if (isPaymentDraftComplete(draft)) {
        creatingRef.current.add(draftId);
        void createPaymentFromDraft(draft);
      } else {
        const existing = fieldErrorsRef.current[draftId] ?? {};
        if (draft.customerName.trim() === "" && existing.customerName === undefined) {
          setFieldError(draftId, "customerName", "Kunde angeben");
        } else if (draft.customerName.trim() !== "" && existing.amountCents === undefined) {
          setFieldError(draftId, "amountCents", "Betrag angeben");
        }
      }
    }, 0);
  }

  function commitPaymentText(id: string, field: PaymentTextField, value: string) {
    if (isDraftId(id)) {
      updatePaymentDraft(id, { [field]: value });
      return;
    }
    void savePaymentPatch(id, { [field]: value });
  }

  function commitPaymentAmount(id: string, raw: string) {
    if (raw === "") {
      if (isDraftId(id)) {
        updatePaymentDraft(id, { amountCents: null });
      } else {
        setFieldError(id, "amountCents", "Betrag angeben");
      }
      return;
    }
    const cents = parseEuroInput(raw);
    if (cents === null || cents <= 0) {
      setFieldError(id, "amountCents", "Ungültiger Betrag, z. B. 486,50");
      return;
    }
    clearFieldError(id, "amountCents");
    if (isDraftId(id)) {
      updatePaymentDraft(id, { amountCents: cents });
    } else {
      void savePaymentPatch(id, { amountCents: cents });
    }
  }

  async function savePaymentPatch(id: string, patch: api.PaymentPatch) {
    const payment = paymentsRef.current.find((entry) => entry.id === id);
    if (!payment) {
      return;
    }
    const fields = Object.keys(patch);
    for (const field of fields) {
      clearFieldError(id, field);
    }
    const unchanged = fields.every(
      (field) => payment[field as keyof api.PaymentPatch] === patch[field as keyof api.PaymentPatch],
    );
    if (unchanged) {
      return;
    }
    const previous = payment;
    setPayments((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
    try {
      const saved = await api.updatePayment(id, patch);
      setPayments((prev) => prev.map((entry) => (entry.id === id ? saved : entry)));
    } catch (err) {
      const apiErr = toApiError(err);
      setPayments((prev) => prev.map((entry) => (entry.id === id ? previous : entry)));
      setFieldError(id, apiErr.field ?? fields[0] ?? "customerName", apiErr.message);
    }
  }

  function markPaymentPaid(id: string) {
    void markStoredPaymentPaid(id);
  }

  async function markStoredPaymentPaid(id: string) {
    const payment = paymentsRef.current.find((entry) => entry.id === id);
    if (!payment) {
      return;
    }
    const previousList = paymentsRef.current;
    setPayments((prev) => prev.filter((entry) => entry.id !== id));
    try {
      await api.markPaymentPaid(id);
      showUndo(`Zahlung von ${payment.customerName} als bezahlt markiert`, () => {
        setUndoState(null);
        void undoPaymentPaid(id);
      });
    } catch (err) {
      setPayments(previousList);
      showNotice(toApiError(err).message);
    }
  }

  async function undoPaymentPaid(id: string) {
    try {
      await api.restorePayment(id);
      setPayments(await api.listOpenPayments());
    } catch (err) {
      showNotice(toApiError(err).message);
    }
  }

  // ---------- Versteckter Bereich ----------

  function openHiddenArea() {
    // Mehrfachauslösung während oder nach dem Session-Start ist wirkungslos.
    if (hiddenOpenRef.current || secretOpeningRef.current) return;
    secretOpeningRef.current = true;
    void beginAndLoadSecretArea();
  }

  async function beginAndLoadSecretArea() {
    try {
      const token = await api.beginSecretSession();
      secretSessionTokenRef.current = token;
      setSecretSessionToken(token);
      hiddenOpenRef.current = true;
      setHiddenOpen(true);
      setHiddenStatus({ unlocked: true });
      const entries = await api.listHiddenEntries(token);
      if (secretSessionTokenRef.current === token) {
        setHiddenEntries(entries);
        if (historyOpenRef.current) {
          setSecretHistory([]);
          void loadHistoryWorkspace();
        }
      }
    } catch (err) {
      // Auch ein Schlüssel-/Sessionfehler bleibt als sicherer, gesperrter Zustand sichtbar.
      if (secretSessionTokenRef.current === null) {
        hiddenOpenRef.current = true;
        setHiddenOpen(true);
      }
      setHiddenStatus({ unlocked: false, error: toApiError(err) });
      setHiddenEntries([]);
    } finally {
      secretOpeningRef.current = false;
    }
  }

  async function reloadHiddenEntries(token = secretSessionTokenRef.current) {
    if (token === null) return;
    try {
      const entries = await api.listHiddenEntries(token);
      if (secretSessionTokenRef.current === token) {
        setHiddenStatus({ unlocked: true });
        setHiddenEntries(entries);
      }
    } catch (err) {
      if (secretSessionTokenRef.current === token) {
        setHiddenStatus({ unlocked: false, error: toApiError(err) });
        setHiddenEntries([]);
      }
    }
  }

  function openHistoryWorkspace() {
    historyOpenRef.current = true;
    setVehicleHistory([]);
    setSecretHistory([]);
    setHistoryOpen(true);
    setHistorySearch("");
    void loadHistoryWorkspace();
  }

  async function loadHistoryWorkspace() {
    const token = secretSessionTokenRef.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const vehiclesResult = await api.listCompletedVehicleHistory();
      if (!historyOpenRef.current) return;
      setVehicleHistory(vehiclesResult);

      if (token !== null && secretSessionTokenRef.current === token) {
        try {
          const secretsResult = await api.listEncryptedSecretHistory(token);
          if (historyOpenRef.current && secretSessionTokenRef.current === token) {
            setSecretHistory(secretsResult);
          }
        } catch (err) {
          if (historyOpenRef.current && secretSessionTokenRef.current === token) {
            setSecretHistory([]);
            showNotice(toApiError(err).message);
          }
        }
      } else if (secretSessionTokenRef.current === null) {
        setSecretHistory([]);
      }
    } catch (err) {
      if (historyOpenRef.current) setHistoryError(toApiError(err).message);
    } finally {
      if (historyOpenRef.current && secretSessionTokenRef.current === token) {
        setHistoryLoading(false);
      }
    }
  }

  function closeHistoryWorkspace() {
    historyOpenRef.current = false;
    setHistoryOpen(false);
    setHistorySearch("");
    setVehicleHistory([]);
    setSecretHistory([]);
    setHistoryError(null);
    setHistoryLoading(false);
  }

  function closeHiddenArea() {
    const token = secretSessionTokenRef.current;
    // Erst synchron alle Secret-Klartextdaten entfernen, dann best-effort beenden.
    // Eine bereits geöffnete öffentliche Fahrzeughistorie bleibt sichtbar.
    secretSessionTokenRef.current = null;
    hiddenOpenRef.current = false;
    setSecretSessionToken(null);
    setHiddenOpen(false);
    setHiddenStatus(null);
    setHiddenEntries([]);
    setHiddenDrafts([]);
    setSecretHistory([]);
    setUndoState(null);
    setAutoFocusId(null);
    setFieldErrors((previous) => {
      const next = { ...previous };
      for (const draft of hiddenDraftsRef.current) delete next[draft.draftId];
      for (const entry of hiddenEntriesRef.current) delete next[entry.id];
      return next;
    });
    hiddenEntriesRef.current = [];
    hiddenDraftsRef.current = [];
    secretHistoryRef.current = [];
    if (token !== null) void api.endSecretSession(token).catch(() => undefined);
    if (historyOpenRef.current) void loadHistoryWorkspace();
  }

  function addHiddenEntry() {
    if (secretSessionTokenRef.current === null) return;
    const draft: HiddenEntryDraft = {
      draftId: `draft-h-${crypto.randomUUID()}`,
      name: "",
      amountCents: null,
      note: "",
    };
    setHiddenDrafts((prev) => [draft, ...prev]);
    setAutoFocusId(draft.draftId);
  }

  function updateHiddenDraft(draftId: string, patch: Partial<HiddenEntryDraft>) {
    const current = hiddenDraftsRef.current.find((draft) => draft.draftId === draftId);
    if (!current) {
      return;
    }
    const next = { ...current, ...patch };
    setHiddenDrafts((prev) => prev.map((draft) => (draft.draftId === draftId ? next : draft)));
    for (const field of Object.keys(patch)) {
      clearFieldError(draftId, field);
    }
  }

  async function createHiddenFromDraft(draft: HiddenEntryDraft) {
    const token = secretSessionTokenRef.current;
    if (token === null) {
      creatingRef.current.delete(draft.draftId);
      return;
    }
    try {
      const created = await api.createHiddenEntry(token, {
        name: draft.name,
        amountCents: draft.amountCents ?? 0,
        note: draft.note,
      });
      if (secretSessionTokenRef.current !== token) return;
      setHiddenDrafts((prev) => prev.filter((entry) => entry.draftId !== draft.draftId));
      clearFieldError(draft.draftId);
      setHiddenEntries((prev) => [...prev, created]);
    } catch (err) {
      if (secretSessionTokenRef.current === token) {
        const apiErr = toApiError(err);
        setFieldError(draft.draftId, apiErr.field ?? "name", apiErr.message);
      }
    } finally {
      creatingRef.current.delete(draft.draftId);
    }
  }

  function handleHiddenDraftRowLeave(draftId: string) {
    window.setTimeout(() => {
      const draft = hiddenDraftsRef.current.find((entry) => entry.draftId === draftId);
      if (!draft || creatingRef.current.has(draftId)) {
        return;
      }
      if (isHiddenDraftEmpty(draft)) {
        setHiddenDrafts((prev) => prev.filter((entry) => entry.draftId !== draftId));
        clearFieldError(draftId);
      } else if (isHiddenDraftComplete(draft)) {
        creatingRef.current.add(draftId);
        void createHiddenFromDraft(draft);
      } else {
        const existing = fieldErrorsRef.current[draftId] ?? {};
        if (draft.name.trim() === "" && existing.name === undefined) {
          setFieldError(draftId, "name", "Bezeichnung angeben");
        } else if (draft.name.trim() !== "" && existing.amountCents === undefined) {
          setFieldError(draftId, "amountCents", "Betrag angeben");
        }
      }
    }, 0);
  }

  function commitHiddenText(id: string, field: HiddenTextField, value: string) {
    if (isDraftId(id)) {
      updateHiddenDraft(id, { [field]: value });
      return;
    }
    void saveHiddenPatch(id, { [field]: value });
  }

  function commitHiddenAmount(id: string, raw: string) {
    if (raw === "") {
      if (isDraftId(id)) {
        updateHiddenDraft(id, { amountCents: null });
      } else {
        setFieldError(id, "amountCents", "Betrag angeben");
      }
      return;
    }
    const cents = parseEuroInput(raw);
    if (cents === null || cents <= 0) {
      setFieldError(id, "amountCents", "Ungültiger Betrag, z. B. 486,50");
      return;
    }
    clearFieldError(id, "amountCents");
    if (isDraftId(id)) {
      updateHiddenDraft(id, { amountCents: cents });
    } else {
      void saveHiddenPatch(id, { amountCents: cents });
    }
  }

  async function saveHiddenPatch(id: string, patch: api.HiddenEntryPatch) {
    const token = secretSessionTokenRef.current;
    if (token === null) return;
    const entry = hiddenEntriesRef.current.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    const fields = Object.keys(patch);
    for (const field of fields) {
      clearFieldError(id, field);
    }
    const unchanged = fields.every(
      (field) =>
        entry[field as keyof api.HiddenEntryPatch] === patch[field as keyof api.HiddenEntryPatch],
    );
    if (unchanged) {
      return;
    }
    const previous = entry;
    setHiddenEntries((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
    try {
      const saved = await api.updateHiddenEntry(token, id, patch);
      if (secretSessionTokenRef.current === token) {
        setHiddenEntries((prev) => prev.map((item) => (item.id === id ? saved : item)));
      }
    } catch (err) {
      if (secretSessionTokenRef.current === token) {
        const apiErr = toApiError(err);
        setHiddenEntries((prev) => prev.map((item) => (item.id === id ? previous : item)));
        setFieldError(id, apiErr.field ?? fields[0] ?? "name", apiErr.message);
      }
    }
  }

  function archiveHiddenEntry(id: string) {
    if (isDraftId(id)) {
      setHiddenDrafts((prev) => prev.filter((entry) => entry.draftId !== id));
      clearFieldError(id);
      return;
    }
    void archiveStoredHiddenEntry(id);
  }

  async function archiveStoredHiddenEntry(id: string) {
    const token = secretSessionTokenRef.current;
    if (token === null) return;
    const entry = hiddenEntriesRef.current.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    const previousList = hiddenEntriesRef.current;
    setHiddenEntries((prev) => prev.filter((item) => item.id !== id));
    try {
      await api.archiveHiddenEntry(token, id);
      if (secretSessionTokenRef.current !== token) return;
      const name = entry.name || "Eintrag";
      showUndo(`${name} archiviert`, () => {
        setUndoState(null);
        void undoArchiveHiddenEntry(id);
      });
    } catch (err) {
      if (secretSessionTokenRef.current === token) {
        setHiddenEntries(previousList);
        showNotice(toApiError(err).message);
      }
    }
  }

  async function undoArchiveHiddenEntry(id: string) {
    const token = secretSessionTokenRef.current;
    if (token === null) return;
    try {
      await api.restoreHiddenEntry(token, id);
      await reloadHiddenEntries(token);
    } catch (err) {
      if (secretSessionTokenRef.current === token) showNotice(toApiError(err).message);
    }
  }

  // ---------- Backup und Wiederherstellung ----------

  function handleBackup() {
    return api.createBackup();
  }

  function handlePrepareRestore() {
    return api.prepareRestore();
  }

  async function handleConfirmRestore() {
    await api.confirmRestore();
    // Das Backend invalidiert beim Datenbanktausch alle Secret-Sitzungen.
    closeHiddenArea();
    setVehicleDrafts([]);
    setPaymentDrafts([]);
    setFieldErrors({});
    setUndoState(null);
    const [vehicleList, paymentList, suggestions, preferences] = await Promise.all([
      api.listVehicles(),
      api.listOpenPayments(),
      api.listCustomerSuggestions().catch(() => []),
      api.getUiPreferences().catch(() => ({
        paymentsPanelCollapsed: false,
        vehicleColumnOrder: [...VEHICLE_COLUMN_IDS],
      })),
    ]);
    setVehicles(vehicleList);
    setPayments(paymentList);
    setCustomerSuggestions(suggestions);
    setPaymentsCollapsed(preferences.paymentsPanelCollapsed);
    setVehicleColumnOrder(preferences.vehicleColumnOrder);
  }

  function handleCancelRestore() {
    return api.cancelRestore();
  }

  return (
    <AppShell
      header={
        <Header
          search={search}
          onSearchChange={setSearch}
          onAddVehicle={addVehicle}
          onOpenHistory={openHistoryWorkspace}
          onOpenHiddenArea={openHiddenArea}
          onBackup={handleBackup}
          onPrepareRestore={handlePrepareRestore}
          onConfirmRestore={handleConfirmRestore}
          onCancelRestore={handleCancelRestore}
          searchRef={searchRef}
        />
      }
    >
      {historyOpen ? (
        <HistoryWorkspace
          vehicleHistory={vehicleHistory}
          secretHistory={secretHistory}
          search={historySearch}
          loading={historyLoading}
          error={historyError}
          secretUnlocked={secretSessionToken !== null && hiddenStatus?.unlocked === true}
          onSearchChange={setHistorySearch}
          onRetry={() => void loadHistoryWorkspace()}
          onBack={closeHistoryWorkspace}
          onCloseSession={closeHiddenArea}
        />
      ) : (
        <>
          <section className="vehicle-section" aria-label="Fahrzeuge">
            <VehicleTable
              vehicles={visibleVehicles}
              drafts={vehicleDrafts}
              columnOrder={vehicleColumnOrder}
              loading={loading}
              loadError={loadError}
              onRetryLoad={() => void loadCoreData()}
              autoFocusId={autoFocusId}
              fieldErrors={fieldErrors}
              onCommitText={commitVehicleText}
              onToggleStatus={toggleVehicleStatus}
              onArchive={archiveVehicle}
              onDraftRowLeave={handleVehicleDraftRowLeave}
              onMove={moveVehicle}
              onColumnOrderChange={changeVehicleColumnOrder}
            />
          </section>
          <div className={hiddenOpen ? "bottom-area is-split" : "bottom-area"}>
            <PaymentsPanel
              payments={payments}
              drafts={paymentDrafts}
              suggestions={customerSuggestions}
              collapsed={paymentsCollapsed}
              autoFocusId={autoFocusId}
              fieldErrors={fieldErrors}
              onToggleCollapsed={togglePaymentsCollapsed}
              onAdd={addPayment}
              onCommitText={commitPaymentText}
              onCommitAmount={commitPaymentAmount}
              onMarkPaid={markPaymentPaid}
              onDraftRowLeave={handlePaymentDraftRowLeave}
            />
            {hiddenOpen && (
              <HiddenPanel
                status={hiddenStatus}
                entries={hiddenEntries}
                drafts={hiddenDrafts}
                autoFocusId={autoFocusId}
                fieldErrors={fieldErrors}
                onAdd={addHiddenEntry}
                onCommitText={commitHiddenText}
                onCommitAmount={commitHiddenAmount}
                onArchive={archiveHiddenEntry}
                onDraftRowLeave={handleHiddenDraftRowLeave}
                onClose={closeHiddenArea}
              />
            )}
          </div>
        </>
      )}
      {notice !== null && (
        <div key={notice.id} className="error-notice" role="alert">
          {notice.message}
        </div>
      )}
      {undoState !== null && (
        <UndoBar
          key={undoState.id}
          message={undoState.message}
          onUndo={undoState.undo}
          onDismiss={() => setUndoState(null)}
        />
      )}
    </AppShell>
  );
}
