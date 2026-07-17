import { useId, useState } from "react";
import type { KeyboardEvent } from "react";

interface InlineTextFieldProps {
  value: string;
  label: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
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
  error,
}: InlineTextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const errorId = useId();

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
        value={draft ?? value}
        aria-label={label}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
      />
      {error !== undefined && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
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
