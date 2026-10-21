import { useRef, useState } from "react";
import * as api from "../api";
import { toApiError } from "../api";
import { DEFAULT_PAYMENTS_PANEL_HEIGHT } from "../components/PaymentsPanel";
import { parseEuroInput } from "../money";
import type { CustomerSuggestion, Payment, PaymentDraft, PaymentTextField } from "../types";
import type { Feedback } from "./feedback";
import type { DraftSupport } from "./useDraftSupport";
import { isDraftId } from "./useDraftSupport";

function isPaymentDraftComplete(draft: PaymentDraft): boolean {
  return draft.customerName.trim() !== "" && draft.amountCents !== null && draft.amountCents > 0;
}

function isPaymentDraftEmpty(draft: PaymentDraft): boolean {
  return draft.customerName.trim() === "" && draft.amountCents === null && draft.note.trim() === "";
}

interface PaymentsDeps {
  feedback: Feedback;
  drafts: DraftSupport;
}

/** Die offenen Zahlungen mit ihren neuen Zeilen und den Einstellungen des Bereichs. */
export function usePayments({ feedback, drafts }: PaymentsDeps) {
  const { showNotice, showUndo, clearUndo } = feedback;
  const { clearFieldError, setFieldError, fieldErrorsRef, creatingRef, setAutoFocusId } = drafts;
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);
  const [paymentsCollapsed, setPaymentsCollapsed] = useState(false);
  const [paymentsPanelHeight, setPaymentsPanelHeight] = useState(
    DEFAULT_PAYMENTS_PANEL_HEIGHT,
  );

  // Spiegel der States für Handler, die nach dem Event (setTimeout) den
  // aktuellen Stand brauchen – z. B. das Verwerfen leerer Entwurfszeilen.
  const paymentsRef = useRef(payments);
  paymentsRef.current = payments;
  const paymentDraftsRef = useRef(paymentDrafts);
  paymentDraftsRef.current = paymentDrafts;

  function togglePaymentsCollapsed() {
    const next = !paymentsCollapsed;
    setPaymentsCollapsed(next);
    void api.updatePaymentsPanelCollapsed(next).catch((err) => {
      // Die Oberfläche bleibt für diese Sitzung im gewählten Zustand bedienbar.
      showNotice(toApiError(err).message);
    });
  }

  function persistPaymentsPanelHeight(height: number) {
    void api
      .updatePaymentsPanelHeight(height)
      .then((preferences) => setPaymentsPanelHeight(preferences.paymentsPanelHeight))
      .catch((err) => {
        // Die gewählte Größe bleibt für diese Sitzung erhalten.
        showNotice(toApiError(err).message);
      });
  }

  // ---------- Zahlungen ----------

  function addPayment() {
    const draft: PaymentDraft = {
      draftId: `draft-p-${crypto.randomUUID()}`,
      vehicleId: null,
      vehicleName: "",
      licensePlate: "",
      customerName: "",
      amountCents: null,
      note: "",
    };
    setPaymentDrafts((prev) => [draft, ...prev]);
    setAutoFocusId(draft.draftId);
  }

  function updatePaymentDraft(draftId: string, patch: Partial<PaymentDraft>) {
    const current = paymentDraftsRef.current.find((draft) => draft.draftId === draftId);
    if (!current) {
      return;
    }
    const next = { ...current, ...patch };
    setPaymentDrafts((prev) => prev.map((draft) => (draft.draftId === draftId ? next : draft)));
    for (const field of Object.keys(patch)) {
      clearFieldError(draftId, field);
    }
  }

  async function createPaymentFromDraft(draft: PaymentDraft) {
    try {
      const created = await api.createPayment({
        vehicleId: draft.vehicleId,
        customerName: draft.customerName,
        amountCents: draft.amountCents ?? 0,
        note: draft.note,
      });
      setPaymentDrafts((prev) => prev.filter((entry) => entry.draftId !== draft.draftId));
      clearFieldError(draft.draftId);
      setPayments((prev) => [...prev, created]);
    } catch (err) {
      const apiErr = toApiError(err);
      setFieldError(draft.draftId, apiErr.field ?? "customerName", apiErr.message);
    } finally {
      creatingRef.current.delete(draft.draftId);
    }
  }

  function handlePaymentDraftRowLeave(draftId: string) {
    window.setTimeout(() => {
      const draft = paymentDraftsRef.current.find((entry) => entry.draftId === draftId);
      if (!draft || creatingRef.current.has(draftId)) {
        return;
      }
      if (isPaymentDraftEmpty(draft)) {
        setPaymentDrafts((prev) => prev.filter((entry) => entry.draftId !== draftId));
        clearFieldError(draftId);
      } else if (isPaymentDraftComplete(draft)) {
        creatingRef.current.add(draftId);
        void createPaymentFromDraft(draft);
      } else {
        const existing = fieldErrorsRef.current[draftId] ?? {};
        if (draft.customerName.trim() === "" && existing.customerName === undefined) {
          setFieldError(draftId, "customerName", "Kunde angeben");
        } else if (draft.customerName.trim() !== "" && existing.amountCents === undefined) {
          setFieldError(draftId, "amountCents", "Betrag angeben");
        }
      }
    }, 0);
  }

  function commitPaymentText(id: string, field: PaymentTextField, value: string) {
    if (isDraftId(id)) {
      updatePaymentDraft(
        id,
        field === "customerName"
          ? {
              customerName: value,
              vehicleId: null,
              vehicleName: "",
              licensePlate: "",
            }
          : { [field]: value },
      );
      return;
    }
    void savePaymentPatch(id, { [field]: value });
  }

  function selectPaymentVehicle(id: string, suggestion: CustomerSuggestion) {
    const patch = {
      vehicleId: suggestion.id,
      customerName: suggestion.customerName,
      vehicleName: suggestion.vehicleName ?? "",
      licensePlate: suggestion.licensePlate ?? "",
    };
    if (isDraftId(id)) {
      updatePaymentDraft(id, patch);
      return;
    }
    void savePaymentPatch(id, {
      vehicleId: suggestion.id,
      customerName: suggestion.customerName,
    });
  }

  function commitPaymentAmount(id: string, raw: string) {
    if (raw === "") {
      if (isDraftId(id)) {
        updatePaymentDraft(id, { amountCents: null });
      } else {
        setFieldError(id, "amountCents", "Betrag angeben");
      }
      return;
    }
    const cents = parseEuroInput(raw);
    if (cents === null || cents <= 0) {
      setFieldError(id, "amountCents", "Ungültiger Betrag, z. B. 486,50");
      return;
    }
    clearFieldError(id, "amountCents");
    if (isDraftId(id)) {
      updatePaymentDraft(id, { amountCents: cents });
    } else {
      void savePaymentPatch(id, { amountCents: cents });
    }
  }

  async function savePaymentPatch(id: string, patch: api.PaymentPatch) {
    const payment = paymentsRef.current.find((entry) => entry.id === id);
    if (!payment) {
      return;
    }
    const fields = Object.keys(patch);
    for (const field of fields) {
      clearFieldError(id, field);
    }
    const unchanged = fields.every(
      (field) => payment[field as keyof api.PaymentPatch] === patch[field as keyof api.PaymentPatch],
    );
    if (unchanged) {
      return;
    }
    const previous = payment;
    setPayments((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
    try {
      const saved = await api.updatePayment(id, patch);
      setPayments((prev) => prev.map((entry) => (entry.id === id ? saved : entry)));
    } catch (err) {
      const apiErr = toApiError(err);
      setPayments((prev) => prev.map((entry) => (entry.id === id ? previous : entry)));
      setFieldError(id, apiErr.field ?? fields[0] ?? "customerName", apiErr.message);
    }
  }

  function markPaymentPaid(id: string) {
    void markStoredPaymentPaid(id);
  }

  async function markStoredPaymentPaid(id: string) {
    const payment = paymentsRef.current.find((entry) => entry.id === id);
    if (!payment) {
      return;
    }
    const previousList = paymentsRef.current;
    setPayments((prev) => prev.filter((entry) => entry.id !== id));
    try {
      await api.markPaymentPaid(id);
      showUndo(`Zahlung von ${payment.customerName} als bezahlt markiert`, () => {
        clearUndo();
        void undoPaymentPaid(id);
      });
    } catch (err) {
      setPayments(previousList);
      showNotice(toApiError(err).message);
    }
  }

  async function undoPaymentPaid(id: string) {
    try {
      await api.restorePayment(id);
      setPayments(await api.listOpenPayments());
    } catch (err) {
      showNotice(toApiError(err).message);
    }
  }

  return {
    list: payments,
    drafts: paymentDrafts,
    collapsed: paymentsCollapsed,
    height: paymentsPanelHeight,
    toggleCollapsed: togglePaymentsCollapsed,
    setHeight: setPaymentsPanelHeight,
    persistHeight: persistPaymentsPanelHeight,
    add: addPayment,
    commitText: commitPaymentText,
    selectVehicle: selectPaymentVehicle,
    commitAmount: commitPaymentAmount,
    markPaid: markPaymentPaid,
    onDraftRowLeave: handlePaymentDraftRowLeave,
    setList: setPayments,
    setDrafts: setPaymentDrafts,
    setCollapsed: setPaymentsCollapsed,
  };
}
