import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { toApiError } from "../api";
import type { BackupResult, RestorePreview } from "../api";
import type { AvailableUpdate, UpdateProgress } from "../updates";
import { useLongPress } from "../useLongPress";
import { PrimaryButton } from "./PrimaryButton";
import { SearchInput } from "./SearchInput";

interface HeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  onAddVehicle: () => void;
  /** Öffnet die reguläre Fahrzeughistorie; Secret-Inhalte bleiben gesperrt. */
  onOpenHistory: () => void;
  /** Wird nach drei Sekunden Gedrückthalten des Logos aufgerufen. */
  onOpenHiddenArea: () => void;
  onBackup: () => Promise<BackupResult>;
  onPrepareRestore: () => Promise<RestorePreview>;
  onConfirmRestore: () => Promise<void>;
  onCancelRestore: () => Promise<void>;
  onCheckForUpdates: () => Promise<AvailableUpdate | null>;
  onInstallUpdate: (
    targetVersion: string,
    onProgress: (progress: UpdateProgress) => void,
  ) => Promise<void>;
  onDiscardUpdate: () => void;
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
  onOpenHistory,
  onOpenHiddenArea,
  onBackup,
  onPrepareRestore,
  onConfirmRestore,
  onCancelRestore,
  onCheckForUpdates,
  onInstallUpdate,
  onDiscardUpdate,
  searchRef,
}: HeaderProps) {
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [updatePreview, setUpdatePreview] = useState<AvailableUpdate | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const longPress = useLongPress(onOpenHiddenArea, LONG_PRESS_MS);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!actionsMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!actionsMenuRef.current?.contains(event.target as Node)) {
        setActionsMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActionsMenuOpen(false);
        actionsMenuButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsMenuOpen]);

  function showStatus(text: string, kind: StatusMessage["kind"]) {
    setStatus({ text, kind });
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setStatus(null), STATUS_MS);
  }

  function errorMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message.trim() !== "") {
      return err.message;
    }
    if (typeof err === "string" && err.trim() !== "") {
      return err;
    }
    const apiError = toApiError(err);
    return apiError.message === "Speichern fehlgeschlagen" ? fallback : apiError.message;
  }

  async function handleBackupClick() {
    if (busy) {
      return;
    }
    setActionsMenuOpen(false);
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
    setActionsMenuOpen(false);
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

  async function handleUpdateCheck() {
    if (busy) {
      return;
    }
    setActionsMenuOpen(false);
    setBusy(true);
    showStatus("Suche nach Updates …", "ok");
    try {
      const available = await onCheckForUpdates();
      if (available === null) {
        showStatus("Werkstatt Motion ist aktuell", "ok");
      } else {
        setStatus(null);
        setUpdateMessage("");
        setUpdatePreview(available);
      }
    } catch (err) {
      showStatus(errorMessage(err, "Die Update-Suche ist fehlgeschlagen"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleInstallUpdate() {
    if (busy || updatePreview === null) {
      return;
    }
    const targetVersion = updatePreview.version;
    setBusy(true);
    setUpdateMessage("Sicherheits-Backup wird erstellt …");
    try {
      await onInstallUpdate(targetVersion, (progress) => {
        if (progress.finished) {
          setUpdateMessage("Update wird installiert …");
          return;
        }
        if (progress.totalBytes !== null && progress.totalBytes > 0) {
          const percent = Math.min(
            100,
            Math.round((progress.downloadedBytes / progress.totalBytes) * 100),
          );
          setUpdateMessage(`Update wird heruntergeladen … ${percent} %`);
        } else {
          setUpdateMessage("Update wird heruntergeladen …");
        }
      });
    } catch (err) {
      setUpdatePreview(null);
      setUpdateMessage("");
      showStatus(errorMessage(err, "Das Update konnte nicht installiert werden"), "error");
    } finally {
      setBusy(false);
    }
  }

  function handleDiscardUpdate() {
    onDiscardUpdate();
    setUpdatePreview(null);
    setUpdateMessage("");
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
        <img src="/werkstatt-motion-logo.png" alt="" draggable="false" />
      </div>
      <h1 className="visually-hidden">Werkstatt Motion</h1>
      <div className="header-search">
        <SearchInput value={search} onChange={onSearchChange} inputRef={searchRef} />
      </div>
      <div className="header-actions">
        <button type="button" className="btn btn-secondary" onClick={onOpenHistory}>
          Historie
        </button>
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
        ) : updatePreview !== null ? (
          <div className="update-confirm" role="group" aria-label="Update bestätigen">
            <span className="update-confirm-text">
              {updateMessage ||
                `Version ${updatePreview.version} ist verfügbar (installiert: ${updatePreview.currentVersion})`}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={handleInstallUpdate}
            >
              Update installieren
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Update abbrechen"
              disabled={busy}
              onClick={handleDiscardUpdate}
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
            <div className="actions-menu" ref={actionsMenuRef}>
              <button
                ref={actionsMenuButtonRef}
                type="button"
                className="icon-button actions-menu-trigger"
                aria-label="Weitere Aktionen"
                aria-haspopup="menu"
                aria-expanded={actionsMenuOpen}
                onClick={() => setActionsMenuOpen((open) => !open)}
              >
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
              {actionsMenuOpen ? (
                <div className="actions-menu-dropdown" role="menu" aria-label="Weitere Aktionen">
                  <button type="button" role="menuitem" onClick={handleBackupClick}>
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
                  <button type="button" role="menuitem" onClick={handleRestoreClick}>
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
                  <button type="button" role="menuitem" onClick={handleUpdateCheck}>
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
                      <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" />
                      <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
                    </svg>
                    Nach Updates suchen
                  </button>
                </div>
              ) : null}
            </div>
            <PrimaryButton onClick={onAddVehicle}>+ Fahrzeug</PrimaryButton>
          </>
        )}
      </div>
    </header>
  );
}
