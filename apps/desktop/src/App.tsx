import { useEffect, useState } from "react";
import * as api from "./api";
import { toApiError } from "./api";
import { AREAS } from "./areas";
import type { Area } from "./areas";
import { AppShell } from "./components/AppShell";
import { Header } from "./components/Header";
import { NavRail } from "./components/NavRail";
import { AreasProvider } from "./state/AreasProvider";
import { FeedbackProvider, useFeedback } from "./state/feedback";
import { HeaderSlotsProvider } from "./state/headerSlots";
import { SearchFocusProvider } from "./state/searchFocus";
import { WorkshopProvider, useWorkshop } from "./state/WorkshopProvider";
import * as updates from "./updates";
import type { UpdateProgress } from "./updates";

const DAILY_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

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
  const { secret, confirmRestore } = useWorkshop();
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

  async function handleInstallUpdate(
    targetVersion: string,
    onProgress: (progress: UpdateProgress) => void,
  ) {
    // Die Installation darf erst beginnen, nachdem das Backend das
    // Sicherheits-Backup vollständig neben der EXE gespeichert hat.
    await api.createUpdateBackup(targetVersion);
    await updates.installUpdate(onProgress);
  }

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
          onInstallUpdate={handleInstallUpdate}
          onDiscardUpdate={() => updates.discardUpdate()}
        />
      }
    >
      <ActivePage />
    </AppShell>
  );
}
