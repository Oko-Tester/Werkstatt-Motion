export interface AppointmentParts {
  date: string;
  time: string | null;
  year: number;
  month: number;
  day: number;
  hour: number | null;
  minute: number | null;
}

const APPOINTMENT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const SHORT_WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;

/** Zerlegt die lokale, zeitzonenfreie Terminzeit aus SQLite. */
export function appointmentParts(value: string | null): AppointmentParts | null {
  if (value === null) return null;
  const match = APPOINTMENT_PATTERN.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  return {
    date: `${yearText}-${monthText}-${dayText}`,
    time: hourText === undefined || minuteText === undefined ? null : `${hourText}:${minuteText}`,
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: hourText === undefined ? null : Number(hourText),
    minute: minuteText === undefined ? null : Number(minuteText),
  };
}

/** Erzeugt ein lokales Date ohne UTC-Verschiebung für Kalenderberechnungen. */
export function appointmentDate(value: string | null): Date | null {
  const parts = appointmentParts(value);
  return parts === null
    ? null
    : new Date(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour ?? 0,
        parts.minute ?? 0,
      );
}

/** Kompakte Darstellung, wahlweise mit oder ohne Uhrzeit. */
export function formatAppointment(value: string | null): string | null {
  const parts = appointmentParts(value);
  if (parts === null) return null;
  const weekday = SHORT_WEEKDAYS[new Date(parts.year, parts.month - 1, parts.day).getDay()];
  const day = String(parts.day).padStart(2, "0");
  const month = String(parts.month).padStart(2, "0");
  const date = `${weekday} ${day}.${month}.`;
  return parts.time === null ? date : `${date} · ${parts.time}`;
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
