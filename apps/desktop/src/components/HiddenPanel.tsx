import type { FocusEvent } from "react";
import { formatCents } from "../money";
import type {
  FieldErrors,
  HiddenEntry,
  HiddenEntryDraft,
  HiddenStatus,
  HiddenTextField,
} from "../types";
import { InlineMoneyField } from "./InlineMoneyField";
import { InlineTextField } from "./InlineTextField";

interface HiddenPanelProps {
  status: HiddenStatus | null;
  entries: HiddenEntry[];
  drafts: HiddenEntryDraft[];
  autoFocusId: string | null;
  fieldErrors: FieldErrors;
  onAdd: () => void;
  onCommitText: (id: string, field: HiddenTextField, value: string) => void;
  onCommitAmount: (id: string, raw: string) => void;
  onArchive: (id: string) => void;
  onDraftRowLeave: (draftId: string) => void;
  secretUnlocked: boolean;
  onOpenHistory: () => void;
  onClose: () => void;
}

/** Gemeinsame Sicht auf gespeicherte Einträge und Entwurfszeilen. */
interface HiddenRowData {
  id: string;
  name: string;
  amountCents: number | null;
  note: string;
  isDraft: boolean;
}

/**
 * Versteckter Bereich: gleiche Bedienprinzipien wie die offenen Zahlungen
 * (Entwurfszeile, Direktbearbeitung, automatisches Speichern, Rückgängig).
 * Die Inhalte liegen in SQLite ausschließlich verschlüsselt.
 */
export function HiddenPanel({
  status,
  entries,
  drafts,
  autoFocusId,
  fieldErrors,
  onAdd,
  onCommitText,
  onCommitAmount,
  onArchive,
  onDraftRowLeave,
  secretUnlocked,
  onOpenHistory,
  onClose,
}: HiddenPanelProps) {
  const locked = status !== null && !status.unlocked;
  const totalCents = entries.reduce((sum, entry) => sum + entry.amountCents, 0);

  const rows: HiddenRowData[] = [
    ...drafts.map((draft) => ({
      id: draft.draftId,
      name: draft.name,
      amountCents: draft.amountCents,
      note: draft.note,
      isDraft: true,
    })),
    ...entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      amountCents: entry.amountCents as number | null,
      note: entry.note,
      isDraft: false,
    })),
  ];

  function handleRowBlur(event: FocusEvent<HTMLLIElement>, row: HiddenRowData) {
    if (row.isDraft && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
      onDraftRowLeave(row.id);
    }
  }

  return (
    <section className="payments-panel hidden-panel" aria-label="Versteckte Einträge">
      <div className="payments-header">
        <h2 className="payments-title">Versteckte Einträge</h2>
        {!locked && (
          <span className="payments-total">
            {entries.length === 0 ? "" : `Summe: ${formatCents(totalCents)}`}
          </span>
        )}
        {!locked && (
          <button type="button" className="btn btn-secondary payments-add" onClick={onAdd}>
            + Eintrag
          </button>
        )}
        {secretUnlocked && (
          <button type="button" className="btn btn-secondary" onClick={onOpenHistory}>
            Historie
          </button>
        )}
        <button
          type="button"
          className="icon-button hidden-panel-close"
          aria-label="Versteckten Bereich schließen"
          onClick={onClose}
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
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
      {locked ? (
        <p className="hidden-panel-error" role="alert">
          {status?.error?.message ?? "Schlüssel konnte nicht geladen werden"}
        </p>
      ) : rows.length === 0 ? (
        <p className="payments-empty">Keine Einträge</p>
      ) : (
        <ul className="payments-list">
          {rows.map((row) => {
            const rowName = row.name || "Neuer Eintrag";
            return (
              <li
                key={row.id}
                className="payment-row"
                onBlur={(event) => handleRowBlur(event, row)}
              >
                <InlineTextField
                  value={row.name}
                  label={`Bezeichnung (${rowName})`}
                  placeholder="Bezeichnung"
                  autoFocus={row.id === autoFocusId}
                  error={fieldErrors[row.id]?.name}
                  onCommit={(value) => onCommitText(row.id, "name", value)}
                />
                <InlineMoneyField
                  cents={row.amountCents}
                  label={`Betrag (${rowName})`}
                  error={fieldErrors[row.id]?.amountCents}
                  onCommit={(raw) => onCommitAmount(row.id, raw)}
                />
                <InlineTextField
                  value={row.note}
                  label={`Notiz (${rowName})`}
                  placeholder="Notiz"
                  error={fieldErrors[row.id]?.note}
                  onCommit={(value) => onCommitText(row.id, "note", value)}
                />
                {row.isDraft ? (
                  <span className="payment-draft-hint">Noch nicht gespeichert</span>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${rowName} archivieren`}
                    title="Archivieren"
                    onClick={() => onArchive(row.id)}
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
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
