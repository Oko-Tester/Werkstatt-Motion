import { useState } from "react";
import type { Vehicle } from "../types";
import { VehicleRow } from "./VehicleRow";

interface VehicleTableProps {
  vehicles: Vehicle[];
  autoFocusId: string | null;
  onUpdate: (id: string, patch: Partial<Vehicle>) => void;
  onArchive: (id: string) => void;
  onMove: (dragId: string, targetId: string) => void;
}

export function VehicleTable({ vehicles, autoFocusId, onUpdate, onArchive, onMove }: VehicleTableProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  function moveByKeyboard(id: string, direction: -1 | 1) {
    const index = vehicles.findIndex((vehicle) => vehicle.id === id);
    const target = vehicles[index + direction];
    if (target) {
      onMove(id, target.id);
    }
  }

  function resetDrag() {
    setDragId(null);
    setDropTargetId(null);
  }

  return (
    <div className="vehicle-table-wrap">
      <table className="vehicle-table">
        <colgroup>
          <col className="col-drag" />
          <col />
          <col />
          <col className="col-kennzeichen" />
          <col className="col-status" />
          <col className="col-status" />
          <col className="col-status" />
          <col className="col-status" />
          <col className="col-archiv" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Priorität</span>
            </th>
            <th scope="col">Kunde</th>
            <th scope="col">Fahrzeug</th>
            <th scope="col">Kennzeichen</th>
            <th scope="col" className="th-center">
              TÜV nötig
            </th>
            <th scope="col" className="th-center">
              Teile bestellt
            </th>
            <th scope="col" className="th-center">
              Teile angekommen
            </th>
            <th scope="col" className="th-center">
              Fertig
            </th>
            <th scope="col">
              <span className="visually-hidden">Archivieren</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {vehicles.length === 0 ? (
            <tr>
              <td colSpan={9} className="empty-cell">
                Keine Fahrzeuge gefunden
              </td>
            </tr>
          ) : (
            vehicles.map((vehicle) => (
              <VehicleRow
                key={vehicle.id}
                vehicle={vehicle}
                autoFocus={vehicle.id === autoFocusId}
                isDragging={vehicle.id === dragId}
                isDropTarget={vehicle.id === dropTargetId && dragId !== null && dragId !== vehicle.id}
                onUpdate={onUpdate}
                onArchive={onArchive}
                onDragStart={() => setDragId(vehicle.id)}
                onDragEnd={resetDrag}
                onDragOver={() => setDropTargetId(vehicle.id)}
                onDrop={() => {
                  if (dragId !== null && dragId !== vehicle.id) {
                    onMove(dragId, vehicle.id);
                  }
                  resetDrag();
                }}
                onMoveUp={() => moveByKeyboard(vehicle.id, -1)}
                onMoveDown={() => moveByKeyboard(vehicle.id, 1)}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
