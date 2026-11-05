import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarSignature, createGoogleSyncScheduler } from "./googleSync";
import type { Vehicle } from "./types";

function vehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: "v1",
    customerName: "Müller",
    vehicleName: "VW Golf",
    licensePlate: "AB-CD 123",
    note: "",
    tuvRequired: false,
    partsOrdered: false,
    partsArrived: false,
    isDone: false,
    appointmentAt: "2026-11-05T14:00",
    position: 0,
    createdAt: "2026-11-01T08:00:00Z",
    updatedAt: "2026-11-01T08:00:00Z",
    archivedAt: null,
    ...overrides,
  };
}

/** Lässt angestoßene Promise-Ketten durchlaufen. */
async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("calendarSignature", () => {
  it("ändert sich nur mit dem, was bei Google steht", () => {
    const base = calendarSignature([vehicle()]);
    expect(
      calendarSignature([
        vehicle({ note: "neu", tuvRequired: true, isDone: true, position: 3, updatedAt: "später" }),
      ]),
    ).toBe(base);
    for (const change of [
      { appointmentAt: "2026-11-05T15:00" },
      { appointmentAt: "2026-11-05" },
      { vehicleName: "Opel Corsa" },
      { customerName: "Meyer" },
      { licensePlate: "X-Y 1" },
    ]) {
      expect(calendarSignature([vehicle(change)])).not.toBe(base);
    }
  });

  it("zählt Fahrzeuge ohne Termin und archivierte nicht mit", () => {
    const empty = calendarSignature([]);
    expect(calendarSignature([vehicle({ appointmentAt: null })])).toBe(empty);
    expect(calendarSignature([vehicle({ archivedAt: "2026-11-05T10:00:00Z" })])).toBe(empty);
    expect(calendarSignature([vehicle(), vehicle({ id: "v2", appointmentAt: null })])).toBe(
      calendarSignature([vehicle()]),
    );
  });

  it("hängt nicht von der Reihenfolge der Liste ab", () => {
    const first = vehicle({ id: "a" });
    const second = vehicle({ id: "b", appointmentAt: "2026-11-06" });
    expect(calendarSignature([first, second])).toBe(calendarSignature([second, first]));
  });
});

describe("createGoogleSyncScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fasst Änderungen kurz hintereinander zu einem Lauf zusammen", async () => {
    const run = vi.fn(async () => {});
    const scheduler = createGoogleSyncScheduler(run);

    scheduler.soon(5000);
    await vi.advanceTimersByTimeAsync(3000);
    scheduler.soon(5000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lässt nie zwei Läufe gleichzeitig zu und holt eine Anfrage während eines Laufs nach", async () => {
    const finishers: Array<() => void> = [];
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishers.push(resolve);
        }),
    );
    const scheduler = createGoogleSyncScheduler(run);

    scheduler.now();
    scheduler.now();
    scheduler.now();
    expect(run).toHaveBeenCalledTimes(1);

    finishers[0]();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);

    finishers[1]();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("macht nach einem Fehlschlag normal weiter", async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("keine Verbindung"))
      .mockResolvedValue(undefined);
    const scheduler = createGoogleSyncScheduler(run);

    scheduler.now();
    await flush();
    scheduler.now();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("läuft nach dem Aufräumen nicht mehr", async () => {
    const run = vi.fn(async () => {});
    const scheduler = createGoogleSyncScheduler(run);

    scheduler.soon(1000);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    scheduler.now();
    await flush();
    expect(run).not.toHaveBeenCalled();
  });
});
