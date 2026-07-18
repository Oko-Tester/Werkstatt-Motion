import { useId, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent, MouseEvent } from "react";

interface PreviewPosition {
  left: number;
  placement: "above" | "below";
  edge: number;
}

interface InlineTextFieldProps {
  value: string;
  label: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Zeigt den vollständigen Feldinhalt beim Darüberfahren in einer großen Vorschau. */
  previewOnHover?: boolean;
  /** Fehlermeldung direkt am Feld, z. B. aus der Backend-Validierung. */
  error?: string;
}

/**
 * Direkt bearbeitbares Textfeld: sieht wie Text aus, ist aber immer ein Eingabefeld.
 * Enter übernimmt und springt zum nächsten Feld der Zeile, Escape verwirft die
 * lokale Änderung, Verlassen des Feldes speichert automatisch.
 */
export function InlineTextField({
  value,
  label,
  onCommit,
  placeholder,
  autoFocus,
  previewOnHover = false,
  error,
}: InlineTextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = useState<PreviewPosition | null>(null);
  const errorId = useId();
  const previewId = useId();
  const displayedValue = draft ?? value;

  function showPreview(event: MouseEvent<HTMLInputElement>) {
    if (!previewOnHover || displayedValue.trim() === "") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const previewWidth = Math.min(420, Math.max(0, window.innerWidth - 24));
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - previewWidth - 12));
    const placement = rect.top >= 220 ? "above" : "below";
    setPreviewPosition({
      left,
      placement,
      edge:
        placement === "above"
          ? window.innerHeight - rect.top + 10
          : rect.bottom + 10,
    });
  }

  function commit() {
    if (draft !== null && (draft.trim() !== value || error !== undefined)) {
      onCommit(draft.trim());
    }
    setDraft(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      commit();
      focusNextField(event.currentTarget);
    } else if (event.key === "Escape") {
      setDraft(null);
      if (error !== undefined) {
        // Alten (gültigen) Wert bestätigen, damit der Feldfehler verschwindet.
        onCommit(value);
      }
    }
  }

  return (
    <div className="inline-field-wrap">
      <input
        className={error === undefined ? "inline-field" : "inline-field has-error"}
        value={displayedValue}
        aria-label={label}
        aria-invalid={error !== undefined}
        aria-describedby={
          [error === undefined ? null : errorId, previewPosition === null ? null : previewId]
            .filter(Boolean)
            .join(" ") || undefined
        }
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        onMouseEnter={showPreview}
        onMouseLeave={() => setPreviewPosition(null)}
      />
      {error !== undefined && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
      {previewPosition !== null &&
        createPortal(
          <div
            id={previewId}
            role="tooltip"
            className="note-preview"
            data-placement={previewPosition.placement}
            style={
              previewPosition.placement === "above"
                ? { left: previewPosition.left, bottom: previewPosition.edge }
                : { left: previewPosition.left, top: previewPosition.edge }
            }
          >
            <div className="note-preview-label">Notiz</div>
            <div className="note-preview-content">{displayedValue}</div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Springt zum nächsten Inline-Feld derselben Zeile (Tabellenzeile oder Listenzeile). */
export function focusNextField(current: HTMLInputElement) {
  const row = current.closest("tr, li");
  if (!row) {
    current.blur();
    return;
  }
  const fields = Array.from(row.querySelectorAll<HTMLInputElement>("input.inline-field"));
  const index = fields.indexOf(current);
  const next = fields[index + 1];
  if (next) {
    next.focus();
  } else {
    current.blur();
  }
}
