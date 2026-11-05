import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { toApiError } from "../api";
import type { BackupResult } from "../api";

interface UpdateBackupDialogProps {
  /** Die Version, auf die aktualisiert werden soll. */
  version: string;
  /** Warum das automatische Backup vor dem Update gescheitert ist. */
  reason: string;
  /** Eigenes Backup über den Speichern-Dialog – wie „Backup“ im Drei-Punkte-Menü. */
  onBackup: () => Promise<BackupResult>;
  /** Installiert das Update ohne automatisches Backup. */
  onConfirm: () => void;
  onCancel: () => void;
}

type OwnBackup =
  | { state: "none" }
  | { state: "saving" }
  | { state: "saved"; path: string | null }
  | { state: "failed"; message: string };

/**
 * Fenster, wenn vor einem Update kein automatisches Backup möglich war. Installieren lässt
 * sich das Update erst, wenn hier ein eigenes Backup gespeichert wurde – oder wenn der
 * Nutzer ankreuzt, auf eigenes Risiko ohne Backup zu aktualisieren.
 */
export function UpdateBackupDialog({
  version,
  reason,
  onBackup,
  onConfirm,
  onCancel,
}: UpdateBackupDialogProps) {
  const titleId = useId();
  const textId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const backupButtonRef = useRef<HTMLButtonElement>(null);
  const [ownBackup, setOwnBackup] = useState<OwnBackup>({ state: "none" });
  const [riskAccepted, setRiskAccepted] = useState(false);
  const saving = ownBackup.state === "saving";
  const canInstall = !saving && (ownBackup.state === "saved" || riskAccepted);

  useEffect(() => {
    backupButtonRef.current?.focus();
  }, []);

  async function handleBackup() {
    if (saving) {
      return;
    }
    const before = ownBackup;
    setOwnBackup({ state: "saving" });
    try {
      const result = await onBackup();
      if (result.saved) {
        setOwnBackup({ state: "saved", path: result.path });
      } else {
        // Speichern-Dialog abgebrochen: Ein schon gespeichertes Backup gilt weiter.
        setOwnBackup(before.state === "saved" ? before : { state: "none" });
      }
    } catch (err) {
      setOwnBackup({ state: "failed", message: toApiError(err).message });
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Tastendrücke bleiben im Fenster: Kürzel der App dahinter (Strg+F, Escape in
    // Tabellen und Menüs) sollen nicht mitreagieren.
    event.stopPropagation();
    if (event.key === "Escape") {
      if (!saving) {
        onCancel();
      }
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    // Tab läuft im Kreis durch das Fenster, statt in die Seite dahinter zu springen.
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled)",
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !focusable.includes(active as HTMLElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !focusable.includes(active as HTMLElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="modal update-backup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="modal-title">
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          Backup vor dem Update fehlgeschlagen
        </h2>
        <div id={textId}>
          <p>
            Die App konnte vor dem Update auf Version {version} keine Sicherung anlegen. Speichere
            bitte zuerst selbst ein Backup, zum Beispiel auf einem USB-Stick.
          </p>
          <p className="modal-note">Grund: {reason}</p>
        </div>

        <div className="update-backup-own">
          <button
            ref={backupButtonRef}
            type="button"
            className="btn btn-secondary"
            disabled={saving}
            onClick={handleBackup}
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
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </svg>
            {saving ? "Wird gespeichert …" : "Backup speichern …"}
          </button>
          {ownBackup.state === "saved" ? (
            <p className="update-backup-result is-ok" role="status">
              ✓ Backup gespeichert{ownBackup.path !== null ? `: ${ownBackup.path}` : ""}
            </p>
          ) : ownBackup.state === "failed" ? (
            <p className="update-backup-result is-error" role="alert">
              Backup nicht gespeichert: {ownBackup.message}
            </p>
          ) : null}
        </div>

        <label className="update-backup-risk">
          <input
            type="checkbox"
            checked={riskAccepted}
            disabled={saving}
            onChange={(event) => setRiskAccepted(event.target.checked)}
          />
          <span>Auf eigenes Risiko ohne Backup aktualisieren</span>
        </label>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onCancel}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canInstall}
            onClick={onConfirm}
          >
            Update installieren
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
