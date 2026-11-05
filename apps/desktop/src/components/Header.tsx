import { useEffect, useRef, useState } from "react";
import { toApiError } from "../api";
import type { BackupResult, RestorePreview, UpdateBackupResult } from "../api";
import { useHeaderSlotRefs } from "../state/headerSlots";
import type { AvailableUpdate, UpdateProgress } from "../updates";
import { UpdateBackupDialog } from "./UpdateBackupDialog";

interface HeaderProps {
  onBackup: () => Promise<BackupResult>;
  onPrepareRestore: () => Promise<RestorePreview>;
  onConfirmRestore: () => Promise<void>;
  onCancelRestore: () => Promise<void>;
  /** Fragt nach einer neuen Version – einmal still beim Start, sonst über das Menü. */
  onCheckForUpdates: () => Promise<AvailableUpdate | null>;
  /** Pflicht-Backup vor dem Update. Scheitert es, entscheidet der Nutzer im Fenster. */
  onCreateUpdateBackup: (targetVersion: string) => Promise<UpdateBackupResult>;
  /** Lädt und installiert die zuletzt gefundene Version; danach startet die App neu. */
  onInstallUpdate: (onProgress: (progress: UpdateProgress) => void) => Promise<void>;
}

const STATUS_MS = 4000;

interface StatusMessage {
  text: string;
  kind: "ok" | "error";
}

/** Beschriftung des Update-Knopfs, während Download und Installation laufen. */
function describeUpdateProgress(progress: UpdateProgress): string {
  if (progress.finished) {
    return "Installiert …";
  }
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    const percent = Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
    return `Lädt … ${percent} %`;
  }
  return "Lädt …";
}

export function Header({
  onBackup,
  onPrepareRestore,
  onConfirmRestore,
  onCancelRestore,
  onCheckForUpdates,
  onCreateUpdateBackup,
  onInstallUpdate,
}: HeaderProps) {
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  // Gefundene neue Version: Solange sie gesetzt ist, steht der Update-Knopf neben „⋯“.
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  // Beschriftung des Update-Knopfs, solange ein Update läuft.
  const [updateProgress, setUpdateProgress] = useState<string | null>(null);
  // Grund, warum das automatische Backup vor dem Update scheiterte; öffnet das Fenster.
  const [updateBackupProblem, setUpdateBackupProblem] = useState<string | null>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const updateButtonRef = useRef<HTMLButtonElement>(null);
  // Die Seite des aktiven Bereichs setzt ihre Teile in diese beiden Plätze.
  const { startRef, actionsRef } = useHeaderSlotRefs();

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  // Beim Start still nach einer neuen Version fragen. Ohne Netz oder bei einem Fehler
  // bleibt der Knopf einfach weg; Fehler meldet nur die Suche über das Menü.
  useEffect(() => {
    let active = true;
    onCheckForUpdates()
      .then((available) => {
        if (active && available !== null) {
          setAvailableUpdate(available);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // Nur einmal beim Start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setAvailableUpdate(available);
      showStatus(
        available === null
          ? "Werkstatt Motion ist aktuell"
          : `Version ${available.version} ist verfügbar`,
        "ok",
      );
    } catch (err) {
      showStatus(errorMessage(err, "Die Update-Suche ist fehlgeschlagen"), "error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Klick auf den Update-Knopf: erst das Pflicht-Backup, dann Download und Installation.
   * Scheitert das Backup, startet nichts. Das Fenster lässt den Nutzer dann selbst ein
   * Backup speichern oder ausdrücklich auf eigenes Risiko ohne Backup weitermachen.
   */
  async function handleStartUpdate() {
    if (busy || availableUpdate === null) {
      return;
    }
    setBusy(true);
    setStatus(null);
    setUpdateProgress("Backup läuft …");
    try {
      await onCreateUpdateBackup(availableUpdate.version);
    } catch (err) {
      setUpdateProgress(null);
      setBusy(false);
      setUpdateBackupProblem(errorMessage(err, "Das Backup vor dem Update ist fehlgeschlagen"));
      return;
    }
    await installUpdate();
  }

  async function installUpdate() {
    setBusy(true);
    setUpdateProgress("Lädt …");
    try {
      await onInstallUpdate((progress) => setUpdateProgress(describeUpdateProgress(progress)));
    } catch (err) {
      showStatus(errorMessage(err, "Das Update konnte nicht installiert werden"), "error");
    } finally {
      // Nach einem Fehler bleibt der Knopf stehen: Ein neuer Klick versucht es noch einmal.
      setUpdateProgress(null);
      setBusy(false);
    }
  }

  function handleInstallWithoutAutomaticBackup() {
    setUpdateBackupProblem(null);
    void installUpdate();
  }

  function handleCancelUpdateDialog() {
    setUpdateBackupProblem(null);
    updateButtonRef.current?.focus();
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
      <h1 className="visually-hidden">Werkstatt Motion</h1>
      <div className="header-start" ref={startRef} />
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
            {availableUpdate !== null ? (
              <button
                ref={updateButtonRef}
                type="button"
                className={updateProgress !== null ? "update-button is-running" : "update-button"}
                disabled={busy}
                title={
                  updateProgress === null
                    ? `Version ${availableUpdate.version} installieren (installiert: ${availableUpdate.currentVersion}). Vorher legt die App ein Backup an.`
                    : undefined
                }
                onClick={handleStartUpdate}
              >
                {updateProgress !== null ? (
                  <svg
                    className="update-button-spinner"
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                  >
                    <path d="M21 12a9 9 0 1 1-6.22-8.56" />
                  </svg>
                ) : (
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7.5v9" />
                    <path d="m8 12.5 4 4 4-4" />
                  </svg>
                )}
                <span aria-live="polite">{updateProgress ?? `Update ${availableUpdate.version}`}</span>
              </button>
            ) : null}
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
            <div className="header-area-actions" ref={actionsRef} />
          </>
        )}
      </div>
      {updateBackupProblem !== null && availableUpdate !== null ? (
        <UpdateBackupDialog
          version={availableUpdate.version}
          reason={updateBackupProblem}
          onBackup={onBackup}
          onConfirm={handleInstallWithoutAutomaticBackup}
          onCancel={handleCancelUpdateDialog}
        />
      ) : null}
    </header>
  );
}
