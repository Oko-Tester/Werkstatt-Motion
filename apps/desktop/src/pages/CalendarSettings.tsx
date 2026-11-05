import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { toApiError } from "../api";
import { localDateKey } from "../appointments";
import { InfoTip } from "../components/InfoTip";
import { formatLastBackup } from "../lastBackup";
import type { GoogleContent, GooglePreviewEvent, GoogleStatus } from "../types";

interface Message {
  kind: "ok" | "error";
  text: string;
}

const PREVIEW_COUNT = 3;
const SHORT_WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;

const CONTENT_OPTIONS: ReadonlyArray<{ value: GoogleContent; label: string }> = [
  { value: "short", label: "Nur Uhrzeit und Fahrzeug" },
  { value: "full", label: "Mit Kunde und Kennzeichen" },
];

/** „Zuletzt abgeglichen: heute 10:12 · 3 Termine“ */
function lastSyncText(status: GoogleStatus): string {
  if (status.lastSyncAt === null) return "Noch nicht abgeglichen";
  const count = status.lastSyncCount ?? 0;
  const appointments = count === 1 ? "1 Termin" : `${count} Termine`;
  return `Zuletzt abgeglichen: ${formatLastBackup(status.lastSyncAt * 1000)} · ${appointments}`;
}

/** „Do 05.11.“ */
function dayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = SHORT_WEEKDAYS[new Date(year, month - 1, day).getDay()];
  return `${weekday} ${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.`;
}

function timeLabel(event: GooglePreviewEvent): string {
  if (event.time === null) return "Ganztägig";
  return event.endTime === null ? event.time : `${event.time}–${event.endTime}`;
}

function upcomingEvents(events: GooglePreviewEvent[]): GooglePreviewEvent[] {
  const today = localDateKey(new Date());
  return events.filter((event) => event.date >= today).slice(0, PREVIEW_COUNT);
}

/**
 * Einstellungen des Kalenders: die Verbindung zu Google Kalender. Die App legt im
 * Google-Konto einen eigenen Kalender „Werkstatt Motion“ an und trägt dort die Termine ein –
 * nur in diese Richtung, nur zum Ansehen. Die Anmeldung läuft im Browser.
 */
