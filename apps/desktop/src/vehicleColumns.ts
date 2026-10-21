import type { VehicleColumnId } from "./types";

/** Anzeigenamen der Fahrzeugspalten – in Tabelle, Spaltenmenü und Einstellungen gleich. */
export const VEHICLE_COLUMN_LABELS: Record<VehicleColumnId, string> = {
  appointmentAt: "Termin",
  customerName: "Kunde",
  vehicleName: "Fahrzeug",
  licensePlate: "Kennzeichen",
  tuvRequired: "TÜV nötig",
  partsOrdered: "Teile bestellen",
  partsArrived: "Teile angekommen",
  isDone: "Fertig",
  note: "Notiz",
};

/**
 * Blendet eine Spalte ein oder aus und liefert die neue Liste der ausgeblendeten
 * Spalten. Die letzte sichtbare Spalte lässt sich nicht ausblenden: Dann kommt
 * `null`, und es ändert sich nichts.
 */
export function toggleVehicleColumn(
  columnOrder: readonly VehicleColumnId[],
  hiddenColumns: readonly VehicleColumnId[],
  id: VehicleColumnId,
): VehicleColumnId[] | null {
  const hidden = new Set(hiddenColumns);
  if (hidden.has(id)) {
    return hiddenColumns.filter((columnId) => columnId !== id);
  }
  const visibleCount = columnOrder.filter((columnId) => !hidden.has(columnId)).length;
  if (visibleCount <= 1) return null;
  return columnOrder.filter((columnId) => hidden.has(columnId) || columnId === id);
}
