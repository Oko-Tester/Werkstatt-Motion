import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface UpdateProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  finished: boolean;
}

let pendingUpdate: Update | null = null;
let runningCheck: Promise<AvailableUpdate | null> | null = null;

/**
 * Fragt bei GitHub nach einer neuen Version. Überschneiden sich zwei Prüfungen – etwa die
 * beim Start und ein Klick auf „Nach Updates suchen“ –, teilen sie sich eine Anfrage.
 */
export function checkForUpdate(): Promise<AvailableUpdate | null> {
  runningCheck ??= runCheck().finally(() => {
    runningCheck = null;
  });
  return runningCheck;
}

async function runCheck(): Promise<AvailableUpdate | null> {
  const update = await check({ timeout: 30_000 });
  // Das vorige Ergebnis erst jetzt freigeben: Scheitert die Prüfung, bleibt es gültig.
  if (pendingUpdate !== null) {
    void pendingUpdate.close().catch(() => {});
  }
  pendingUpdate = update;
  if (update === null) {
    return null;
  }
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? null,
  };
}

export async function installUpdate(
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  const update = pendingUpdate;
  if (update === null) {
    throw new Error("Kein geprüftes Update verfügbar");
  }

  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  const report = (event: DownloadEvent) => {
    switch (event.event) {
      case "Started":
        totalBytes = event.data.contentLength ?? null;
        onProgress({ downloadedBytes, totalBytes, finished: false });
        break;
      case "Progress":
        downloadedBytes += event.data.chunkLength;
        onProgress({ downloadedBytes, totalBytes, finished: false });
        break;
      case "Finished":
        onProgress({ downloadedBytes, totalBytes, finished: true });
        break;
    }
  };

  await update.downloadAndInstall(report);
  pendingUpdate = null;
  // Unter Windows beendet der Installer die App automatisch. Auf anderen
  // Plattformen sorgt der explizite Neustart dafür, dass die neue Version
  // sofort läuft.
  await relaunch();
}
