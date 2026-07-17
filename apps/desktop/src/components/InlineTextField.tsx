import { useState } from "react";
import type { KeyboardEvent } from "react";

interface InlineTextFieldProps {
  value: string;
  label: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Direkt bearbeitbares Textfeld: sieht wie Text aus, ist aber immer ein Eingabefeld.
 * Enter übernimmt und springt zum nächsten Feld der Zeile, Escape verwirft die
 * lokale Änderung, Verlassen des Feldes speichert automatisch.
 */
export function InlineTextField({ value, label, onCommit, placeholder, autoFocus }: InlineTextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft !== null && draft.trim() !== value) {
      onCommit(draft.trim());
    }
    setDraft(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      commit();
      const row = event.currentTarget.closest("tr");
      if (row) {
        const fields = Array.from(row.querySelectorAll<HTMLInputElement>("input.inline-field"));
        const index = fields.indexOf(event.currentTarget);
        const next = fields[index + 1];
        if (next) {
          next.focus();
        } else {
          event.currentTarget.blur();
        }
      }
    } else if (event.key === "Escape") {
      setDraft(null);
    }
  }

  return (
    <input
      className="inline-field"
      value={draft ?? value}
      aria-label={label}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
    />
  );
}
