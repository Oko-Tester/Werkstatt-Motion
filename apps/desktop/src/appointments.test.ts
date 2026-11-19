import { describe, expect, it } from "vitest";
import { groupAppointmentsByDay } from "./appointments";

describe("groupAppointmentsByDay", () => {
  it("ordnet Termine ihrem Tag zu, je Tag nach Uhrzeit und ohne Uhrzeit zuerst", () => {
    const later = { id: "spaet", appointmentAt: "2026-08-12T10:15" };
    const early = { id: "frueh", appointmentAt: "2026-08-12T08:30" };
    const allDay = { id: "ganztags", appointmentAt: "2026-08-12" };
    const nextDay = { id: "donnerstag", appointmentAt: "2026-08-13T09:00" };

    const grouped = groupAppointmentsByDay([later, nextDay, early, allDay]);

    expect([...grouped.keys()].sort()).toEqual(["2026-08-12", "2026-08-13"]);
    expect(grouped.get("2026-08-12")).toEqual([allDay, early, later]);
    expect(grouped.get("2026-08-13")).toEqual([nextDay]);
  });

  it("lässt Einträge ohne gültigen Termin weg", () => {
    const grouped = groupAppointmentsByDay([
      { id: "ohne", appointmentAt: null },
      { id: "kaputt", appointmentAt: "12.08.2026" },
    ]);

    expect(grouped.size).toBe(0);
  });
});
