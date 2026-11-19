import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FormEvent, MouseEvent } from "react";
import {
  appointmentParts,
  formatAppointment,
  groupAppointmentsByDay,
  localDateKey,
} from "../appointments";
import { useWorkshop } from "../state/WorkshopProvider";
import type { Vehicle } from "../types";
import { GermanDatePicker } from "./GermanDatePicker";

interface AppointmentFieldProps {
  /** Das Fahrzeug dieser Zeile. Sein eigener Termin zählt nicht als Belegung. */
  vehicleId: string;
  appointmentAt: string | null;
  customerName: string;
  onChange: (appointmentAt: string | null) => void;
}

interface PopoverPosition {
  left: number;
  /** Das Fenster geht nach unten auf und wächst von dieser Kante weg … */
  top?: number;
  /** … oder nach oben, wenn unter der Zeile zu wenig Platz ist. */
  bottom?: number;
  listMaxHeight: number;
}

const POPOVER_WIDTH = 320;
/** Höhe des Fensters ohne die Liste der Termine. */
const POPOVER_BASE_HEIGHT = 250;
/** Sechs Termine passen ohne Scrollbalken. */
const LIST_MAX_HEIGHT = 140;
const LIST_MIN_HEIGHT = 66;
const VIEWPORT_MARGIN = 8;
const NO_APPOINTMENTS = new Map<string, Vehicle[]>();

/** Was an dem Tag schon eingetragen ist: Am Telefon sieht man sofort, ob er passt. */
function DayOccupancy({
  date,
  entries,
  maxHeight,
}: {
  date: string;
  entries: readonly Vehicle[];
  maxHeight: number;
}) {
  const summary =
    entries.length === 0
      ? "frei"
      : entries.length === 1
        ? "1 Termin"
        : `${entries.length} Termine`;

  return (
    <div className="appointment-day" role="group" aria-label="Belegung des Tages">
      <p
        className={
          entries.length === 0 ? "appointment-day-title is-free" : "appointment-day-title"
        }
        aria-live="polite"
      >
        {formatAppointment(date)} · {summary}
      </p>
      {entries.length > 0 ? (
        <ul className="appointment-day-list" style={{ maxHeight }}>
          {entries.map((entry) => (
            <li key={entry.id}>
              <span className="appointment-day-time">
                {appointmentParts(entry.appointmentAt)?.time ?? "Ohne Zeit"}
              </span>
              <strong>{entry.customerName}</strong>
              <span className="appointment-day-vehicle">{entry.vehicleName}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AppointmentField({
  vehicleId,
  appointmentAt,
  customerName,
  onChange,
}: AppointmentFieldProps) {
  const { vehicles } = useWorkshop();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [position, setPosition] = useState<PopoverPosition>({
    left: 0,
    top: 0,
    listMaxHeight: LIST_MAX_HEIGHT,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const formatted = formatAppointment(appointmentAt);
  // Die volle Fahrzeugliste, nicht die gefilterte: Eine Suche ändert nichts an der Belegung.
  const appointmentsByDay = useMemo(
    () =>
      open
        ? groupAppointmentsByDay(vehicles.list.filter((entry) => entry.id !== vehicleId))
        : NO_APPOINTMENTS,
    [open, vehicleId, vehicles.list],
  );

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function openEditor(event: MouseEvent<HTMLButtonElement>) {
    const current = appointmentParts(appointmentAt);
    setDate(current?.date ?? localDateKey(new Date()));
    setTime(current?.time ?? "");

    const rect = event.currentTarget.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
    );
    // Die Seite wird einmal gewählt und reicht für die längste Liste. So springt das
    // Fenster nicht, wenn ein anderer Tag mehr Termine hat.
    const spaceBelow = window.innerHeight - rect.bottom - 2 * VIEWPORT_MARGIN;
    const spaceAbove = rect.top - 2 * VIEWPORT_MARGIN;
    const opensBelow =
      spaceBelow >= POPOVER_BASE_HEIGHT + LIST_MAX_HEIGHT || spaceBelow >= spaceAbove;
    const space = opensBelow ? spaceBelow : spaceAbove;
    setPosition({
      left,
      ...(opensBelow
        ? { top: rect.bottom + VIEWPORT_MARGIN }
        : { bottom: window.innerHeight - rect.top + VIEWPORT_MARGIN }),
      listMaxHeight: Math.max(
        LIST_MIN_HEIGHT,
        Math.min(LIST_MAX_HEIGHT, space - POPOVER_BASE_HEIGHT),
      ),
    });
    setOpen(true);
  }

  // Der Fokus geht zurück auf den Termin-Button, bevor die Auswahl verschwindet.
  // Sonst würde das Entfernen des fokussierten Felds die Tabellenzeile verlassen.
  function close() {
    buttonRef.current?.focus();
    setOpen(false);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (date === "") return;
    close();
    onChange(time === "" ? date : `${date}T${time}`);
  }

  function remove() {
    close();
    onChange(null);
  }

  const accessibleName = customerName.trim() || "Neues Fahrzeug";

  return (
    <div className="appointment-field">
      <button
        ref={buttonRef}
        type="button"
        className={formatted === null ? "appointment-trigger is-empty" : "appointment-trigger"}
        aria-label={`Termin für ${accessibleName}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Termin bearbeiten"
        onClick={openEditor}
      >
        <svg
          aria-hidden="true"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <rect width="18" height="18" x="3" y="4" rx="2" />
          <path d="M3 10h18" />
        </svg>
        <span>{formatted ?? "Termin hinzufügen"}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="appointment-popover"
              role="dialog"
              aria-label={`Termin für ${accessibleName} bearbeiten`}
              // Das Portal liegt im body; der Fokus darin gehört weiter zur Tabellenzeile.
              data-keeps-row-focus="true"
              style={{ left: position.left, top: position.top, bottom: position.bottom }}
            >
              <div className="appointment-popover-heading">
                <span>Werkstatttermin</span>
                <strong>{accessibleName}</strong>
              </div>
              <form onSubmit={save}>
                <div className="appointment-inputs">
                  <GermanDatePicker
                    value={date}
                    autoFocus
                    onChange={setDate}
                    countAppointments={(day) => appointmentsByDay.get(day)?.length ?? 0}
                  />
                  <label>
                    <span className="appointment-time-label">
                      Uhrzeit <small>optional</small>
                    </span>
                    <input
                      type="time"
                      aria-label="Uhrzeit"
                      value={time}
                      step={300}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  </label>
                </div>
                {date !== "" ? (
                  <DayOccupancy
                    date={date}
                    entries={appointmentsByDay.get(date) ?? []}
                    maxHeight={position.listMaxHeight}
                  />
                ) : null}
                <div className="appointment-popover-actions">
                  {appointmentAt !== null ? (
                    <button type="button" className="btn appointment-remove" onClick={remove}>
                      Termin entfernen
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={date === ""}
                  >
                    Termin speichern
                  </button>
                </div>
              </form>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
