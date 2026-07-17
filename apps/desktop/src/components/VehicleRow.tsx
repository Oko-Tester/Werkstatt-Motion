import { useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import type { Vehicle } from "../types";
import { InlineTextField } from "./InlineTextField";
import { StatusToggle } from "./StatusToggle";

interface VehicleRowProps {
  vehicle: Vehicle;
  autoFocus: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onUpdate: (id: string, patch: Partial<Vehicle>) => void;
  onArchive: (id: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

export function VehicleRow({
  vehicle,
  autoFocus,
  isDragging,
  isDropTarget,
  onUpdate,
  onArchive,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onMoveUp,
  onMoveDown,
}: VehicleRowProps) {
  // Ziehen ist nur über den Griff möglich, nicht über die ganze Zeile.
  const [dragEnabled, setDragEnabled] = useState(false);
  const rowName = vehicle.kennzeichen || vehicle.kunde || "Neues Fahrzeug";

  const rowClassName = [
    "vehicle-row",
    vehicle.fertig ? "is-fertig" : "",
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
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onDragOver();
  }

  return (
    <tr
      className={rowClassName}
      draggable={dragEnabled}
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
        event.preventDefault();
        onDrop();
      }}
    >
      <td className="cell-drag">
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
      </td>
      <td>
        <InlineTextField
          value={vehicle.kunde}
          label="Kunde"
          placeholder="Kunde"
          autoFocus={autoFocus}
          onCommit={(kunde) => onUpdate(vehicle.id, { kunde })}
        />
      </td>
      <td>
        <InlineTextField
          value={vehicle.fahrzeug}
          label="Fahrzeug"
          placeholder="Fahrzeug"
          onCommit={(fahrzeug) => onUpdate(vehicle.id, { fahrzeug })}
        />
      </td>
      <td>
        <InlineTextField
          value={vehicle.kennzeichen}
          label="Kennzeichen"
          placeholder="Kennzeichen"
          onCommit={(kennzeichen) => onUpdate(vehicle.id, { kennzeichen })}
        />
      </td>
      <td className="cell-center">
        <StatusToggle
          checked={vehicle.tuevNoetig}
          tone="attention"
          label={`TÜV nötig (${rowName})`}
          onChange={(tuevNoetig) => onUpdate(vehicle.id, { tuevNoetig })}
        />
      </td>
      <td className="cell-center">
        <StatusToggle
          checked={vehicle.teileBestellt}
          tone="primary"
          label={`Teile bestellt (${rowName})`}
          onChange={(teileBestellt) => onUpdate(vehicle.id, { teileBestellt })}
        />
      </td>
      <td className="cell-center">
        <StatusToggle
          checked={vehicle.teileAngekommen}
          tone="primary"
          label={`Teile angekommen (${rowName})`}
          onChange={(teileAngekommen) => onUpdate(vehicle.id, { teileAngekommen })}
        />
      </td>
      <td className="cell-center">
        <StatusToggle
          checked={vehicle.fertig}
          tone="success"
          label={`Fertig (${rowName})`}
          onChange={(fertig) => onUpdate(vehicle.id, { fertig })}
        />
      </td>
      <td className="cell-archive">
        <button
          type="button"
          className="icon-button"
          aria-label={`${rowName} archivieren`}
          title="Archivieren"
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
