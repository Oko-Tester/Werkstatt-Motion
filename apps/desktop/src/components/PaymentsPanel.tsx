import type { Payment } from "../types";

const currency = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

interface PaymentsPanelProps {
  payments: Payment[];
  onMarkPaid: (id: string) => void;
}

export function PaymentsPanel({ payments, onMarkPaid }: PaymentsPanelProps) {
  const totalCents = payments.reduce((sum, payment) => sum + payment.betragCents, 0);

  return (
    <section className="payments-panel" aria-label="Offene Zahlungen">
      <div className="payments-header">
        <h2 className="payments-title">Offene Zahlungen</h2>
        <span className="payments-total">
          {payments.length === 0 ? "Alles bezahlt" : `Summe: ${currency.format(totalCents / 100)}`}
        </span>
      </div>
      {payments.length === 0 ? (
        <p className="payments-empty">Keine offenen Zahlungen</p>
      ) : (
        <ul className="payments-list">
          {payments.map((payment) => (
            <li key={payment.id} className="payment-row">
              <span className="payment-kunde">{payment.kunde}</span>
              <span className="payment-fahrzeug">{payment.fahrzeug}</span>
              <span className="payment-betrag">{currency.format(payment.betragCents / 100)}</span>
              <button
                type="button"
                className="btn btn-success-outline"
                aria-label={`Zahlung von ${payment.kunde} als bezahlt markieren`}
                onClick={() => onMarkPaid(payment.id)}
              >
                ✓ Bezahlt
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
