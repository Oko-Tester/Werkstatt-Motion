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

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  pendingUpdate?.close();
  pendingUpdate = await check({ timeout: 30_000 });
  if (pendingUpdate === null) {
    return null;
  }
  return {
    version: pendingUpdate.version,
    currentVersion: pendingUpdate.currentVersion,
    notes: pendingUpdate.body ?? null,
  };
}

export function discardUpdate() {
  pendingUpdate?.close();
  pendingUpdate = null;
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
