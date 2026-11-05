import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({ check: vi.fn() }));

vi.mock("@tauri-apps/plugin-updater", () => plugin);
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

function fakeUpdate(version: string) {
  return {
    version,
    currentVersion: "1.0.0",
    body: "Neu: Update-Knopf",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  };
}

/** Frisches Modul je Test: Das gemerkte Update lebt auf Modulebene. */
async function loadUpdates() {
  vi.resetModules();
  return import("./updates");
}

describe("checkForUpdate", () => {
  beforeEach(() => {
    plugin.check.mockReset();
  });

  it("stellt bei sich überschneidenden Prüfungen nur eine Anfrage", async () => {
    const { checkForUpdate } = await loadUpdates();
    let answer: (update: unknown) => void = () => {};
    plugin.check.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const atStart = checkForUpdate();
    const fromMenu = checkForUpdate();
    expect(plugin.check).toHaveBeenCalledOnce();

    answer(fakeUpdate("1.0.1"));
    const expected = { version: "1.0.1", currentVersion: "1.0.0", notes: "Neu: Update-Knopf" };
    await expect(atStart).resolves.toEqual(expected);
    await expect(fromMenu).resolves.toEqual(expected);

    // Ist die Anfrage beantwortet, fragt die nächste Prüfung wieder neu.
    plugin.check.mockResolvedValueOnce(null);
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(plugin.check).toHaveBeenCalledTimes(2);
  });

  it("gibt ein gefundenes Update erst frei, wenn eine neue Prüfung gelingt", async () => {
    const { checkForUpdate, installUpdate } = await loadUpdates();
    const first = fakeUpdate("1.0.1");
    plugin.check.mockResolvedValueOnce(first);
    await checkForUpdate();

    // Ohne Netz bleibt das gefundene Update installierbar.
    plugin.check.mockRejectedValueOnce(new Error("offline"));
    await expect(checkForUpdate()).rejects.toThrow("offline");
    expect(first.close).not.toHaveBeenCalled();

    const second = fakeUpdate("1.0.2");
    plugin.check.mockResolvedValueOnce(second);
    await checkForUpdate();
    expect(first.close).toHaveBeenCalledOnce();

    await installUpdate(() => {});
    expect(second.downloadAndInstall).toHaveBeenCalledOnce();
    expect(first.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("verweigert die Installation ohne vorherige Prüfung", async () => {
    const { installUpdate } = await loadUpdates();

    await expect(installUpdate(() => {})).rejects.toThrow("Kein geprüftes Update verfügbar");
  });
});
