import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { installFakeBackend } from "./test/fakeBackend";
import type { FakeBackend } from "./test/fakeBackend";
import type { UpdateProgress } from "./updates";

const updateMocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));

vi.mock("./updates", () => updateMocks);

const UPDATE = { version: "1.0.1", currentVersion: "1.0.0", notes: null };
const BACKUP_FAILED = {
  code: "backup" as const,
  message: "Das Sicherheits-Backup vor dem Update konnte nirgends gespeichert werden.",
};
const DIALOG = { name: "Backup vor dem Update fehlgeschlagen" };
const RISK = { name: "Auf eigenes Risiko ohne Backup aktualisieren" };

let backend: FakeBackend;

beforeEach(() => {
  updateMocks.checkForUpdate.mockReset().mockResolvedValue(null);
  updateMocks.installUpdate.mockReset().mockResolvedValue(undefined);
  backend = installFakeBackend({
    vehicles: [
      { customerName: "Müller, Anna", vehicleName: "VW Golf VII", licensePlate: "M-AB 1234" },
    ],
  });
});

afterEach(() => {
  clearMocks();
});

async function renderApp() {
  render(<App />);
  await screen.findByDisplayValue("Müller, Anna");
}

/** Startet die App mit einer neuen Version und liefert den Update-Knopf. */
async function renderWithUpdate() {
  updateMocks.checkForUpdate.mockResolvedValue(UPDATE);
  await renderApp();
  return screen.findByRole("button", { name: "Update 1.0.1" });
}

/** Klickt den Update-Knopf bei scheiterndem Pflicht-Backup und liefert das Fenster. */
async function openBackupDialog(user: ReturnType<typeof userEvent.setup>) {
  backend.planFailure("create_update_backup", BACKUP_FAILED);
  await user.click(await renderWithUpdate());
  return screen.findByRole("dialog", DIALOG);
}

function callCount(cmd: string) {
  return backend.calls.filter((call) => call === cmd).length;
}

describe("Update-Suche beim Start", () => {
  it("zeigt neben dem Drei-Punkte-Menü einen Knopf, wenn es eine neue Version gibt", async () => {
    const button = await renderWithUpdate();

    expect(updateMocks.checkForUpdate).toHaveBeenCalledOnce();
    // Direkt links neben „⋯“.
    expect(button.nextElementSibling).toContainElement(
      screen.getByRole("button", { name: "Weitere Aktionen" }),
    );
    expect(button).toHaveAttribute(
      "title",
      expect.stringContaining("Version 1.0.1 installieren (installiert: 1.0.0)"),
    );
    expect(backend.calls).not.toContain("create_update_backup");
    expect(updateMocks.installUpdate).not.toHaveBeenCalled();
  });

  it("zeigt keinen Knopf, wenn die App aktuell ist", async () => {
    await renderApp();

    await waitFor(() => expect(updateMocks.checkForUpdate).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Update/ })).not.toBeInTheDocument();
  });

  it("bleibt beim Start ohne Netz still; die Suche im Menü meldet den Fehler", async () => {
    const user = userEvent.setup();
    updateMocks.checkForUpdate.mockRejectedValue(new Error("Keine Verbindung zu GitHub"));
    await renderApp();

    await waitFor(() => expect(updateMocks.checkForUpdate).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(screen.queryByText("Keine Verbindung zu GitHub")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Update/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await user.click(screen.getByRole("menuitem", { name: "Nach Updates suchen" }));
    expect(await screen.findByText("Keine Verbindung zu GitHub")).toBeInTheDocument();
  });
});

