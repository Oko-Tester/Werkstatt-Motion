import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import type {
  FieldErrors,
  Vehicle,
  VehicleColumnId,
  VehicleDraft,
  VehicleStatusField,
  VehicleTextField,
} from "../types";
import { VehicleRow } from "./VehicleRow";
import type { VehicleRowData } from "./VehicleRow";

interface VehicleTableProps {
  vehicles: Vehicle[];
  drafts: VehicleDraft[];
  columnOrder: VehicleColumnId[];
  hiddenColumns: VehicleColumnId[];
  loading: boolean;
  loadError: string | null;
  onRetryLoad: () => void;
  onAdd: () => void;
  autoFocusId: string | null;
  fieldErrors: FieldErrors;
  onCommitText: (id: string, field: VehicleTextField, value: string) => void;
  onToggleStatus: (id: string, field: VehicleStatusField, value: boolean) => void;
  onArchive: (id: string) => void;
  onDraftRowLeave: (draftId: string) => void;
  onMove: (dragId: string, targetId: string) => void;
  onColumnOrderChange: (columnOrder: VehicleColumnId[]) => void;
  onHiddenColumnsChange: (hiddenColumns: VehicleColumnId[]) => void;
}

const COLUMN_META: Record<
  VehicleColumnId,
  { label: string; align: "left" | "center"; widthClass?: string }
> = {
  customerName: { label: "Kunde", align: "left" },
  vehicleName: { label: "Fahrzeug", align: "left" },
  licensePlate: { label: "Kennzeichen", align: "left", widthClass: "col-kennzeichen" },
  note: { label: "Notiz", align: "left", widthClass: "col-note" },
  tuvRequired: { label: "TÜV nötig", align: "center", widthClass: "col-status" },
  partsOrdered: { label: "Teile bestellen", align: "center", widthClass: "col-status" },
  partsArrived: { label: "Teile angekommen", align: "center", widthClass: "col-status" },
  isDone: { label: "Fertig", align: "center", widthClass: "col-status" },
};

type DropPosition = "before" | "after";