export function CalendarSettings() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [offerLocalDisconnect, setOfferLocalDisconnect] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const mounted = useRef(true);
  const connectingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    api
      .getGoogleStatus()
      .then((next) => {
        if (mounted.current) setStatus(next);
      })
      .catch((err) => {
        if (mounted.current) setMessage({ kind: "error", text: toApiError(err).message });
      });
    return () => {
      mounted.current = false;
      // Wer die Seite verlässt, während die Anmeldung wartet, bricht sie ab – sonst
      // hinge ein neuer Versuch bis zu fünf Minuten an der alten.
      if (connectingRef.current) void api.cancelGoogleConnect().catch(() => {});
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      if (mounted.current) setMessage({ kind: "error", text: toApiError(err).message });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function connect() {
    setMessage(null);
    setPendingUrl(null);
    setConfirmDisconnect(false);
    setOfferLocalDisconnect(false);
    setConnecting(true);
    connectingRef.current = true;
    try {
      const next = await api.connectGoogle();
      connectingRef.current = false;
      if (!mounted.current) return;
      setStatus(next);
      if (next.connected) {
        setMessage(
          next.lastError !== null
            ? { kind: "error", text: next.lastError }
            : { kind: "ok", text: "Verbunden. Die Termine stehen jetzt im Google Kalender." },
        );
      }
    } catch (err) {
      connectingRef.current = false;
      if (mounted.current) setMessage({ kind: "error", text: toApiError(err).message });
    } finally {
      if (mounted.current) setConnecting(false);
    }
  }

  async function showAddress() {
    try {
      const url = await api.getGooglePendingUrl();
      if (!mounted.current || url === null) return;
      setPendingUrl(url);
      if (navigator.clipboard === undefined) return;
      await navigator.clipboard.writeText(url);
      if (mounted.current) {
        setMessage({ kind: "ok", text: "Adresse kopiert. Im Browser einfügen und öffnen." });
      }
    } catch {
      // Ohne Zwischenablage bleibt die Adresse im Feld zum Markieren.
    }
  }

  function syncNow() {
    return run(async () => {
      const next = await api.syncGoogle();
      setStatus(next);
      setMessage(
        next.lastError !== null
          ? { kind: "error", text: next.lastError }
          : { kind: "ok", text: "Abgeglichen." },
      );
    });
  }

  function changeContent(content: GoogleContent) {
    return run(async () => {
      setStatus(await api.setGoogleContent(content));
      const next = await api.syncGoogle();
      setStatus(next);
      if (next.lastError !== null) setMessage({ kind: "error", text: next.lastError });
    });
  }

  function disconnect(deleteCalendar: boolean) {
    return run(async () => {
      try {
        const next = await api.disconnectGoogle(deleteCalendar);
        setStatus(next);
        setConfirmDisconnect(false);
        setOfferLocalDisconnect(false);
        setMessage({
          kind: "ok",
          text: deleteCalendar
            ? "Getrennt. Der Kalender „Werkstatt Motion“ ist bei Google gelöscht."
            : "Getrennt. Den Kalender „Werkstatt Motion“ kannst du in Google selbst löschen.",
        });
      } catch (err) {
        // Der Kalender ließ sich bei Google nicht löschen; die Verbindung bleibt bestehen.
        setOfferLocalDisconnect(deleteCalendar);
        throw err;
      }
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

  const title = (
    <div className="settings-title">
      <h4 id="google-calendar-title">Google Kalender</h4>
      <InfoTip label="Google Kalender">
        Die App legt in deinem Google-Konto einen eigenen Kalender „Werkstatt Motion“ an und
        trägt dort die Termine ein, nur zum Ansehen. Andere Kalender liest oder ändert sie nie.
        Dafür gehen die Termine über das Internet zu Google; ohne Verbindung läuft die App wie
        bisher. Abgeglichen wird wenige Sekunden nach jeder Änderung an einem Termin, beim
        Start der App, stündlich und mit „Jetzt abgleichen“.
      </InfoTip>
    </div>
  );

  if (status === null) {
    return (
      <section className="settings-section" aria-labelledby="google-calendar-title">
        {title}
        {messageBox ?? <p className="settings-empty">Wird geladen …</p>}
      </section>
    );
  }

  if (!status.configured) {
    return (
      <section className="settings-section" aria-labelledby="google-calendar-title">
        {title}
        <div className="google-unavailable">
          <span className="settings-empty">In dieser Version nicht verfügbar</span>
          <InfoTip label="Nicht verfügbar">
            Diese Version wurde ohne Google-Zugangs-ID gebaut. Wie man sie einrichtet, steht in
            docs/google-kalender.md.
          </InfoTip>
        </div>
      </section>
    );
  }

  const upcoming = upcomingEvents(status.events);

  return (
    <section className="settings-section" aria-labelledby="google-calendar-title">
      {title}
      <div className="backup-card">
        <div className="backup-row">
          <div className="backup-row-label">Konto</div>
          <div className="backup-row-body">
            {connecting ? (
              <>
                <div className="backup-row-value">
                  Browser geöffnet: bei Google anmelden und den Zugriff erlauben.
                  <span className="backup-row-detail">
                    Öffnet sich kein Browser? Die Adresse lässt sich auch von Hand öffnen.
                  </span>
                </div>
                <div className="backup-row-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void showAddress()}
                  >
                    Adresse kopieren
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void api.cancelGoogleConnect()}
                  >
                    Abbrechen
                  </button>
                </div>
                {pendingUrl !== null && (
                  <input
                    className="google-url"
                    readOnly
                    value={pendingUrl}
                    aria-label="Adresse der Anmeldung"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                )}
              </>
            ) : !status.connected ? (
              <>
                <div className="backup-row-value is-muted">Nicht verbunden</div>
                <div className="backup-row-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void connect()}
                  >
                    Mit Google verbinden
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="backup-row-value">
                  {status.email}
                  {status.lastError !== null ? (
                    <span className="backup-row-detail is-error">{status.lastError}</span>
                  ) : (
                    <span className="backup-row-detail">{lastSyncText(status)}</span>
                  )}
                </div>
                <div className="backup-row-actions">
                  {status.needsReconnect ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => void connect()}
                    >
                      Neu verbinden
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => void syncNow()}
                    >
                      Jetzt abgleichen
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setMessage(null);
                      setOfferLocalDisconnect(false);
                      setConfirmDisconnect(true);
                    }}
                  >
                    Trennen
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {status.connected && !connecting && (
          <div className="backup-row">
            <div className="backup-row-label">
              Inhalt
              <InfoTip label="Inhalt">
                Kundenname und Kennzeichen gehen nur mit „Mit Kunde und Kennzeichen“ zu Google.
                Notizen bleiben immer in der App.
              </InfoTip>
            </div>
            <div className="backup-row-body" role="radiogroup" aria-label="Inhalt der Termine">
              {CONTENT_OPTIONS.map((option) => (
                <label key={option.value} className="column-visibility-option">
                  <input
                    type="radio"
                    name="google-content"
                    value={option.value}
                    checked={status.content === option.value}
                    disabled={busy}
                    onChange={() => void changeContent(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {confirmDisconnect && status.connected && (
        <div className="google-confirm" role="group" aria-label="Trennen bestätigen">
          <p>Der Kalender „Werkstatt Motion“ wird bei Google gelöscht.</p>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={() => void disconnect(true)}
          >
            Trennen
          </button>
          {offerLocalDisconnect && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void disconnect(false)}
            >
              Nur hier trennen
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => {
              setConfirmDisconnect(false);
              setOfferLocalDisconnect(false);
            }}
          >
            Abbrechen
          </button>
        </div>
      )}

      {status.connected && !connecting && (
        <div className="google-preview">
          <p className="google-preview-title">So steht es im Google Kalender</p>
          {upcoming.length === 0 ? (
            <p className="settings-empty">Keine anstehenden Termine</p>
          ) : (
            <ul aria-label="Nächste Termine bei Google">
              {upcoming.map((event, index) => (
                <li key={`${event.date}-${event.time ?? ""}-${index}`}>
                  <span className="google-preview-meta">{dayLabel(event.date)}</span>
                  <span className="google-preview-meta">{timeLabel(event)}</span>
                  <span className="google-preview-text">{event.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {messageBox}
    </section>
  );
}
