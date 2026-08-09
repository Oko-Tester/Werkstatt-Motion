import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FocusEvent, KeyboardEvent, MouseEvent } from "react";

interface PreviewPosition {
  left: number;
  placement: "above" | "below";
  edge: number;
}

interface FloatingSurface extends PreviewPosition {
  mode: "preview" | "editor";
}

interface InlineTextFieldProps {
  value: string;
  label: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Zeigt den vollständigen Feldinhalt beim Darüberfahren in einer großen Vorschau. */
  previewOnHover?: boolean;
  /** Macht die Vorschau beim Klick auf ein gefülltes Feld zum großen Texteditor. */
  editInPreview?: boolean;
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
  editInPreview = false,
  error,
}: InlineTextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [surface, setSurface] = useState<FloatingSurface | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const previewId = useId();
  const editorHintId = useId();
  const displayedValue = draft ?? value;

  function positionSurface(
    input: HTMLInputElement,
    preferredWidth: number,
    aboveThreshold: number,
  ): PreviewPosition {
    const rect = input.getBoundingClientRect();
    const width = Math.min(preferredWidth, Math.max(0, window.innerWidth - 24));
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const placement = rect.top >= aboveThreshold ? "above" : "below";
    return {
      left,
      placement,
      edge:
        placement === "above"
          ? window.innerHeight - rect.top + 10
          : rect.bottom + 10,
    };
  }

  function showPreview(event: MouseEvent<HTMLInputElement>) {
    if (
      !previewOnHover ||
      displayedValue.trim() === "" ||
      surface?.mode === "editor"
    ) {
      return;
    }
    setSurface({
      mode: "preview",
      ...positionSurface(event.currentTarget, 420, 220),
    });
  }

  function openPreviewEditor(event: MouseEvent<HTMLInputElement>) {
    if (!editInPreview || displayedValue.trim() === "") return;
    setSurface({
      mode: "editor",
      ...positionSurface(event.currentTarget, 520, 290),
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

  function handleInputBlur() {
    // Beim Wechsel vom Tabellenfeld in den Portal-Editor darf der alte
    // Inline-Blur nicht vorab speichern oder den gemeinsamen Draft verwerfen.
    if (surface?.mode !== "editor") commit();
  }

  function closeEditorAndFocusInput() {
    setSurface(null);
    window.setTimeout(() => inputRef.current?.focus());
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(null);
      if (error !== undefined) onCommit(value);
      closeEditorAndFocusInput();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
      closeEditorAndFocusInput();
    }
  }

  function handleEditorBlur(_event: FocusEvent<HTMLTextAreaElement>) {
    commit();
    setSurface(null);
  }

  return (
    <div className="inline-field-wrap">
      <input
        ref={inputRef}
        className={error === undefined ? "inline-field" : "inline-field has-error"}
        value={displayedValue}
        aria-label={label}
        aria-invalid={error !== undefined}
        aria-describedby={
          [
            error === undefined ? null : errorId,
            surface?.mode === "preview" ? previewId : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-haspopup={editInPreview ? "dialog" : undefined}
        aria-expanded={editInPreview ? surface?.mode === "editor" : undefined}
        aria-controls={surface?.mode === "editor" ? previewId : undefined}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={handleInputBlur}
        onKeyDown={handleKeyDown}
        onClick={openPreviewEditor}
        onMouseEnter={showPreview}
        onMouseLeave={() =>
          setSurface((current) => (current?.mode === "preview" ? null : current))
        }
      />
      {error !== undefined && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
      {surface !== null &&
        createPortal(
          <div
            id={previewId}
            role={surface.mode === "preview" ? "tooltip" : "dialog"}
            aria-label={surface.mode === "editor" ? "Notiz bearbeiten" : undefined}
            className={
              surface.mode === "editor" ? "note-preview is-editing" : "note-preview"
            }
            data-placement={surface.placement}
            style={
              surface.placement === "above"
                ? { left: surface.left, bottom: surface.edge }
                : { left: surface.left, top: surface.edge }
            }
          >
            <div className="note-preview-label">
              {surface.mode === "editor" ? "Notiz bearbeiten" : "Notiz"}
            </div>
            {surface.mode === "preview" ? (
              <div className="note-preview-content">{displayedValue}</div>
            ) : (
              <>
                <textarea
                  className="note-preview-editor"
                  value={displayedValue}
                  aria-label={`${label} groß bearbeiten`}
                  aria-invalid={error !== undefined}
                  aria-describedby={
                    [editorHintId, error === undefined ? null : errorId]
                      .filter(Boolean)
                      .join(" ")
                  }
                  autoFocus
                  onFocus={(event) => {
                    const end = event.currentTarget.value.length;
                    event.currentTarget.setSelectionRange(end, end);
                  }}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onBlur={handleEditorBlur}
                  onKeyDown={handleEditorKeyDown}
                />
                <div id={editorHintId} className="note-preview-hint">
                  Strg+Enter speichert · Esc verwirft
                </div>
              </>
            )}
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
