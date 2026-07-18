import { useMemo } from "react";
import { formatCents } from "../money";
import type { Payment, SecretHistoryEntry, VehicleHistory } from "../types";

interface HistoryWorkspaceProps {
  vehicleHistory: VehicleHistory[];
  paidPayments: Payment[];
  secretHistory: SecretHistoryEntry[];
  search: string;
  loading: boolean;
  error: string | null;
  secretUnlocked: boolean;
  onSearchChange: (value: string) => void;
  onRetry: () => void;
  onBack: () => void;
  onCloseSession: () => void;
}

function includesQuery(values: Array<string | null>, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase("de-DE");
  return normalized === "" || values.some((value) => value?.toLocaleLowerCase("de-DE").includes(normalized));
}

function formatDate(value: string | null): string {
  if (value === null || value === "") return "–";
  return new Date(value).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

function formatVehicleStatus(entry: VehicleHistory): string {
  return [
    `TÜV ${entry.tuvRequired ? "✓" : "–"}`,
    `Bestellt ${entry.partsOrdered ? "✓" : "–"}`,
    `Angekommen ${entry.partsArrived ? "✓" : "–"}`,
    `Fertig ${entry.isDone ? "✓" : "–"}`,
  ].join(" · ");
}

/** Inline-Arbeitsansicht innerhalb der AppShell; bewusst weder Dialog noch Modal. */
export function HistoryWorkspace({
  vehicleHistory,
  paidPayments,
  secretHistory,
  search,
  loading,
  error,
  secretUnlocked,
  onSearchChange,
  onRetry,
  onBack,
  onCloseSession,
}: HistoryWorkspaceProps) {
  const visibleVehicles = useMemo(
    () =>
      vehicleHistory.filter((entry) =>
        includesQuery(
          [entry.customerName, entry.vehicleName, entry.licensePlate, entry.note, entry.completedAt],
          search,
        ),
      ),
    [search, vehicleHistory],
  );
  const visibleSecrets = useMemo(
    () =>
      secretHistory.filter((entry) =>
        includesQuery([entry.name, entry.note, String(entry.amountCents)], search),
      ),
    [search, secretHistory],
  );
  const visiblePayments = useMemo(
    () =>
      paidPayments.filter((entry) =>
        includesQuery(
          [
            entry.customerName,
            entry.vehicleName,
            entry.licensePlate,
            entry.note,
            String(entry.amountCents),
            entry.paidAt,
          ],
          search,
        ),
      ),
    [paidPayments, search],
  );

  return (
    <section className="history-workspace" aria-label="Historienarbeitsansicht">
      <div className="history-toolbar">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          ← Zurück
        </button>
        <div>
          <h2>Historie</h2>
          <p>
            {secretUnlocked
              ? "Unveränderliche Fahrzeug- und Secret-Snapshots"
              : "Unveränderliche Fahrzeug-Snapshots"}
          </p>
        </div>
        <label className="history-search">
          <span className="visually-hidden">Historie durchsuchen</span>
          <input
            type="search"
            value={search}
            placeholder="Historie durchsuchen …"
            aria-label="Historie durchsuchen"
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        {secretUnlocked && (
          <button type="button" className="btn btn-secondary" onClick={onCloseSession}>
            Secret-Bereich schließen
          </button>
        )}
      </div>

      {loading ? (
        <p className="history-state">Historie wird geladen …</p>
      ) : error !== null ? (
        <div className="load-error history-state" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Erneut laden
          </button>
        </div>
      ) : (
        <div className={secretUnlocked ? "history-tables has-secret" : "history-tables"}>
          <section className="history-group" aria-labelledby="vehicle-history-title">
            <div className="history-group-heading">
              <h3 id="vehicle-history-title">Fahrzeug-Snapshots</h3>
            </div>
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Kunde</th>
                    <th>Fahrzeug</th>
                    <th>Kennzeichen</th>
                    <th>Notiz</th>
                    <th>Status damals</th>
                    <th>Abgeschlossen</th>
                    <th>Archiviert</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleVehicles.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="history-empty">Keine Fahrzeug-Snapshots</td>
                    </tr>
                  ) : (
                    visibleVehicles.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.customerName}</td>
                        <td>{entry.vehicleName || "–"}</td>
                        <td>{entry.licensePlate || "–"}</td>
                        <td>{entry.note || "–"}</td>
                        <td className="history-status-values">{formatVehicleStatus(entry)}</td>
                        <td>{formatDate(entry.completedAt)}</td>
                        <td>{formatDate(entry.archivedAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="history-group" aria-labelledby="payment-history-title">
            <div className="history-group-heading">
              <h3 id="payment-history-title">Bezahlte Kosten</h3>
            </div>
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Kunde</th>
                    <th>Fahrzeug</th>
                    <th>Kennzeichen</th>
                    <th>Betrag</th>
                    <th>Notiz</th>
                    <th>Bezahlt</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePayments.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="history-empty">Keine bezahlten Kosten</td>
                    </tr>
                  ) : (
                    visiblePayments.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.customerName}</td>
                        <td>{entry.vehicleName || "–"}</td>
                        <td>{entry.licensePlate || "–"}</td>
                        <td className="history-money">{formatCents(entry.amountCents)}</td>
                        <td>{entry.note || "–"}</td>
                        <td>{formatDate(entry.paidAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {secretUnlocked && (
            <section className="history-group" aria-labelledby="secret-history-title">
            <div className="history-group-heading">
              <h3 id="secret-history-title">Entschlüsselte Secret-History</h3>
            </div>
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Bezeichnung</th>
                    <th>Betrag</th>
                    <th>Notiz</th>
                    <th>Archiviert</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSecrets.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="history-empty">Keine Secret-Snapshots</td>
                    </tr>
                  ) : (
                    visibleSecrets.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.name}</td>
                        <td className="history-money">{formatCents(entry.amountCents)}</td>
                        <td>{entry.note || "–"}</td>
                        <td>{formatDate(entry.completedOrArchivedAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
