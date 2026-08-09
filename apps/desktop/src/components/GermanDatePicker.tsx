import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { localDateKey } from "../appointments";

interface GermanDatePickerProps {
  value: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const GERMAN_DATE_PATTERN = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s*$/;
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;
const CALENDAR_HEIGHT = 270;
const CALENDAR_GAP = 6;
const MONTH_FORMATTER = new Intl.DateTimeFormat("de-DE", {
  month: "long",
  year: "numeric",
});
const DAY_FORMATTER = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

function validLocalDate(year: number, month: number, day: number): Date | null {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const result = new Date(year, month - 1, day, 12);
  return result.getFullYear() === year &&
    result.getMonth() === month - 1 &&
    result.getDate() === day
    ? result
    : null;
}

function dateFromIso(value: string): Date | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) return null;
  return validLocalDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function parseGermanDate(value: string): string | null {
  const match = GERMAN_DATE_PATTERN.exec(value);
  if (match === null) return null;
  const date = validLocalDate(Number(match[3]), Number(match[2]), Number(match[1]));
  return date === null ? null : localDateKey(date);
}

function formatGermanDate(value: string): string {
  const date = dateFromIso(value);
  if (date === null) return "";
  return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}.${date.getFullYear()}`;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function calendarDays(month: Date): Date[] {
  const first = monthStart(month);
  const daysBeforeMonday = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - daysBeforeMonday);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

export function GermanDatePicker({
  value,
  autoFocus = false,
  onChange,
}: GermanDatePickerProps) {
  const initialDate = dateFromIso(value) ?? new Date();
  const [text, setText] = useState(() => formatGermanDate(value));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarAbove, setCalendarAbove] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(initialDate));
  const [focusedDate, setFocusedDate] = useState(() => localDateKey(initialDate));
  const rootRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const dayRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const inputId = useId();
  const hintId = useId();
  const calendarTitleId = useId();
  const parsedText = parseGermanDate(text);
  const invalid = text.trim() !== "" && parsedText === null;

  useEffect(() => {
    if (!calendarOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setCalendarOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [calendarOpen]);

  useEffect(() => {
    if (calendarOpen) {
      dayRefs.current.get(focusedDate)?.focus();
    }
  }, [calendarOpen, focusedDate, visibleMonth]);

  function handleTextChange(event: ChangeEvent<HTMLInputElement>) {
    const nextText = event.currentTarget.value.slice(0, 10);
    const nextDate = parseGermanDate(nextText);
    setText(nextText);
    onChange(nextDate ?? "");
  }

  function normalizeText() {
    const parsed = parseGermanDate(text);
    if (parsed !== null) setText(formatGermanDate(parsed));
  }

  function toggleCalendar() {
    if (!calendarOpen) {
      const selected = dateFromIso(value);
      if (selected !== null) {
        setVisibleMonth(monthStart(selected));
        setFocusedDate(localDateKey(selected));
      }
      const rect = controlRef.current?.getBoundingClientRect();
      setCalendarAbove(
        rect !== undefined &&
          rect.bottom + CALENDAR_GAP + CALENDAR_HEIGHT > window.innerHeight &&
          rect.top >= CALENDAR_GAP + CALENDAR_HEIGHT,
      );
    }
    setCalendarOpen((current) => !current);
  }

  function selectDate(date: Date) {
    const nextDate = localDateKey(date);
    setText(formatGermanDate(nextDate));
    onChange(nextDate);
    setCalendarOpen(false);
    toggleRef.current?.focus();
  }

  function changeMonth(offset: number) {
    const nextMonth = new Date(
      visibleMonth.getFullYear(),
      visibleMonth.getMonth() + offset,
      1,
      12,
    );
    setVisibleMonth(nextMonth);
    setFocusedDate(localDateKey(nextMonth));
  }

  function moveCalendarFocus(event: KeyboardEvent<HTMLButtonElement>, date: Date) {
    let target: Date | null = null;
    if (event.key === "ArrowLeft") {
      target = new Date(date);
      target.setDate(date.getDate() - 1);
    } else if (event.key === "ArrowRight") {
      target = new Date(date);
      target.setDate(date.getDate() + 1);
    } else if (event.key === "ArrowUp") {
      target = new Date(date);
      target.setDate(date.getDate() - 7);
    } else if (event.key === "ArrowDown") {
      target = new Date(date);
      target.setDate(date.getDate() + 7);
    } else if (event.key === "Home") {
      target = new Date(date);
      target.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    } else if (event.key === "End") {
      target = new Date(date);
      target.setDate(date.getDate() + (6 - ((date.getDay() + 6) % 7)));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      const offset = event.key === "PageUp" ? -1 : 1;
      target = new Date(date.getFullYear(), date.getMonth() + offset, date.getDate(), 12);
    }
    if (target === null) return;
    event.preventDefault();
    setVisibleMonth(monthStart(target));
    setFocusedDate(localDateKey(target));
  }

  function handleRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (calendarOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setCalendarOpen(false);
      toggleRef.current?.focus();
    }
  }

  const days = calendarDays(visibleMonth);
  const selectedDate = dateFromIso(value);
  const selectedKey = selectedDate === null ? "" : localDateKey(selectedDate);
  const todayKey = localDateKey(new Date());

  return (
    <div ref={rootRef} className="appointment-date-field" onKeyDown={handleRootKeyDown}>
      <label htmlFor={inputId}>Datum</label>
      <div
        ref={controlRef}
        className={`appointment-date-control${invalid ? " is-invalid" : ""}`}
      >
        <input
          id={inputId}
          type="text"
          value={text}
          autoFocus={autoFocus}
          required
          inputMode="numeric"
          maxLength={10}
          placeholder="TT.MM.JJJJ"
          autoComplete="off"
          aria-describedby={invalid ? hintId : undefined}
          aria-invalid={invalid}
          onBlur={normalizeText}
          onChange={handleTextChange}
        />
        <button
          ref={toggleRef}
          type="button"
          className="appointment-date-toggle"
          aria-label="Kalender zur Datumsauswahl öffnen"
          aria-haspopup="dialog"
          aria-expanded={calendarOpen}
          onClick={toggleCalendar}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
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
        </button>
      </div>
      {invalid ? (
        <span id={hintId} className="appointment-date-error" role="alert">
          Bitte als TT.MM.JJJJ eingeben
        </span>
      ) : null}
      {calendarOpen ? (
        <div
          className={`appointment-date-calendar${calendarAbove ? " is-above" : ""}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={calendarTitleId}
        >
          <div className="appointment-date-calendar-header">
            <button
              type="button"
              aria-label="Vorheriger Monat"
              onClick={() => changeMonth(-1)}
            >
              ‹
            </button>
            <strong id={calendarTitleId} aria-live="polite">
              {MONTH_FORMATTER.format(visibleMonth)}
            </strong>
            <button type="button" aria-label="Nächster Monat" onClick={() => changeMonth(1)}>
              ›
            </button>
          </div>
          <div className="appointment-date-weekdays" aria-hidden="true">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="appointment-date-days">
            {days.map((date) => {
              const key = localDateKey(date);
              const outside = date.getMonth() !== visibleMonth.getMonth();
              const className = [
                outside ? "is-outside" : "",
                key === selectedKey ? "is-selected" : "",
                key === todayKey ? "is-today" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={key}
                  ref={(node) => {
                    if (node === null) dayRefs.current.delete(key);
                    else dayRefs.current.set(key, node);
                  }}
                  type="button"
                  className={className}
                  aria-label={DAY_FORMATTER.format(date)}
                  aria-pressed={key === selectedKey}
                  tabIndex={key === focusedDate ? 0 : -1}
                  onClick={() => selectDate(date)}
                  onKeyDown={(event) => moveCalendarFocus(event, date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
