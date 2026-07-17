import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import { toApiError } from "./api";
import { AppShell } from "./components/AppShell";
import { Header } from "./components/Header";
import { PaymentsPanel } from "./components/PaymentsPanel";
import { UndoBar } from "./components/UndoBar";
import { VehicleTable } from "./components/VehicleTable";
import { parseEuroInput } from "./money";
import type {
  FieldErrors,
  Payment,
  PaymentDraft,
  PaymentTextField,
  Vehicle,
  VehicleDraft,
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

export default function App() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleDrafts, setVehicleDrafts] = useState<VehicleDraft[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);
  const [loading, setLoading] = useState(true);
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
  const fieldErrorsRef = useRef(fieldErrors);
  fieldErrorsRef.current = fieldErrors;

  const counterRef = useRef(0);
  const creatingRef = useRef(new Set<string>());
  const orderSnapshotRef = useRef<Vehicle[] | null>(null);
  const reorderTimerRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ---------- Laden, Hinweise, Undo ----------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [vehicleList, paymentList] = await Promise.all([
          api.listVehicles(),
          api.listOpenPayments(),
        ]);
        if (!cancelled) {
          setVehicles(vehicleList);
          setPayments(paymentList);
        }
      } catch (err) {
        if (!cancelled) {
          showNotice(toApiError(err).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
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

  function handleBackup() {
    // Echte Backup-Logik folgt in einem späteren Schritt.
  }

  return (
    <AppShell
      header={
        <Header
          search={search}
          onSearchChange={setSearch}
          onAddVehicle={addVehicle}
          onBackup={handleBackup}
          searchRef={searchRef}
        />
      }
    >
      <section className="vehicle-section" aria-label="Fahrzeuge">
        <VehicleTable
          vehicles={visibleVehicles}
          drafts={vehicleDrafts}
          loading={loading}
          autoFocusId={autoFocusId}
          fieldErrors={fieldErrors}
          onCommitText={commitVehicleText}
          onToggleStatus={toggleVehicleStatus}
          onArchive={archiveVehicle}
          onDraftRowLeave={handleVehicleDraftRowLeave}
          onMove={moveVehicle}
        />
      </section>
      <PaymentsPanel
        payments={payments}
        drafts={paymentDrafts}
        autoFocusId={autoFocusId}
        fieldErrors={fieldErrors}
        onAdd={addPayment}
        onCommitText={commitPaymentText}
        onCommitAmount={commitPaymentAmount}
        onMarkPaid={markPaymentPaid}
        onDraftRowLeave={handlePaymentDraftRowLeave}
      />
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
