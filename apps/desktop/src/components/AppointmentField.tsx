import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FormEvent, MouseEvent } from "react";
import { appointmentParts, formatAppointment, localDateKey } from "../appointments";
import { GermanDatePicker } from "./GermanDatePicker";

interface AppointmentFieldProps {
  appointmentAt: string | null;
  customerName: string;
  disabled?: boolean;
  onChange: (appointmentAt: string | null) => void;
}

interface PopoverPosition {
  left: number;
  top: number;
}

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 230;
const VIEWPORT_MARGIN = 8;

export function AppointmentField({
  appointmentAt,
  customerName,
  disabled = false,
  onChange,
}: AppointmentFieldProps) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [position, setPosition] = useState<PopoverPosition>({ left: 0, top: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const formatted = formatAppointment(appointmentAt);

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
    if (disabled) return;
    const current = appointmentParts(appointmentAt);
    setDate(current?.date ?? localDateKey(new Date()));
    setTime(current?.time ?? "");

    const rect = event.currentTarget.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
    );
    const top =
      rect.bottom + POPOVER_HEIGHT + VIEWPORT_MARGIN <= window.innerHeight
        ? rect.bottom + VIEWPORT_MARGIN
        : Math.max(VIEWPORT_MARGIN, rect.top - POPOVER_HEIGHT - VIEWPORT_MARGIN);
    setPosition({ left, top });
    setOpen(true);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (date === "") return;
    onChange(time === "" ? date : `${date}T${time}`);
    setOpen(false);
  }

  function remove() {
    onChange(null);
    setOpen(false);
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
        disabled={disabled}
        title={disabled ? "Termin nach dem Speichern des Fahrzeugs verfügbar" : "Termin bearbeiten"}
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
        <span>{formatted ?? (disabled ? "Nach Speichern" : "Termin hinzufügen")}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="appointment-popover"
              role="dialog"
              aria-label={`Termin für ${accessibleName} bearbeiten`}
              style={{ left: position.left, top: position.top }}
            >
              <div className="appointment-popover-heading">
                <span>Werkstatttermin</span>
                <strong>{accessibleName}</strong>
              </div>
              <form onSubmit={save}>
                <div className="appointment-inputs">
                  <GermanDatePicker value={date} autoFocus onChange={setDate} />
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
                <p>Die Uhrzeit kann leer bleiben. Änderungen werden direkt gespeichert.</p>
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
