import { useRef } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent } from "react";
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
  height: number;
  autoFocusId: string | null;
  fieldErrors: FieldErrors;
  onToggleCollapsed: () => void;
  onHeightChange: (height: number) => void;
  onHeightCommit: (height: number) => void;
  onAdd: () => void;
  onCommitText: (id: string, field: PaymentTextField, value: string) => void;
  onSelectVehicle: (id: string, suggestion: CustomerSuggestion) => void;
  onCommitAmount: (id: string, raw: string) => void;
  onMarkPaid: (id: string) => void;
  onDraftRowLeave: (draftId: string) => void;
}

export const DEFAULT_PAYMENTS_PANEL_HEIGHT = 240;
export const MIN_PAYMENTS_PANEL_HEIGHT = 160;
const RESIZE_KEYBOARD_STEP = 40;

interface PaymentRowData {
  id: string;
  vehicleId: string | null;
  customerName: string;
  vehicleName: string;
  licensePlate: string;
  amountCents: number | null;
  note: string;
  isDraft: boolean;
}

export function PaymentsPanel({
  payments,
  drafts,
  suggestions,
  collapsed,
  height,
  autoFocusId,
  fieldErrors,
  onToggleCollapsed,
  onHeightChange,
  onHeightCommit,
  onAdd,
  onCommitText,
  onSelectVehicle,
  onCommitAmount,
  onMarkPaid,
  onDraftRowLeave,
}: PaymentsPanelProps) {
  const resizeStartRef = useRef<{ y: number; height: number } | null>(null);
  const resizedHeightRef = useRef(height);
  resizedHeightRef.current = height;

  function maximumHeight(): number {
    return Math.max(MIN_PAYMENTS_PANEL_HEIGHT, window.innerHeight - 220);
  }

  function clampHeight(value: number): number {
    return Math.round(
      Math.min(maximumHeight(), Math.max(MIN_PAYMENTS_PANEL_HEIGHT, value)),
    );
  }

  function handleResizeStart(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeStartRef.current = { y: event.clientY, height };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.classList.add("is-resizing");
  }

  function handleResizeMove(event: PointerEvent<HTMLDivElement>) {
    const start = resizeStartRef.current;
    if (start === null) return;
    const next = clampHeight(start.height + start.y - event.clientY);
    resizedHeightRef.current = next;
    onHeightChange(next);
  }

  function handleResizeEnd(event: PointerEvent<HTMLDivElement>) {
    if (resizeStartRef.current === null) return;
    resizeStartRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    event.currentTarget.classList.remove("is-resizing");
    onHeightCommit(resizedHeightRef.current);
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? 1 : -1;
    const next = clampHeight(height + direction * RESIZE_KEYBOARD_STEP);
    onHeightChange(next);
    onHeightCommit(next);
  }

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
      vehicleId: draft.vehicleId,
      customerName: draft.customerName,
      vehicleName: draft.vehicleName,
      licensePlate: draft.licensePlate,
      amountCents: draft.amountCents,
      note: draft.note,
      isDraft: true,
    })),
    ...payments.map((payment) => ({
      id: payment.id,
      vehicleId: payment.vehicleId,
      customerName: payment.customerName,
      vehicleName: payment.vehicleName,
      licensePlate: payment.licensePlate,
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
    <section
      className="payments-panel"
      aria-label="Offene Zahlungen"
      style={{ height: `${height}px` }}
    >
      <div
        className="payments-resize-handle"
        role="separator"
        aria-label="Höhe der offenen Zahlungen ändern"
        aria-orientation="horizontal"
        aria-valuemin={MIN_PAYMENTS_PANEL_HEIGHT}
        aria-valuemax={maximumHeight()}
        aria-valuenow={height}
        tabIndex={0}
        title="Nach oben oder unten ziehen"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        onKeyDown={handleResizeKeyDown}
      >
        <span aria-hidden="true" />
      </div>
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
                <div className="payment-customer-cell">
                  <CustomerAutocomplete
                    value={row.customerName}
                    label={`Kunde (${rowName})`}
                    suggestions={suggestions}
                    placeholder="Kunde"
                    autoFocus={row.id === autoFocusId}
                    error={fieldErrors[row.id]?.customerName}
                    onCommit={(value) => onCommitText(row.id, "customerName", value)}
                    onSelect={(suggestion) => onSelectVehicle(row.id, suggestion)}
                  />
                  <span className="payment-vehicle-link">
                    {row.vehicleId
                      ? [row.vehicleName, row.licensePlate].filter(Boolean).join(" · ") ||
                        "Fahrzeug verknüpft"
                      : "Kein Fahrzeug verknüpft"}
                  </span>
                </div>
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
