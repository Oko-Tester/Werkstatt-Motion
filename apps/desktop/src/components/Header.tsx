import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { toApiError } from "../api";
import type { BackupResult, RestorePreview } from "../api";
import { useLongPress } from "../useLongPress";
import { PrimaryButton } from "./PrimaryButton";
import { SearchInput } from "./SearchInput";

interface HeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  onAddVehicle: () => void;
  /** Wird nach drei Sekunden Gedrückthalten des Logos aufgerufen. */
  onOpenHiddenArea: () => void;
  onBackup: () => Promise<BackupResult>;
  onPrepareRestore: () => Promise<RestorePreview>;
  onConfirmRestore: () => Promise<void>;
  onCancelRestore: () => Promise<void>;
  searchRef?: Ref<HTMLInputElement>;
}

const STATUS_MS = 4000;
const LONG_PRESS_MS = 3000;

interface StatusMessage {
  text: string;
  kind: "ok" | "error";
}

export function Header({
  search,
  onSearchChange,
  onAddVehicle,
  onOpenHiddenArea,
  onBackup,
  onPrepareRestore,
  onConfirmRestore,
  onCancelRestore,
  searchRef,
}: HeaderProps) {
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);
  const longPress = useLongPress(onOpenHiddenArea, LONG_PRESS_MS);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  function showStatus(text: string, kind: StatusMessage["kind"]) {
    setStatus({ text, kind });
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setStatus(null), STATUS_MS);
  }

  async function handleBackupClick() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const result = await onBackup();
      if (result.saved) {
        showStatus("Backup erstellt", "ok");
      }
      // Abgebrochener Dialog: bewusst keine Meldung.
    } catch (err) {
      showStatus(toApiError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreClick() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const preview = await onPrepareRestore();
      if (!preview.cancelled) {
        setStatus(null);
        setRestorePreview(preview);
      }
    } catch (err) {
      showStatus(toApiError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmRestore() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onConfirmRestore();
      setRestorePreview(null);
      showStatus("Wiederherstellung abgeschlossen", "ok");
    } catch (err) {
      setRestorePreview(null);
      showStatus(toApiError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelRestore() {
    setRestorePreview(null);
    try {
      await onCancelRestore();
    } catch {
      // Abbrechen darf nie stören.
    }
  }

  function describePreview(preview: RestorePreview): string {
    const date =
      preview.createdAt !== null
        ? new Date(preview.createdAt).toLocaleString("de-DE", {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "unbekanntem Zeitpunkt";
    const vehicles = preview.vehicleCount ?? 0;
    const payments = preview.paymentCount ?? 0;
    return `Backup vom ${date} (${vehicles} Fahrzeuge, ${payments} offene Zahlungen) ersetzt die aktuellen Daten`;
  }

  return (
    <header className="app-header">
      {/* Werkstattlogo: drei Sekunden Gedrückthalten öffnet den versteckten
          Bereich. Während des Haltens gibt es bewusst keinerlei sichtbare
          Rückmeldung – das ist versteckte Bedienung, kein Zugriffsschutz. */}
      <div className="app-logo" aria-hidden="true" {...longPress}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      </div>
      <h1 className="app-title">Werkstatt Manager</h1>
      <div className="header-search">
        <SearchInput value={search} onChange={onSearchChange} inputRef={searchRef} />
      </div>
      <div className="header-actions">
        {restorePreview !== null ? (
          // Zweistufige Inline-Bestätigung statt eines Bestätigungsdialogs:
          // Klick 1 hat die Datei gewählt und validiert, Klick 2 stellt her.
          <div className="restore-confirm" role="group" aria-label="Wiederherstellung bestätigen">
            <span className="restore-confirm-text">{describePreview(restorePreview)}</span>
            <button type="button" className="btn btn-danger" onClick={handleConfirmRestore}>
              Jetzt wiederherstellen
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Wiederherstellung abbrechen"
              onClick={handleCancelRestore}
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
        ) : (
          <>
            <span
              className={status?.kind === "error" ? "backup-status is-error" : "backup-status"}
              role="status"
              title={status?.text}
            >
              {status?.text}
            </span>
            <button type="button" className="btn btn-secondary" onClick={handleBackupClick}>
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
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              Backup
            </button>
            <button type="button" className="btn btn-secondary" onClick={handleRestoreClick}>
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
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" x2="12" y1="3" y2="15" />
              </svg>
              Wiederherstellen
            </button>
            <PrimaryButton onClick={onAddVehicle}>+ Fahrzeug</PrimaryButton>
          </>
        )}
      </div>
    </header>
  );
}
