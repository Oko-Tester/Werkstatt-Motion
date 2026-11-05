import type { Vehicle } from "./types";

/**
 * So lange nach der letzten Änderung an Terminen wartet der Abgleich, damit mehrere
 * Änderungen kurz hintereinander (etwa am Telefon) einen einzigen Lauf ergeben.
 */
export const GOOGLE_SYNC_AFTER_CHANGE_MS = 5 * 1000;

/**
 * Was bei Google steht, hängt nur an diesen Feldern der Fahrzeuge mit Termin. Ändert sich
 * der Fingerabdruck, lohnt ein Abgleich; Notiz, Arbeitsstand oder Reihenfolge lösen keinen aus.
 */
export function calendarSignature(vehicles: readonly Vehicle[]): string {
  return JSON.stringify(
    vehicles
      .filter((vehicle) => vehicle.appointmentAt !== null && vehicle.archivedAt === null)
      .map((vehicle) => [
        vehicle.id,
        vehicle.appointmentAt,
        vehicle.vehicleName,
        vehicle.customerName,
        vehicle.licensePlate,
      ])
      .sort((left, right) => (left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0)),
  );
}

export interface GoogleSyncScheduler {
  /** Gleicht sofort ab; läuft gerade ein Abgleich, gleich danach noch einmal. */
  now(): void;
  /**
   * Gleicht nach `delayMs` ab. Kommt in der Wartezeit eine weitere Anfrage, beginnt die
   * Wartezeit neu: Mehrere Änderungen kurz hintereinander ergeben einen Abgleich.
   */
  soon(delayMs: number): void;
  dispose(): void;
}

/**
 * Hält die Abgleiche der App in einer Reihe: nie zwei gleichzeitig, und eine Anfrage
 * während eines Laufs geht nicht verloren, sondern folgt direkt danach – mit dem dann
 * aktuellen Stand der Fahrzeuge.
 */
export function createGoogleSyncScheduler(run: () => Promise<void>): GoogleSyncScheduler {
  let timer: number | null = null;
  let running = false;
  let again = false;
  let disposed = false;

  function clearTimer() {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  async function execute() {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch {
      // Ein Fehlschlag ist nur ein ausgelassener Lauf; der Stand steht in den Einstellungen,
      // und der nächste Lauf holt alles nach.
    } finally {
      running = false;
      if (again && !disposed) {
        again = false;
        void execute();
      }
    }
  }

  return {
    now() {
      clearTimer();
      void execute();
    },
    soon(delayMs) {
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void execute();
      }, delayMs);
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
