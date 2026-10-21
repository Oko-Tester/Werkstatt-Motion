import { useMemo, useState } from "react";
import { appointmentDate, appointmentParts, localDateKey } from "../appointments";
import { HeaderActions, HeaderStart } from "../state/headerSlots";
import type { Vehicle } from "../types";

interface CalendarWorkspaceProps {
  vehicles: Vehicle[];
}

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function chooseInitialMonth(vehicles: Vehicle[]): Date {
  const today = startOfDay(new Date());
  const appointments = vehicles
    .map((vehicle) => appointmentDate(vehicle.appointmentAt))
    .filter((date): date is Date => date !== null)
    .sort((left, right) => left.getTime() - right.getTime());
  const nearest = appointments.find((date) => date >= today) ?? appointments.at(-1) ?? today;
  return new Date(nearest.getFullYear(), nearest.getMonth(), 1);
}

function calendarGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset);
  return Array.from({ length: 42 }, (_, index) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );
}

function monthTitle(month: Date): string {
  const title = month.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  return title.charAt(0).toLocaleUpperCase("de-DE") + title.slice(1);
}

function dayAccessibleLabel(date: Date): string {
  return date.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function CalendarWorkspace({ vehicles }: CalendarWorkspaceProps) {
  const [month, setMonth] = useState<Date>(() => chooseInitialMonth(vehicles));
  const monthYear = month.getFullYear();
  const monthIndex = month.getMonth();
  const days = useMemo(() => calendarGrid(month), [month]);
  const todayKey = localDateKey(new Date());

  const appointmentsByDay = useMemo(() => {
    const grouped = new Map<string, Vehicle[]>();
    for (const vehicle of vehicles) {
      const parts = appointmentParts(vehicle.appointmentAt);
      if (parts === null) continue;
      const entries = grouped.get(parts.date);
      if (entries === undefined) grouped.set(parts.date, [vehicle]);
      else entries.push(vehicle);
    }
    for (const entries of grouped.values()) {
      entries.sort((left, right) => {
        const leftTime = appointmentParts(left.appointmentAt)?.time ?? "";
        const rightTime = appointmentParts(right.appointmentAt)?.time ?? "";
        return leftTime.localeCompare(rightTime);
      });
    }
    return grouped;
  }, [vehicles]);

  const monthAppointmentCount = useMemo(
    () =>
      vehicles.reduce((count, vehicle) => {
        const parts = appointmentParts(vehicle.appointmentAt);
        return parts !== null && parts.year === monthYear && parts.month === monthIndex + 1
          ? count + 1
          : count;
      }, 0),
    [monthIndex, monthYear, vehicles],
  );

  function moveMonth(offset: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function showCurrentMonth() {
    const today = new Date();
    setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  }

  return (
    <section className="calendar-workspace" aria-label="Kalenderübersicht">
      <HeaderStart>
        <div className="header-heading">
          <h2>Terminkalender</h2>
          <p>Alle geplanten Fahrzeuge in einer gemeinsamen Monatsübersicht</p>
        </div>
      </HeaderStart>
      <HeaderActions>
        <div className="calendar-period" aria-live="polite">
          <strong>{monthTitle(month)}</strong>
          <span>
            {monthAppointmentCount === 1
              ? "1 Termin"
              : `${monthAppointmentCount} Termine`}
          </span>
        </div>
        <div className="calendar-navigation" aria-label="Kalenderzeitraum">
          <button
            type="button"
            className="icon-button"
            aria-label="Vorheriger Monat"
            title="Vorheriger Monat"
            onClick={() => moveMonth(-1)}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button type="button" className="btn btn-secondary" onClick={showCurrentMonth}>
            Heute
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Nächster Monat"
            title="Nächster Monat"
            onClick={() => moveMonth(1)}
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </HeaderActions>

      <div className="calendar-surface" role="grid" aria-label={monthTitle(month)}>
        <div className="calendar-weekdays" role="row">
          {WEEKDAYS.map((weekday) => (
            <div key={weekday} role="columnheader">
              {weekday}
            </div>
          ))}
        </div>
        <div className="calendar-days">
          {days.map((date) => {
            const dateKey = localDateKey(date);
            const entries = appointmentsByDay.get(dateKey) ?? [];
            const outsideMonth = date.getMonth() !== monthIndex;
            const className = [
              "calendar-day",
              outsideMonth ? "is-outside" : "",
              dateKey === todayKey ? "is-today" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={dateKey}
                role="gridcell"
                aria-label={dayAccessibleLabel(date)}
                className={className}
              >
                <div className="calendar-day-number">
                  <span>{date.getDate()}</span>
                  {dateKey === todayKey ? <small>Heute</small> : null}
                </div>
                <div className="calendar-appointments">
                  {entries.map((vehicle) => {
                    const parts = appointmentParts(vehicle.appointmentAt);
                    if (parts === null) return null;
                    return (
                      <article
                        key={vehicle.id}
                        className={`calendar-appointment${
                          parts.time === null ? " is-without-time" : ""
                        }`}
                      >
                        <div className="calendar-appointment-heading">
                          {parts.time === null ? (
                            <span className="calendar-appointment-time">Ohne Uhrzeit</span>
                          ) : (
                            <time dateTime={vehicle.appointmentAt ?? undefined}>{parts.time}</time>
                          )}
                          <strong>{vehicle.customerName}</strong>
                        </div>
                        <div className="calendar-appointment-details">
                          <span>{vehicle.vehicleName || "Fahrzeug ohne Angabe"}</span>
                          {vehicle.licensePlate !== "" ? <span>{vehicle.licensePlate}</span> : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
