import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { toApiError } from "../api";
import { HistoryWorkspace } from "../components/HistoryWorkspace";
import { useFeedback } from "../state/feedback";
import { useAreaSearchRef } from "../state/searchFocus";
import { useWorkshop } from "../state/WorkshopProvider";
import type { Payment, SecretHistoryEntry, VehicleHistory } from "../types";

/**
 * Historie: abgeschlossene Fahrzeuge und bezahlte Kosten, bei geöffnetem
 * versteckten Bereich zusätzlich dessen Verlauf. Die Daten gehören nur dieser
 * Seite und werden bei jedem Öffnen frisch geladen.
 */
export function HistoryPage() {
  const { showNotice } = useFeedback();
  const { secret } = useWorkshop();
  const searchRef = useAreaSearchRef();
  const [historySearch, setHistorySearch] = useState("");
  const [vehicleHistory, setVehicleHistory] = useState<VehicleHistory[]>([]);
  const [paidPaymentHistory, setPaidPaymentHistory] = useState<Payment[]>([]);
  const [secretHistory, setSecretHistory] = useState<SecretHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Ergebnisse später eintreffender Ladevorgänge werden verworfen, sobald die
  // Seite verlassen wurde.
  const historyOpenRef = useRef(true);
  const secretSessionTokenRef = secret.sessionTokenRef;

  useEffect(() => {
    historyOpenRef.current = true;
    return () => {
      historyOpenRef.current = false;
    };
  }, []);

  async function loadHistoryWorkspace() {
    const token = secretSessionTokenRef.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const [vehiclesResult, paymentsResult] = await Promise.all([
        api.listCompletedVehicleHistory(),
        api.listPaidPayments(),
      ]);
      if (!historyOpenRef.current) return;
      setVehicleHistory(vehiclesResult);
      setPaidPaymentHistory(paymentsResult);

      if (token !== null && secretSessionTokenRef.current === token) {
        try {
          const secretsResult = await api.listEncryptedSecretHistory(token);
          if (historyOpenRef.current && secretSessionTokenRef.current === token) {
            setSecretHistory(secretsResult);
          }
        } catch (err) {
          if (historyOpenRef.current && secretSessionTokenRef.current === token) {
            setSecretHistory([]);
            showNotice(toApiError(err).message);
          }
        }
      } else if (secretSessionTokenRef.current === null) {
        setSecretHistory([]);
      }
    } catch (err) {
      if (historyOpenRef.current) setHistoryError(toApiError(err).message);
    } finally {
      if (historyOpenRef.current && secretSessionTokenRef.current === token) {
        setHistoryLoading(false);
      }
    }
  }

  // Jedes Öffnen oder Schließen des versteckten Bereichs ändert, was die
  // Historie zeigen darf: Sie lädt sich dann neu.
  useEffect(() => {
    setSecretHistory([]);
    void loadHistoryWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret.revision]);

  // Nach dem Schließen der Sitzung nie Klartext zeigen – auch nicht für den
  // Moment, bis die Historie neu geladen ist.
  const visibleSecretHistory = secret.sessionToken === null ? [] : secretHistory;

  return (
    <HistoryWorkspace
      vehicleHistory={vehicleHistory}
      paidPayments={paidPaymentHistory}
      secretHistory={visibleSecretHistory}
      search={historySearch}
      loading={historyLoading}
      error={historyError}
      secretUnlocked={secret.unlocked}
      onSearchChange={setHistorySearch}
      onRetry={() => void loadHistoryWorkspace()}
      onCloseSession={secret.close}
      searchRef={searchRef}
    />
  );
}
