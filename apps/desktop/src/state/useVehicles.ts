import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { toApiError } from "../api";
import { VEHICLE_COLUMN_IDS } from "../types";
import type {
  Vehicle,
  VehicleColumnId,
  VehicleDraft,
  VehicleStatusField,
  VehicleTextField,
} from "../types";
import type { Feedback } from "./feedback";
import type { DraftSupport } from "./useDraftSupport";
import { isDraftId } from "./useDraftSupport";

const REORDER_DEBOUNCE_MS = 300;

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
    draft.note.trim() === "" &&
    !draft.tuvRequired &&
    !draft.partsOrdered &&
    !draft.partsArrived &&
    !draft.isDone
  );
}

interface VehiclesDeps {
  feedback: Feedback;
  drafts: DraftSupport;
  refreshCustomerSuggestions: () => Promise<void>;
}

/**
 * Die Fahrzeugliste: Fahrzeuge, neue Zeilen, Spalten, Suche, Reihenfolge und
 * Archiv. Lebt über Bereichswechsel hinweg, weil auch der Kalender dieselben
 * Fahrzeuge zeigt.
 */
export function useVehicles({ feedback, drafts, refreshCustomerSuggestions }: VehiclesDeps) {
  const { showNotice, showUndo, clearUndo } = feedback;
  const { clearFieldError, setFieldError, fieldErrorsRef, creatingRef, setAutoFocusId } = drafts;
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleDrafts, setVehicleDrafts] = useState<VehicleDraft[]>([]);
  const [vehicleColumnOrder, setVehicleColumnOrder] = useState<VehicleColumnId[]>([
    ...VEHICLE_COLUMN_IDS,
  ]);
  const [vehicleHiddenColumns, setVehicleHiddenColumns] = useState<VehicleColumnId[]>([]);
  const [search, setSearch] = useState("");

  // Spiegel der States für Handler, die nach dem Event (setTimeout) den
  // aktuellen Stand brauchen – z. B. das Verwerfen leerer Entwurfszeilen.
  const vehiclesRef = useRef(vehicles);
  vehiclesRef.current = vehicles;
  const vehicleDraftsRef = useRef(vehicleDrafts);
  vehicleDraftsRef.current = vehicleDrafts;

  const orderSnapshotRef = useRef<Vehicle[] | null>(null);
  const reorderTimerRef = useRef<number | null>(null);
  const appointmentSaveVersionRef = useRef<Map<string, number>>(new Map());

  useEffect(
    () => () => {
      if (reorderTimerRef.current !== null) {
        window.clearTimeout(reorderTimerRef.current);
      }
    },
    [],
  );

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

  function changeVehicleHiddenColumns(next: VehicleColumnId[]) {
    setVehicleHiddenColumns(next);
    void api.updateVehicleHiddenColumns(next).catch((err) => {
      // Ein Persistenzfehler nimmt dem Nutzer nicht die aktuelle Sitzungsauswahl.
      showNotice(toApiError(err).message);
    });
  }

  // ---------- Suche ----------

  const visibleVehicles = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query === "") {
      return vehicles;
    }
    return vehicles.filter((vehicle) =>
      [vehicle.customerName, vehicle.vehicleName, vehicle.licensePlate, vehicle.note].some((text) =>
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
      note: "",
      tuvRequired: false,
      partsOrdered: false,
      partsArrived: false,
      isDone: false,
    };
    // Suche leeren, damit die neue Zeile sicher sichtbar ist.
    setSearch("");
    setVehicleDrafts((prev) => [...prev, draft]);
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
        note: draft.note,
        tuvRequired: draft.tuvRequired,
        partsOrdered: draft.partsOrdered,
        partsArrived: draft.partsArrived,
        isDone: draft.isDone,
      });
      setVehicleDrafts((prev) => prev.filter((entry) => entry.draftId !== draft.draftId));
      clearFieldError(draft.draftId);
      setVehicles((prev) => [...prev, created]);
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

  function changeVehicleAppointment(id: string, appointmentAt: string | null) {
    const previous = vehiclesRef.current.find((vehicle) => vehicle.id === id);
    if (previous === undefined || previous.appointmentAt === appointmentAt) return;
    const saveVersion = (appointmentSaveVersionRef.current.get(id) ?? 0) + 1;
    appointmentSaveVersionRef.current.set(id, saveVersion);

    setVehicles((current) =>
      current.map((vehicle) =>
        vehicle.id === id ? { ...vehicle, appointmentAt } : vehicle,
      ),
    );
    void api
      .updateVehicleAppointment(id, appointmentAt)
      .then((saved) => {
        if (appointmentSaveVersionRef.current.get(id) !== saveVersion) return;
        appointmentSaveVersionRef.current.delete(id);
        setVehicles((current) =>
          current.map((vehicle) => (vehicle.id === id ? saved : vehicle)),
        );
      })
      .catch((err) => {
        if (appointmentSaveVersionRef.current.get(id) !== saveVersion) return;
        appointmentSaveVersionRef.current.delete(id);
        setVehicles((current) =>
          current.map((vehicle) => (vehicle.id === id ? previous : vehicle)),
        );
        showNotice(toApiError(err).message);
      });
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
        clearUndo();
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

  return {
    list: vehicles,
    visibleVehicles,
    drafts: vehicleDrafts,
    columnOrder: vehicleColumnOrder,
    hiddenColumns: vehicleHiddenColumns,
    search,
    setSearch,
    add: addVehicle,
    commitText: commitVehicleText,
    changeAppointment: changeVehicleAppointment,
    toggleStatus: toggleVehicleStatus,
    archive: archiveVehicle,
    onDraftRowLeave: handleVehicleDraftRowLeave,
    move: moveVehicle,
    changeColumnOrder: changeVehicleColumnOrder,
    changeHiddenColumns: changeVehicleHiddenColumns,
    setList: setVehicles,
    setDrafts: setVehicleDrafts,
    setColumnOrder: setVehicleColumnOrder,
    setHiddenColumns: setVehicleHiddenColumns,
  };
}