export function VehicleTable({
  vehicles,
  drafts,
  columnOrder,
  hiddenColumns,
  loading,
  loadError,
  onRetryLoad,
  onAdd,
  autoFocusId,
  fieldErrors,
  onCommitText,
  onToggleStatus,
  onArchive,
  onDraftRowLeave,
  onMove,
  onColumnOrderChange,
  onHiddenColumnsChange,
}: VehicleTableProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dragColumnId, setDragColumnId] = useState<VehicleColumnId | null>(null);
  const [dropColumn, setDropColumn] = useState<{
    id: VehicleColumnId;
    position: DropPosition;
  } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const hiddenColumnSet = new Set(hiddenColumns);
  const visibleColumns = columnOrder.filter((id) => !hiddenColumnSet.has(id));
  const tableColumnCount = visibleColumns.length + 2;

  useEffect(() => {
    if (columnMenu === null) return;

    columnMenuRef.current?.querySelector<HTMLInputElement>("input")?.focus();

    function handleMouseDown(event: MouseEvent) {
      if (!columnMenuRef.current?.contains(event.target as Node)) setColumnMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setColumnMenu(null);
    }

    function closeColumnMenu() {
      setColumnMenu(null);
    }

    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", closeColumnMenu);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", closeColumnMenu);
    };
  }, [columnMenu]);

  function openColumnMenu(event: ReactMouseEvent<HTMLTableSectionElement>) {
    event.preventDefault();
    setColumnMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 248)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 340)),
    });
  }

  function toggleColumn(id: VehicleColumnId) {
    if (hiddenColumnSet.has(id)) {
      onHiddenColumnsChange(hiddenColumns.filter((columnId) => columnId !== id));
      return;
    }
    if (visibleColumns.length <= 1) return;
    onHiddenColumnsChange(
      columnOrder.filter((columnId) => hiddenColumnSet.has(columnId) || columnId === id),
    );
  }

  function moveByKeyboard(id: string, direction: -1 | 1) {
    const index = vehicles.findIndex((vehicle) => vehicle.id === id);
    const target = vehicles[index + direction];
    if (target) onMove(id, target.id);
  }

  function resetRowDrag() {
    setDragId(null);
    setDropTargetId(null);
  }

  function moveColumn(source: VehicleColumnId, target: VehicleColumnId, position: DropPosition) {
    if (source === target) return;
    const next = columnOrder.filter((id) => id !== source);
    const targetIndex = next.indexOf(target);
    next.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);
    onColumnOrderChange(next);
  }

  function handleColumnDragOver(
    event: ReactDragEvent<HTMLTableCellElement>,
    id: VehicleColumnId,
  ) {
    if (dragColumnId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    setDropColumn({ id, position });
  }

  function handleColumnKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    id: VehicleColumnId,
  ) {
    if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const index = visibleColumns.indexOf(id);
    const target = visibleColumns[index + (event.key === "ArrowLeft" ? -1 : 1)];
    if (target) moveColumn(id, target, event.key === "ArrowLeft" ? "before" : "after");
  }

  const draftRows: VehicleRowData[] = drafts.map((draft) => ({
    id: draft.draftId,
    customerName: draft.customerName,
    vehicleName: draft.vehicleName,
    licensePlate: draft.licensePlate,
    note: draft.note,
    tuvRequired: draft.tuvRequired,
    partsOrdered: draft.partsOrdered,
    partsArrived: draft.partsArrived,
    isDone: draft.isDone,
  }));
  const isEmpty = !loading && loadError === null && draftRows.length === 0 && vehicles.length === 0;

  return (
    <div className="vehicle-table-wrap">
      <table className="vehicle-table">
        <colgroup>
          <col className="col-drag" />
          {visibleColumns.map((id) => (
            <col key={id} className={COLUMN_META[id].widthClass} />
          ))}
          <col className="col-archiv" />
        </colgroup>
        <thead onContextMenu={openColumnMenu}>
          <tr>
            <th scope="col"><span className="visually-hidden">Priorität</span></th>
            {visibleColumns.map((id) => {
              const meta = COLUMN_META[id];
              const isTarget = dragColumnId !== null && dropColumn?.id === id && dragColumnId !== id;
              const className = [
                meta.align === "center" ? "th-center" : "",
                dragColumnId === id ? "is-column-dragging" : "",
                isTarget ? `is-column-drop-${dropColumn.position}` : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <th
                  key={id}
                  scope="col"
                  data-column-id={id}
                  aria-label={`${meta.label}, Spalte verschieben`}
                  className={className}
                  draggable
                  onDragStart={(event) => {
                    event.stopPropagation();
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("application/x-werkstatt-vehicle-column", id);
                    setDragColumnId(id);
                    setDropColumn(null);
                  }}
                  onDragOver={(event) => handleColumnDragOver(event, id)}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (dragColumnId !== null && dropColumn !== null) {
                      moveColumn(dragColumnId, dropColumn.id, dropColumn.position);
                    }
                    setDragColumnId(null);
                    setDropColumn(null);
                  }}
                  onDragEnd={() => {
                    setDragColumnId(null);
                    setDropColumn(null);
                  }}
                >
                  <button
                    type="button"
                    className="column-drag-handle"
                    aria-label={`${meta.label}, Spalte verschieben`}
                    title="Ziehen oder Alt+Pfeiltaste: Spalte verschieben. Rechtsklick: Spalten auswählen"
                    onKeyDown={(event) => handleColumnKeyDown(event, id)}
                  >
                    <span>{meta.label}</span>
                    <span aria-hidden="true" className="column-drag-dots">⋮⋮</span>
                  </button>
                </th>
              );
            })}
            <th scope="col"><span className="visually-hidden">Archivieren</span></th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={tableColumnCount} className="empty-cell">Laden …</td></tr>
          )}
          {!loading && loadError !== null && (
            <tr>
              <td colSpan={tableColumnCount} className="empty-cell">
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
            <tr><td colSpan={tableColumnCount} className="empty-cell">Keine Fahrzeuge gefunden</td></tr>
          )}
          {vehicles.map((vehicle) => (
            <VehicleRow
              key={vehicle.id}
              vehicle={vehicle}
              columnOrder={visibleColumns}
              isDraft={false}
              autoFocus={vehicle.id === autoFocusId}
              isDragging={vehicle.id === dragId}
              isDropTarget={vehicle.id === dropTargetId && dragId !== null && dragId !== vehicle.id}
              errors={fieldErrors[vehicle.id]}
              onCommitText={onCommitText}
              onToggleStatus={onToggleStatus}
              onArchive={onArchive}
              onDragStart={() => setDragId(vehicle.id)}
              onDragEnd={resetRowDrag}
              onDragOver={() => {
                if (dragId !== null) setDropTargetId(vehicle.id);
              }}
              onDrop={() => {
                if (dragId !== null && dragId !== vehicle.id) onMove(dragId, vehicle.id);
                resetRowDrag();
              }}
              onMoveUp={() => moveByKeyboard(vehicle.id, -1)}
              onMoveDown={() => moveByKeyboard(vehicle.id, 1)}
            />
          ))}
          {draftRows.map((draft) => (
            <VehicleRow
              key={draft.id}
              vehicle={draft}
              columnOrder={visibleColumns}
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
        </tbody>
      </table>
      {columnMenu !== null &&
        createPortal(
          <div
            ref={columnMenuRef}
            className="column-visibility-menu"
            role="dialog"
            aria-label="Spalten auswählen"
            style={{ left: columnMenu.x, top: columnMenu.y }}
          >
            <div className="column-visibility-title">Spalten anzeigen</div>
            {columnOrder.map((id) => {
              const isVisible = !hiddenColumnSet.has(id);
              const isLastVisible = isVisible && visibleColumns.length === 1;
              return (
                <label
                  key={id}
                  className={
                    isLastVisible
                      ? "column-visibility-option is-disabled"
                      : "column-visibility-option"
                  }
                >
                  <input
                    type="checkbox"
                    checked={isVisible}
                    disabled={isLastVisible}
                    onChange={() => toggleColumn(id)}
                  />
                  <span>{COLUMN_META[id].label}</span>
                </label>
              );
            })}
          </div>,
          document.body,
        )}
      <button type="button" className="vehicle-add-row" onClick={onAdd}>
        <span aria-hidden="true">+</span>
        <span>Neuen Kunden hinzufügen</span>
      </button>
    </div>
  );
}
