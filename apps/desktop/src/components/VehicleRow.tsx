import { useState } from "react";
import type { DragEvent, FocusEvent, KeyboardEvent } from "react";
import type { VehicleStatusField, VehicleTextField } from "../types";
import { InlineTextField } from "./InlineTextField";
import { StatusToggle } from "./StatusToggle";

/** Gemeinsame Sicht auf gespeicherte Fahrzeuge und Entwurfszeilen. */
export interface VehicleRowData {
  id: string;
  customerName: string;
  vehicleName: string;
  licensePlate: string;
  tuvRequired: boolean;
  partsOrdered: boolean;
  partsArrived: boolean;
  isDone: boolean;
}

interface VehicleRowProps {
  vehicle: VehicleRowData;
  /** Entwurfszeilen sind noch nicht gespeichert und nicht sortierbar. */
  isDraft: boolean;
  autoFocus: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  errors?: Record<string, string>;
  onCommitText: (id: string, field: VehicleTextField, value: string) => void;
  onToggleStatus: (id: string, field: VehicleStatusField, value: boolean) => void;
  onArchive: (id: string) => void;
  /** Wird gerufen, wenn der Fokus die Zeile komplett verlässt. */
  onRowLeave?: (id: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

export function VehicleRow({
  vehicle,
  isDraft,
  autoFocus,
  isDragging,
  isDropTarget,
  errors,
  onCommitText,
  onToggleStatus,
  onArchive,
  onRowLeave,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onMoveUp,
  onMoveDown,
}: VehicleRowProps) {
  // Ziehen ist nur über den Griff möglich, nicht über die ganze Zeile.
  const [dragEnabled, setDragEnabled] = useState(false);
  const rowName = vehicle.licensePlate || vehicle.customerName || "Neues Fahrzeug";

  const rowClassName = [
    "vehicle-row",
    vehicle.isDone ? "is-fertig" : "",
    isDragging ? "is-dragging" : "",
    isDropTarget ? "is-drop-target" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function handleHandleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMoveUp();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onMoveDown();
    }
  }

  function handleDragOver(event: DragEvent<HTMLTableRowElement>) {
    if (isDraft) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onDragOver();
  }

  function handleRowBlur(event: FocusEvent<HTMLTableRowElement>) {
    if (onRowLeave && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
      onRowLeave(vehicle.id);
    }
  }

  return (
    <tr
      className={rowClassName}
      draggable={dragEnabled}
      onBlur={handleRowBlur}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={() => {
        setDragEnabled(false);
        onDragEnd();
      }}
      onDragOver={handleDragOver}
      onDrop={(event) => {
        if (isDraft) {
          return;
        }
        event.preventDefault();
        onDrop();
      }}
    >
      <td className="cell-drag">
        {!isDraft && (
          <button
            type="button"
            className="drag-handle"
            aria-label={`Priorität von ${rowName} ändern`}
            title="Ziehen oder Pfeiltasten: Priorität ändern"
            onMouseDown={() => setDragEnabled(true)}
            onMouseUp={() => setDragEnabled(false)}
            onKeyDown={handleHandleKeyDown}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="none"
            >
              <circle cx="9" cy="5" r="1.5" />
              <circle cx="9" cy="12" r="1.5" />
              <circle cx="9" cy="19" r="1.5" />
              <circle cx="15" cy="5" r="1.5" />
              <circle cx="15" cy="12" r="1.5" />
              <circle cx="15" cy="19" r="1.5" />
            </svg>
          </button>
        )}
      </td>
      <td>
        <InlineTextField
          value={vehicle.customerName}
          label="Kunde"
          placeholder="Kunde"
          autoFocus={autoFocus}
          error={errors?.customerName}
          onCommit={(value) => onCommitText(vehicle.id, "customerName", value)}
        />
      </td>
      <td>
        <InlineTextField
          value={vehicle.vehicleName}
          label="Fahrzeug"
          placeholder="Fahrzeug"
          error={errors?.vehicleName}
          onCommit={(value) => onCommitText(vehicle.id, "vehicleName", value)}
        />
      </td>
      <td>
        <InlineTextField
          value={vehicle.licensePlate}
          label="Kennzeichen"
          placeholder="Kennzeichen"
          error={errors?.licensePlate}
          onCommit={(value) => onCommitText(vehicle.id, "licensePlate", value)}
        />
      </td>
      <td className="cell-center">
        <StatusToggle
          checked={vehicle.tuvRequired}
          tone="attention"
          label={`TÜV nötig (${rowName})`}
          onChange={(value) => onToggleStatus(vehicle.id, "tuvRequired", value)}
        />
      </td>
      <td className="cell-center">
        <StatusToggle
          checked={vehicle.partsOrdered}
          tone="primary"
          label={`Teile bestellt (${rowName})`}
          onChange={(value) => onToggleStatus(vehicle.id, "partsOrdered", value)}
        />
      </td>
      <td className="cell-center">
        <StatusToggle
          checked={vehicle.partsArrived}
          tone="primary"
          label={`Teile angekommen (${rowName})`}
          onChange={(value) => onToggleStatus(vehicle.id, "partsArrived", value)}
        />
      </td>
      <td className="cell-center">
        <StatusToggle
          checked={vehicle.isDone}
          tone="success"
          label={`Fertig (${rowName})`}
          onChange={(value) => onToggleStatus(vehicle.id, "isDone", value)}
        />
      </td>
      <td className="cell-archive">
        <button
          type="button"
          className="icon-button"
          aria-label={`${rowName} archivieren`}
          title={isDraft ? "Zeile verwerfen" : "Archivieren"}
          onClick={() => onArchive(vehicle.id)}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect width="20" height="5" x="2" y="3" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
          </svg>
        </button>
      </td>
    </tr>
  );
}
