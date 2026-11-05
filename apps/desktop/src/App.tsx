import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import { toApiError } from "./api";
import { AREAS } from "./areas";
import type { Area } from "./areas";
import { AppShell } from "./components/AppShell";
import { Header } from "./components/Header";
import { NavRail } from "./components/NavRail";
import {
  GOOGLE_SYNC_AFTER_CHANGE_MS,
  calendarSignature,
  createGoogleSyncScheduler,
} from "./googleSync";
import type { GoogleSyncScheduler } from "./googleSync";
import { AreasProvider } from "./state/AreasProvider";
import { FeedbackProvider, useFeedback } from "./state/feedback";
import { HeaderSlotsProvider } from "./state/headerSlots";
import { SearchFocusProvider } from "./state/searchFocus";
import { WorkshopProvider, useWorkshop } from "./state/WorkshopProvider";
import * as updates from "./updates";

const DAILY_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const GOOGLE_SYNC_INTERVAL_MS = 60 * 60 * 1000;

interface AppProps {
  /** Die Bereiche der Leiste. Standard ist die Bereichsliste; Tests setzen eigene ein. */
  areas?: readonly Area[];
}

export default function App({ areas = AREAS }: AppProps) {
  return (
    <AreasProvider areas={areas}>
      <HeaderSlotsProvider>
        <FeedbackProvider>
          <WorkshopProvider>
            <SearchFocusProvider>
              <AppFrame areas={areas} />
            </SearchFocusProvider>
          </WorkshopProvider>
        </FeedbackProvider>
      </HeaderSlotsProvider>
    </AreasProvider>
  );
}

/** Gerüst der App: Leiste, Kopfzeile und die Seite des aktiven Bereichs. */
function AppFrame({ areas }: { areas: readonly Area[] }) {
  const { showNotice } = useFeedback();
  const { secret, confirmRestore, vehicles, loading } = useWorkshop();
  const googleSync = useRef<GoogleSyncScheduler | null>(null);
  const [activeAreaId, setActiveAreaId] = useState(areas[0].id);
  const activeArea = areas.find((area) => area.id === activeAreaId) ?? areas[0];
  const ActivePage = activeArea.Page;

  useEffect(() => {
    let active = true;
    // Ein langsames oder hängendes Laufwerk soll keine stündlich neuen Läufe aufstauen.
    let running = false;
    // Probleme mit dem zweiten Speicherort melden wir nicht stündlich, sondern
    // einmal pro Tag und wenn sich der Grund ändert.
    let lastSecondError: string | null = null;
    let lastSecondErrorDay = "";

    function createDailyBackup() {
      if (running) return;
      running = true;
      void api
        .createDailyBackup()
        .then((result) => {
          const error = result.second?.error ?? null;
          const today = new Date().toDateString();
          if (active && error !== null && (error !== lastSecondError || today !== lastSecondErrorDay)) {
            showNotice(`Zweite Sicherung nicht möglich: ${error}`);
            lastSecondErrorDay = today;
          }
          lastSecondError = error;
        })
        .catch((err) => {
          if (active) {
            showNotice(`Automatisches Backup fehlgeschlagen: ${toApiError(err).message}`);
          }
        })
        .finally(() => {
          running = false;
        });
    }

    createDailyBackup();
    const timer = window.setInterval(createDailyBackup, DAILY_BACKUP_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    // Der Backend-Command ist idempotent und entscheidet anhand des lokalen Datums.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    // Ohne Netz bleibt es still (der nächste Lauf holt alles nach, der Stand steht in den
    // Einstellungen). Ist der Zugang abgelaufen, hilft nur der Nutzer: einmal pro Tag sagen.
    let lastReconnectNoticeDay = "";

    const scheduler = createGoogleSyncScheduler(async () => {
      const status = await api.syncGoogle();
      const today = new Date().toDateString();
      if (active && status.connected && status.needsReconnect && today !== lastReconnectNoticeDay) {
        showNotice(
          "Google Kalender: Die Verbindung ist abgelaufen. Bitte unter Einstellungen › Kalender neu verbinden.",
        );
        lastReconnectNoticeDay = today;
      }
    });
    googleSync.current = scheduler;
    scheduler.now();
    const timer = window.setInterval(() => scheduler.now(), GOOGLE_SYNC_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
      scheduler.dispose();
      googleSync.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wenige Sekunden nach jeder Änderung an Terminen abgleichen. Der erste geladene Stand
  // zählt nicht als Änderung; den deckt der Abgleich beim Start ab.
  const appointmentsSignature = useMemo(() => calendarSignature(vehicles.list), [vehicles.list]);
  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    if (lastSignature.current === null) {
      lastSignature.current = appointmentsSignature;
      return;
    }
    if (appointmentsSignature === lastSignature.current) return;
    lastSignature.current = appointmentsSignature;
    googleSync.current?.soon(GOOGLE_SYNC_AFTER_CHANGE_MS);
  }, [appointmentsSignature, loading]);

  return (
    <AppShell
      nav={
        <NavRail
          areas={areas}
          activeAreaId={activeArea.id}
          onSelectArea={setActiveAreaId}
          onOpenHiddenArea={secret.open}
        />
      }
      header={
        <Header
          onBackup={() => api.createBackup()}
          onPrepareRestore={() => api.prepareRestore()}
          onConfirmRestore={confirmRestore}
          onCancelRestore={() => api.cancelRestore()}
          onCheckForUpdates={() => updates.checkForUpdate()}
          onCreateUpdateBackup={(targetVersion) => api.createUpdateBackup(targetVersion)}
          onInstallUpdate={(onProgress) => updates.installUpdate(onProgress)}
        />
      }
    >
      <ActivePage />
    </AppShell>
  );
}
