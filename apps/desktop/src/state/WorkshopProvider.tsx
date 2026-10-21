import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import * as api from "../api";
import { toApiError } from "../api";
import { DEFAULT_PAYMENTS_PANEL_HEIGHT } from "../components/PaymentsPanel";
import { VEHICLE_COLUMN_IDS } from "../types";
import type { CustomerSuggestion } from "../types";
import { useFeedback } from "./feedback";
import { useDraftSupport } from "./useDraftSupport";
import { usePayments } from "./usePayments";
import { useSecretArea } from "./useSecretArea";
import { useVehicles } from "./useVehicles";

/**
 * Die gemeinsamen Daten der Werkstatt: Fahrzeuge, offene Zahlungen,
 * Kundenvorschläge und der versteckte Bereich. Sie leben über Bereichswechsel
 * hinweg – neue Zeilen und der geöffnete versteckte Bereich bleiben erhalten,
 * und der Kalender zeigt dieselben Fahrzeuge wie die Liste, ohne sie neu zu laden.
 */
function useWorkshopState() {
  const feedback = useFeedback();
  const draftSupport = useDraftSupport();
  const [customerSuggestions, setCustomerSuggestions] = useState<CustomerSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refreshCustomerSuggestions() {
    try {
      setCustomerSuggestions(await api.listCustomerSuggestions());
    } catch {
      // Vorschläge sind Komfortfunktion; Kernaktionen dürfen nie darauf warten.
    }
  }

  const vehicles = useVehicles({ feedback, drafts: draftSupport, refreshCustomerSuggestions });
  const payments = usePayments({ feedback, drafts: draftSupport });
  const secret = useSecretArea({ feedback, drafts: draftSupport });

  async function fetchCoreData() {
    const [vehicleList, paymentList, suggestions, preferences] = await Promise.all([
      api.listVehicles(),
      api.listOpenPayments(),
      api.listCustomerSuggestions().catch(() => []),
      api.getUiPreferences().catch(() => ({
        paymentsPanelCollapsed: false,
        paymentsPanelHeight: DEFAULT_PAYMENTS_PANEL_HEIGHT,
        vehicleColumnOrder: [...VEHICLE_COLUMN_IDS],
        vehicleHiddenColumns: [],
      })),
    ]);
    vehicles.setList(vehicleList);
    payments.setList(paymentList);
    setCustomerSuggestions(suggestions);
    payments.setCollapsed(preferences.paymentsPanelCollapsed);
    payments.setHeight(preferences.paymentsPanelHeight);
    vehicles.setColumnOrder(preferences.vehicleColumnOrder);
    vehicles.setHiddenColumns(preferences.vehicleHiddenColumns);
  }

  async function loadCoreData() {
    setLoading(true);
    try {
      await fetchCoreData();
      setLoadError(null);
    } catch (err) {
      // Persistenter, nicht blockierender Fehlerzustand mit „Erneut laden“ –
      // z. B. wenn die Datenbank beim Start nicht verfügbar ist.
      setLoadError(toApiError(err).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCoreData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirmRestore() {
    await api.confirmRestore();
    // Das Backend invalidiert beim Datenbanktausch alle Secret-Sitzungen.
    secret.close();
    vehicles.setDrafts([]);
    payments.setDrafts([]);
    draftSupport.setFieldErrors({});
    feedback.clearUndo();
    await fetchCoreData();
  }

  return {
    vehicles,
    payments,
    secret,
    draftSupport,
    customerSuggestions,
    loading,
    loadError,
    reload: loadCoreData,
    confirmRestore,
  };
}

export type Workshop = ReturnType<typeof useWorkshopState>;

const WorkshopContext = createContext<Workshop | null>(null);

export function WorkshopProvider({ children }: { children: ReactNode }) {
  const workshop = useWorkshopState();
  return <WorkshopContext.Provider value={workshop}>{children}</WorkshopContext.Provider>;
}

export function useWorkshop(): Workshop {
  const workshop = useContext(WorkshopContext);
  if (workshop === null) {
    throw new Error("useWorkshop braucht einen WorkshopProvider");
  }
  return workshop;
}
