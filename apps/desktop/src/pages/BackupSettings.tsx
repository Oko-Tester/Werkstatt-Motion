import { Fragment, useEffect, useState } from "react";
import * as api from "../api";
import { toApiError } from "../api";
import { InfoTip } from "../components/InfoTip";
import { formatLastBackup, isBackupOverdue } from "../lastBackup";

interface Message {
  kind: "ok" | "error";
  text: string;
}

/** „Zuletzt gesichert: heute 08:12“; ist es länger als zwei Tage her, sagt die Zeile das dazu. */
function lastBackupText(at: number | null): string {
  const overdue = isBackupOverdue(at) ? " – länger als zwei Tage her" : "";
  return `Zuletzt gesichert: ${formatLastBackup(at)}${overdue}`;
}

/**
 * Zeigt einen Pfad so an, dass er bei Platzmangel an den Ordnergrenzen umbricht
 * statt mitten im Namen. `<wbr>` fügt beim Kopieren keine Zeichen ein.
 */
function PathText({ path }: { path: string }) {
  return (
    <>
      {path.split(/([\\/])/).map((part, index) => (
        <Fragment key={index}>
          {part}
          {(part === "\\" || part === "/") && <wbr />}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Datensicherung: zeigt, wann zuletzt gesichert wurde, richtet einen zweiten
 * Speicherort (USB-Stick, Netzlaufwerk) für die tägliche automatische Kopie ein
 * und sichert auf Knopfdruck sofort. Der Stand kommt aus den Dateien selbst.
 */
export function BackupSettings() {
  const [status, setStatus] = useState<api.BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getBackupStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((err) => {
        if (active) setMessage({ kind: "error", text: toApiError(err).message });
      });
    return () => {
      active = false;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage({ kind: "error", text: toApiError(err).message });
    } finally {
      setBusy(false);
    }
  }

  function chooseFolder() {
    return run(async () => {
      const before = status?.secondDir ?? null;
      const next = await api.chooseSecondBackupDir();
      setStatus(next);
      if (next.secondDir !== null && next.secondDir !== before) {
        // Gleich die erste Kopie anlegen, damit man sieht, dass es klappt.
        const daily = await api.createDailyBackup();
        if (daily.second?.error) setMessage({ kind: "error", text: daily.second.error });
        setStatus(await api.getBackupStatus());
      }
    });
  }

  function removeFolder() {
    return run(async () => {
      setStatus(await api.clearSecondBackupDir());
    });
  }

  function saveNow() {
    return run(async () => {
      const result = await api.backupNow();
      if (result.saved) {
        setMessage({ kind: "ok", text: `Gesichert: ${result.path ?? ""}` });
      }
      setStatus(await api.getBackupStatus());
    });
  }

  const messageBox =
    message === null ? null : (
      <p
        role={message.kind === "error" ? "alert" : "status"}
        className={message.kind === "error" ? "backup-message is-error" : "backup-message is-ok"}
      >
        {message.text}
      </p>
    );

  if (status === null) {
    return messageBox ?? <p className="settings-empty">Wird geladen …</p>;
  }

  return (
    <>
      <div className="backup-card">
        <div className="backup-row">
          <div className="backup-row-label">
            Auf diesem Computer
            <InfoTip label="Auf diesem Computer">
              Die App sichert deine Daten jeden Tag von selbst und behält die letzten{" "}
              {status.retentionDays} Tage, mindestens aber die drei neuesten Sicherungen.
              <span className="info-tip-path">
                <PathText path={status.localDir} />
              </span>
            </InfoTip>
          </div>
          <div className="backup-row-body">
            <div
              className={
                isBackupOverdue(status.localLastAt)
                  ? "backup-row-value is-error"
                  : "backup-row-value"
              }
            >
              {lastBackupText(status.localLastAt)}
            </div>
          </div>
        </div>
        <div className="backup-row">
          <div className="backup-row-label">
            Zweiter Speicherort
            <InfoTip label="Zweiter Speicherort">
              Eine zweite Kopie auf einem USB-Stick oder Netzlaufwerk schützt dich, wenn dieser
              Computer ausfällt oder gestohlen wird. Die App legt im gewählten Ordner einen eigenen
              Ordner an und sichert nur darin, jeden Tag neu. Die Kopie enthält Kundendaten, also
              den Stick sicher aufbewahren.
            </InfoTip>
          </div>
          <div className="backup-row-body">
            {status.secondDir === null ? (
              <div className="backup-row-value is-muted">Noch nicht eingerichtet</div>
            ) : (
              <div className="backup-row-value">
                <PathText path={status.secondDir} />
                {status.secondError !== null ? (
                  <span className="backup-row-detail is-error" role="alert">
                    {status.secondError}
                  </span>
                ) : (
                  <span
                    className={
                      isBackupOverdue(status.secondLastAt)
                        ? "backup-row-detail is-error"
                        : "backup-row-detail"
                    }
                  >
                    {lastBackupText(status.secondLastAt)}
                  </span>
                )}
              </div>
            )}
            <div className="backup-row-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                {status.secondDir === null ? "Ordner wählen …" : "Ändern …"}
              </button>
              {status.secondDir !== null && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void removeFolder()}
                >
                  Entfernen
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="backup-now">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void saveNow()}
        >
          Jetzt sichern
        </button>
        <InfoTip label="Jetzt sichern">
          {status.secondDir === null
            ? "Fragt, wohin die Sicherung gespeichert werden soll. "
            : "Speichert sofort eine Sicherung im zweiten Speicherort. "}
          Zurückspielen kannst du sie über das Menü ⋯ oben rechts › Wiederherstellen.
        </InfoTip>
      </div>
      {/* Unter dem Knopf, damit die Rückmeldung nichts nach unten schiebt. */}
      {messageBox}
    </>
  );
}
