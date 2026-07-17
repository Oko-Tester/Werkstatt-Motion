import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import { centsToEditable, formatCents } from "../money";
import { focusNextField } from "./InlineTextField";

interface InlineMoneyFieldProps {
  cents: number | null;
  label: string;
  /** Bekommt die rohe Eingabe; das Parsen übernimmt der Aufrufer. */
  onCommit: (raw: string) => void;
  error?: string;
}

/**
 * Direkt bearbeitbares Betragsfeld mit automatischer Euroformatierung:
 * zeigt "486,50 €", beim Bearbeiten steht "486,50" im Feld.
 */
export function InlineMoneyField({ cents, label, onCommit, error }: InlineMoneyFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const errorId = useId();

  const display = cents === null ? "" : editing ? centsToEditable(cents) : formatCents(cents);
  const value = draft ?? display;

  function commit() {
    if (draft !== null && (draft.trim() !== centsToEditable(cents) || error !== undefined)) {
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
        onCommit(centsToEditable(cents));
      }
    }
  }

  return (
    <div className="inline-field-wrap">
      <input
        className={
          error === undefined
            ? "inline-field inline-field-money"
            : "inline-field inline-field-money has-error"
        }
        inputMode="decimal"
        value={value}
        aria-label={label}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        placeholder="0,00"
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          commit();
          setEditing(false);
        }}
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
