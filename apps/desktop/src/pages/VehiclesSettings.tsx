import { InfoTip } from "../components/InfoTip";
import { useWorkshop } from "../state/WorkshopProvider";
import { VEHICLE_COLUMN_IDS } from "../types";
import { VEHICLE_COLUMN_LABELS, toggleVehicleColumn } from "../vehicleColumns";

/**
 * Einstellungen der Fahrzeuge: welche Spalten die Fahrzeugliste zeigt und – per
 * Zurücksetzen – in welcher Reihenfolge. Es ist dieselbe Auswahl wie im Menü, das
 * sich per Rechtsklick auf eine Spaltenüberschrift öffnet.
 */
export function VehiclesSettings() {
  const { vehicles } = useWorkshop();
  const hidden = new Set(vehicles.hiddenColumns);
  const visibleCount = vehicles.columnOrder.filter((id) => !hidden.has(id)).length;
  const isDefaultOrder = vehicles.columnOrder.every((id, index) => id === VEHICLE_COLUMN_IDS[index]);

  return (
    <section className="settings-section" aria-labelledby="vehicle-columns-title">
      <div className="settings-title">
        <h4 id="vehicle-columns-title">Spalten der Fahrzeugliste</h4>
        <InfoTip label="Spalten der Fahrzeugliste">
          Hier legst du fest, welche Spalten die Fahrzeugliste zeigt. Die Reihenfolge änderst du
          direkt in der Liste, indem du eine Spaltenüberschrift ziehst.
        </InfoTip>
      </div>
      <div className="settings-options" role="group" aria-label="Sichtbare Spalten">
        {vehicles.columnOrder.map((id) => {
          const visible = !hidden.has(id);
          const isLastVisible = visible && visibleCount === 1;
          return (
            <label
              key={id}
              className={
                isLastVisible
                  ? "column-visibility-option is-disabled"
                  : "column-visibility-option"
              }
              title={isLastVisible ? "Mindestens eine Spalte muss sichtbar bleiben" : undefined}
            >
              <input
                type="checkbox"
                checked={visible}
                disabled={isLastVisible}
                onChange={() => {
                  const next = toggleVehicleColumn(vehicles.columnOrder, vehicles.hiddenColumns, id);
                  if (next !== null) vehicles.changeHiddenColumns(next);
                }}
              />
              <span>{VEHICLE_COLUMN_LABELS[id]}</span>
            </label>
          );
        })}
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={isDefaultOrder}
        onClick={() => vehicles.changeColumnOrder([...VEHICLE_COLUMN_IDS])}
      >
        Reihenfolge zurücksetzen
      </button>
    </section>
  );
}
