import { useState } from "react";
import type {
  FieldErrors,
  Vehicle,
  VehicleDraft,
  VehicleStatusField,
  VehicleTextField,
} from "../types";
import { VehicleRow } from "./VehicleRow";
import type { VehicleRowData } from "./VehicleRow";

interface VehicleTableProps {
  vehicles: Vehicle[];
  drafts: VehicleDraft[];
  loading: boolean;
  /** Fehlermeldung, wenn die Daten nicht geladen werden konnten. */
  loadError: string | null;
  onRetryLoad: () => void;
  autoFocusId: string | null;
  fieldErrors: FieldErrors;
  onCommitText: (id: string, field: VehicleTextField, value: string) => void;
  onToggleStatus: (id: string, field: VehicleStatusField, value: boolean) => void;
  onArchive: (id: string) => void;
  onDraftRowLeave: (draftId: string) => void;
  onMove: (dragId: string, targetId: string) => void;
}

export function VehicleTable({
  vehicles,
  drafts,
  loading,
  loadError,
  onRetryLoad,
  autoFocusId,
  fieldErrors,
  onCommitText,
  onToggleStatus,
  onArchive,
  onDraftRowLeave,
  onMove,
}: VehicleTableProps) {
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

  const draftRows: VehicleRowData[] = drafts.map((draft) => ({
    id: draft.draftId,
    customerName: draft.customerName,
    vehicleName: draft.vehicleName,
    licensePlate: draft.licensePlate,
    tuvRequired: draft.tuvRequired,
    partsOrdered: draft.partsOrdered,
    partsArrived: draft.partsArrived,
    isDone: draft.isDone,
  }));

  const isEmpty =
    !loading && loadError === null && draftRows.length === 0 && vehicles.length === 0;

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
          {loading && (
            <tr>
              <td colSpan={9} className="empty-cell">
                Laden …
              </td>
            </tr>
          )}
          {!loading && loadError !== null && (
            <tr>
              <td colSpan={9} className="empty-cell">
                <div className="load-error" role="alert">
                  <span>{loadError}</span>
                  <button type="button" className="btn btn-secondary" onClick={onRetryLoad}>
                    Erneut laden
                  </button>
                </div>
              </td>
            </tr>
          )}
          {isEmpty && (
            <tr>
              <td colSpan={9} className="empty-cell">
                Keine Fahrzeuge gefunden
              </td>
            </tr>
          )}
          {draftRows.map((draft) => (
            <VehicleRow
              key={draft.id}
              vehicle={draft}
              isDraft
              autoFocus={draft.id === autoFocusId}
              isDragging={false}
              isDropTarget={false}
              errors={fieldErrors[draft.id]}
              onCommitText={onCommitText}
              onToggleStatus={onToggleStatus}
              onArchive={onArchive}
              onRowLeave={onDraftRowLeave}
              onDragStart={() => undefined}
              onDragEnd={() => undefined}
              onDragOver={() => undefined}
              onDrop={() => undefined}
              onMoveUp={() => undefined}
              onMoveDown={() => undefined}
            />
          ))}
          {vehicles.map((vehicle) => (
            <VehicleRow
              key={vehicle.id}
              vehicle={vehicle}
              isDraft={false}
              autoFocus={vehicle.id === autoFocusId}
              isDragging={vehicle.id === dragId}
              isDropTarget={vehicle.id === dropTargetId && dragId !== null && dragId !== vehicle.id}
              errors={fieldErrors[vehicle.id]}
              onCommitText={onCommitText}
              onToggleStatus={onToggleStatus}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
