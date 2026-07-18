import type { FocusEvent } from "react";
import { formatCents } from "../money";
import type {
  CustomerSuggestion,
  FieldErrors,
  Payment,
  PaymentDraft,
  PaymentTextField,
} from "../types";
import { CustomerAutocomplete } from "./CustomerAutocomplete";
import { InlineMoneyField } from "./InlineMoneyField";
import { InlineTextField } from "./InlineTextField";

interface PaymentsPanelProps {
  payments: Payment[];
  drafts: PaymentDraft[];
  suggestions: CustomerSuggestion[];
  collapsed: boolean;
  autoFocusId: string | null;
  fieldErrors: FieldErrors;
  onToggleCollapsed: () => void;
  onAdd: () => void;
  onCommitText: (id: string, field: PaymentTextField, value: string) => void;
  onCommitAmount: (id: string, raw: string) => void;
  onMarkPaid: (id: string) => void;
  onDraftRowLeave: (draftId: string) => void;
}

interface PaymentRowData {
  id: string;
  customerName: string;
  amountCents: number | null;
  note: string;
  isDraft: boolean;
}

export function PaymentsPanel({
  payments,
  drafts,
  suggestions,
  collapsed,
  autoFocusId,
  fieldErrors,
  onToggleCollapsed,
  onAdd,
  onCommitText,
  onCommitAmount,
  onMarkPaid,
  onDraftRowLeave,
}: PaymentsPanelProps) {
  if (collapsed) {
    return (
      <section className="payments-panel is-collapsed" aria-label="Offene Zahlungen">
        <div className="payments-header">
          <h2 className="payments-title">Offene Zahlungen</h2>
          <button
            type="button"
            className="btn btn-secondary payments-expand"
            onClick={onToggleCollapsed}
          >
            Erweitern
          </button>
        </div>
      </section>
    );
  }

  const totalCents = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const rows: PaymentRowData[] = [
    ...drafts.map((draft) => ({
      id: draft.draftId,
      customerName: draft.customerName,
      amountCents: draft.amountCents,
      note: draft.note,
      isDraft: true,
    })),
    ...payments.map((payment) => ({
      id: payment.id,
      customerName: payment.customerName,
      amountCents: payment.amountCents as number | null,
      note: payment.note,
      isDraft: false,
    })),
  ];

  function handleRowBlur(event: FocusEvent<HTMLLIElement>, row: PaymentRowData) {
    if (row.isDraft && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
      onDraftRowLeave(row.id);
    }
  }

  return (
    <section className="payments-panel" aria-label="Offene Zahlungen">
      <div className="payments-header">
        <h2 className="payments-title">Offene Zahlungen</h2>
        <span className="payments-total">
          {payments.length === 0 ? "Alles bezahlt" : `Summe: ${formatCents(totalCents)}`}
        </span>
        <button type="button" className="btn btn-secondary payments-add" onClick={onAdd}>
          + Offener Betrag
        </button>
        <button
          type="button"
          className="icon-button payments-collapse"
          aria-label="Offene Zahlungen minimieren"
          title="Minimieren"
          onClick={onToggleCollapsed}
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
            <path d="m6 15 6-6 6 6" />
          </svg>
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="payments-empty">Keine offenen Zahlungen</p>
      ) : (
        <ul className="payments-list">
          {rows.map((row) => {
            const rowName = row.customerName || "Neue Zahlung";
            return (
              <li
                key={row.id}
                className="payment-row"
                onBlur={(event) => handleRowBlur(event, row)}
              >
                <CustomerAutocomplete
                  value={row.customerName}
                  label={`Kunde (${rowName})`}
                  suggestions={suggestions}
                  placeholder="Kunde"
                  autoFocus={row.id === autoFocusId}
                  error={fieldErrors[row.id]?.customerName}
                  onCommit={(value) => onCommitText(row.id, "customerName", value)}
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
                    className="btn btn-success-outline"
                    aria-label={`Zahlung von ${rowName} als bezahlt markieren`}
                    onClick={() => onMarkPaid(row.id)}
                  >
                    ✓ Bezahlt
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
