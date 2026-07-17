import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "./components/AppShell";
import { Header } from "./components/Header";
import { PaymentsPanel } from "./components/PaymentsPanel";
import { UndoBar } from "./components/UndoBar";
import { VehicleTable } from "./components/VehicleTable";
import { mockPayments, mockVehicles } from "./data/mock";
import type { Payment, Vehicle } from "./types";

interface UndoState {
  id: number;
  message: string;
  undo: () => void;
}

const UNDO_TIMEOUT_MS = 6000;

export default function App() {
  const [vehicles, setVehicles] = useState<Vehicle[]>(mockVehicles);
  const [payments, setPayments] = useState<Payment[]>(mockPayments);
  const [search, setSearch] = useState("");
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  const undoCounter = useRef(0);

  useEffect(() => {
    if (!undoState) {
      return;
    }
    const timer = window.setTimeout(() => setUndoState(null), UNDO_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [undoState]);

  const visibleVehicles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return vehicles.filter((vehicle) => {
      if (vehicle.archiviert) {
        return false;
      }
      if (query === "") {
        return true;
      }
      return [vehicle.kunde, vehicle.fahrzeug, vehicle.kennzeichen].some((text) =>
        text.toLowerCase().includes(query),
      );
    });
  }, [vehicles, search]);

  const openPayments = useMemo(() => payments.filter((payment) => !payment.bezahlt), [payments]);

  function showUndo(message: string, undo: () => void) {
    undoCounter.current += 1;
    setUndoState({ id: undoCounter.current, message, undo });
  }

  function addVehicle() {
    const vehicle: Vehicle = {
      id: crypto.randomUUID(),
      kunde: "",
      fahrzeug: "",
      kennzeichen: "",
      tuevNoetig: false,
      teileBestellt: false,
      teileAngekommen: false,
      fertig: false,
      archiviert: false,
    };
    // Suche leeren, damit die neue Zeile sicher sichtbar ist.
    setSearch("");
    setVehicles((prev) => [vehicle, ...prev]);
    setAutoFocusId(vehicle.id);
  }

  function updateVehicle(id: string, patch: Partial<Vehicle>) {
    setVehicles((prev) => prev.map((vehicle) => (vehicle.id === id ? { ...vehicle, ...patch } : vehicle)));
  }

  function archiveVehicle(id: string) {
    const vehicle = vehicles.find((entry) => entry.id === id);
    if (!vehicle) {
      return;
    }
    updateVehicle(id, { archiviert: true });
    const name = vehicle.kennzeichen || vehicle.kunde || "Neues Fahrzeug";
    showUndo(`${name} archiviert`, () => {
      setVehicles((prev) => prev.map((entry) => (entry.id === id ? { ...entry, archiviert: false } : entry)));
      setUndoState(null);
    });
  }

  function moveVehicle(dragId: string, targetId: string) {
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
  }

  function markPaymentPaid(id: string) {
    const payment = payments.find((entry) => entry.id === id);
    if (!payment) {
      return;
    }
    setPayments((prev) => prev.map((entry) => (entry.id === id ? { ...entry, bezahlt: true } : entry)));
    showUndo(`Zahlung von ${payment.kunde} als bezahlt markiert`, () => {
      setPayments((prev) => prev.map((entry) => (entry.id === id ? { ...entry, bezahlt: false } : entry)));
      setUndoState(null);
    });
  }

  function handleBackup() {
    // Echte Backup-Logik folgt mit der SQLite-Anbindung in einem späteren Schritt.
  }

  return (
    <AppShell
      header={
        <Header
          search={search}
          onSearchChange={setSearch}
          onAddVehicle={addVehicle}
          onBackup={handleBackup}
        />
      }
    >
      <section className="vehicle-section" aria-label="Fahrzeuge">
        <VehicleTable
          vehicles={visibleVehicles}
          autoFocusId={autoFocusId}
          onUpdate={updateVehicle}
          onArchive={archiveVehicle}
          onMove={moveVehicle}
        />
      </section>
      <PaymentsPanel payments={openPayments} onMarkPaid={markPaymentPaid} />
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