describe("Update-Suche über das Menü", () => {
  it("meldet, wenn bereits die aktuelle Version installiert ist", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await user.click(screen.getByRole("menuitem", { name: "Nach Updates suchen" }));

    expect(await screen.findByText("Werkstatt Motion ist aktuell")).toBeInTheDocument();
    // Einmal beim Start, einmal von Hand.
    expect(updateMocks.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("zeigt eine neu gefundene Version mit demselben Knopf an", async () => {
    const user = userEvent.setup();
    await renderApp();
    await waitFor(() => expect(updateMocks.checkForUpdate).toHaveBeenCalledOnce());
    updateMocks.checkForUpdate.mockResolvedValue(UPDATE);

    await user.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await user.click(screen.getByRole("menuitem", { name: "Nach Updates suchen" }));

    expect(await screen.findByRole("button", { name: "Update 1.0.1" })).toBeEnabled();
    expect(screen.getByText("Version 1.0.1 ist verfügbar")).toBeInTheDocument();
    expect(updateMocks.installUpdate).not.toHaveBeenCalled();
  });
});

describe("Update mit einem Klick", () => {
  it("erstellt zuerst das Pflicht-Backup und installiert danach", async () => {
    const user = userEvent.setup();
    let backupBeforeInstall = false;
    updateMocks.installUpdate.mockImplementation(async () => {
      backupBeforeInstall = backend.calls.includes("create_update_backup");
    });

    await user.click(await renderWithUpdate());

    await waitFor(() => expect(updateMocks.installUpdate).toHaveBeenCalledOnce());
    expect(backupBeforeInstall).toBe(true);
    expect(
      backend.callPayloads.find((call) => call.cmd === "create_update_backup")?.payload,
    ).toMatchObject({ targetVersion: "1.0.1" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("zeigt den Fortschritt im Knopf", async () => {
    const user = userEvent.setup();
    let report: (progress: UpdateProgress) => void = () => {};
    updateMocks.installUpdate.mockImplementation(
      (onProgress: (progress: UpdateProgress) => void) => {
        report = onProgress;
        return new Promise<void>(() => {});
      },
    );
    const button = await renderWithUpdate();

    await user.click(button);
    await waitFor(() => expect(updateMocks.installUpdate).toHaveBeenCalledOnce());

    act(() => report({ downloadedBytes: 512, totalBytes: 1024, finished: false }));
    expect(button).toHaveTextContent("Lädt … 50 %");
    expect(button).toBeDisabled();

    act(() => report({ downloadedBytes: 1024, totalBytes: 1024, finished: true }));
    expect(button).toHaveTextContent("Installiert …");
  });

  it("meldet einen Fehler beim Herunterladen und lässt den Knopf für einen neuen Versuch stehen", async () => {
    const user = userEvent.setup();
    updateMocks.installUpdate.mockRejectedValueOnce(new Error("Download abgebrochen"));

    await user.click(await renderWithUpdate());

    expect(await screen.findByText("Download abgebrochen")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Update 1.0.1" });
    expect(button).toBeEnabled();

    await user.click(button);
    await waitFor(() => expect(updateMocks.installUpdate).toHaveBeenCalledTimes(2));
  });
});

describe("Pflicht-Backup vor dem Update scheitert", () => {
  it("öffnet ein Fenster und installiert erst nach dem Haken auf eigenes Risiko", async () => {
    const user = userEvent.setup();
    const dialog = await openBackupDialog(user);

    expect(dialog).toHaveTextContent("Update auf Version 1.0.1");
    expect(dialog).toHaveTextContent(`Grund: ${BACKUP_FAILED.message}`);
    expect(updateMocks.installUpdate).not.toHaveBeenCalled();
    const install = within(dialog).getByRole("button", { name: "Update installieren" });
    expect(install).toBeDisabled();

    await user.click(within(dialog).getByRole("checkbox", RISK));
    expect(install).toBeEnabled();
    await user.click(install);

    await waitFor(() => expect(updateMocks.installUpdate).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Kein zweiter Versuch des Pflicht-Backups, kein eigenes Backup.
    expect(callCount("create_update_backup")).toBe(1);
    expect(callCount("create_backup")).toBe(0);
  });

  it("lässt nach einem eigenen Backup im Fenster auch ohne Haken installieren", async () => {
    const user = userEvent.setup();
    const dialog = await openBackupDialog(user);
    const ownBackup = within(dialog).getByRole("button", { name: "Backup speichern …" });
    expect(ownBackup).toHaveFocus();

    await user.click(ownBackup);

    expect(
      await within(dialog).findByText("✓ Backup gespeichert: /backups/test.werkstattbackup"),
    ).toBeInTheDocument();
    expect(backend.backups).toHaveLength(1);
    expect(within(dialog).getByRole("checkbox", RISK)).not.toBeChecked();
    const install = within(dialog).getByRole("button", { name: "Update installieren" });
    expect(install).toBeEnabled();

    await user.click(install);
    await waitFor(() => expect(updateMocks.installUpdate).toHaveBeenCalledOnce());
  });

  it("schaltet nichts frei, wenn der Speichern-Dialog abgebrochen wird", async () => {
    const user = userEvent.setup();
    const dialog = await openBackupDialog(user);
    backend.planCancel("create_backup");
    const ownBackup = within(dialog).getByRole("button", { name: "Backup speichern …" });

    await user.click(ownBackup);

    await waitFor(() => expect(backend.calls).toContain("create_backup"));
    await waitFor(() => expect(ownBackup).toBeEnabled());
    expect(within(dialog).queryByText(/Backup gespeichert/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Update installieren" })).toBeDisabled();
  });

  it("zeigt, wenn auch das eigene Backup scheitert, und lässt den Haken weiter zu", async () => {
    const user = userEvent.setup();
    const dialog = await openBackupDialog(user);
    backend.planFailure("create_backup", {
      code: "keystore_unavailable",
      message: "Schlüsselspeicher nicht erreichbar",
    });

    await user.click(within(dialog).getByRole("button", { name: "Backup speichern …" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Backup nicht gespeichert: Schlüsselspeicher nicht erreichbar",
    );
    const install = within(dialog).getByRole("button", { name: "Update installieren" });
    expect(install).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", RISK));
    expect(install).toBeEnabled();
  });

  it("schließt mit „Abbrechen“ ohne Update; der Knopf bleibt", async () => {
    const user = userEvent.setup();
    const dialog = await openBackupDialog(user);

    await user.click(within(dialog).getByRole("checkbox", RISK));
    await user.click(within(dialog).getByRole("button", { name: "Abbrechen" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(updateMocks.installUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Update 1.0.1" })).toHaveFocus();
  });

  it("schließt mit Escape ohne Update", async () => {
    const user = userEvent.setup();
    await openBackupDialog(user);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(updateMocks.installUpdate).not.toHaveBeenCalled();
  });

  it("hält die Tastatur im Fenster", async () => {
    const user = userEvent.setup();
    const dialog = await openBackupDialog(user);
    const ownBackup = within(dialog).getByRole("button", { name: "Backup speichern …" });
    const risk = within(dialog).getByRole("checkbox", RISK);
    const cancel = within(dialog).getByRole("button", { name: "Abbrechen" });

    expect(ownBackup).toHaveFocus();
    await user.tab();
    expect(risk).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    // „Update installieren“ ist noch gesperrt: weiter vorne im Fenster statt in der Seite.
    await user.tab();
    expect(ownBackup).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });
});
