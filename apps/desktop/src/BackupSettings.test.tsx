import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { installFakeBackend } from "./test/fakeBackend";
import type { FakeBackend } from "./test/fakeBackend";

beforeEach(() => {
  // Feste Uhrzeit, damit „heute 08:12“ nicht vom Ausführungszeitpunkt abhängt.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 21, 8, 12));
});

afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

async function openBackupSettings(configure?: (backend: FakeBackend) => void) {
  const backend = installFakeBackend({
    vehicles: [{ customerName: "Müller, Anna", vehicleName: "VW Golf", licensePlate: "M-AB 1" }],
  });
  configure?.(backend);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);
  await screen.findByDisplayValue("Müller, Anna");
  const nav = screen.getByRole("navigation", { name: "Bereiche" });
  await user.click(within(nav).getByRole("button", { name: "Einstellungen" }));
  const settings = await screen.findByRole("region", { name: "Einstellungen" });
  await user.click(within(settings).getByRole("button", { name: "Datensicherung" }));
  const detail = await screen.findByRole("region", { name: "Einstellungen für Datensicherung" });
  await within(detail).findByText("Auf diesem Computer");
  return { backend, user, detail };
}

function dailyBackupCalls(backend: FakeBackend): number {
  return backend.calls.filter((call) => call === "create_daily_backup").length;
}

describe("Einstellungen: Datensicherung", () => {
  it("zeigt die letzte Sicherung auf diesem Computer und dass noch kein zweiter Ort da ist", async () => {
    const { detail } = await openBackupSettings();

    expect(within(detail).getByText("Zuletzt gesichert: heute 08:12")).toBeInTheDocument();
    expect(within(detail).getByText("Noch nicht eingerichtet")).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Ordner wählen …" })).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Entfernen" })).not.toBeInTheDocument();
  });

  it("hält die Erklärungen hinter Info-Knöpfen statt als Fließtext auf der Seite", async () => {
    const { user, detail } = await openBackupSettings();
    expect(within(detail).queryByRole("tooltip")).not.toBeInTheDocument();
    expect(within(detail).queryByText(/Die letzten 14 Tage/)).not.toBeInTheDocument();

    await user.click(within(detail).getByRole("button", { name: "Info: Auf diesem Computer" }));
    const local = within(detail).getByRole("tooltip");
    expect(local).toHaveTextContent("behält die letzten 14 Tage");
    expect(local).toHaveTextContent("/data/backups");

    await user.click(within(detail).getByRole("button", { name: "Info: Zweiter Speicherort" }));
    expect(within(detail).getByRole("tooltip")).toHaveTextContent("USB-Stick oder Netzlaufwerk");
    expect(within(detail).getByRole("tooltip")).toHaveTextContent("eigenen Ordner");

    await user.click(within(detail).getByRole("button", { name: "Info: Jetzt sichern" }));
    expect(within(detail).getByRole("tooltip")).toHaveTextContent(
      "Fragt, wohin die Sicherung gespeichert werden soll.",
    );
    expect(within(detail).getByRole("tooltip")).toHaveTextContent("Wiederherstellen");
  });

  it("richtet einen zweiten Speicherort ein und legt gleich die erste Kopie an", async () => {
    const { backend, user, detail } = await openBackupSettings();
    expect(dailyBackupCalls(backend)).toBe(1);

    await user.click(within(detail).getByRole("button", { name: "Ordner wählen …" }));

    expect(await within(detail).findByText("/media/usb/Sicherung")).toBeInTheDocument();
    await waitFor(() => expect(dailyBackupCalls(backend)).toBe(2));
    await waitFor(() =>
      expect(within(detail).getAllByText("Zuletzt gesichert: heute 08:12")).toHaveLength(2),
    );
    expect(within(detail).getByRole("button", { name: "Ändern …" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Entfernen" })).toBeInTheDocument();
  });

  it("ändert nichts, wenn der Ordner-Dialog abgebrochen wird", async () => {
    const { backend, user, detail } = await openBackupSettings((fake) =>
      fake.planCancel("choose_second_backup_dir"),
    );

    await user.click(within(detail).getByRole("button", { name: "Ordner wählen …" }));

    await waitFor(() => expect(backend.calls).toContain("choose_second_backup_dir"));
    await waitFor(() =>
      expect(within(detail).getByRole("button", { name: "Ordner wählen …" })).toBeEnabled(),
    );
    expect(within(detail).getByText("Noch nicht eingerichtet")).toBeInTheDocument();
    expect(backend.backupConfig.secondDir).toBeNull();
    expect(dailyBackupCalls(backend)).toBe(1);
  });

  it("entfernt den zweiten Speicherort wieder", async () => {
    const { backend, user, detail } = await openBackupSettings((fake) => {
      fake.backupConfig.secondDir = "/media/usb/Sicherung";
    });
    expect(within(detail).getByText("/media/usb/Sicherung")).toBeInTheDocument();

    await user.click(within(detail).getByRole("button", { name: "Entfernen" }));

    expect(await within(detail).findByText("Noch nicht eingerichtet")).toBeInTheDocument();
    expect(backend.backupConfig.secondDir).toBeNull();
  });

  it("sichert auf Knopfdruck sofort in den zweiten Speicherort", async () => {
    const { backend, user, detail } = await openBackupSettings((fake) => {
      fake.backupConfig.secondDir = "/media/usb/Sicherung";
    });

    await user.click(within(detail).getByRole("button", { name: "Jetzt sichern" }));

    expect(
      await within(detail).findByText(
        "Gesichert: /media/usb/Sicherung/manuell-test.werkstattbackup",
      ),
    ).toBeInTheDocument();
    expect(backend.calls).toContain("backup_now");
  });

  it("fragt ohne zweiten Speicherort nach dem Ziel und bleibt beim Abbrechen still", async () => {
    const { backend, user, detail } = await openBackupSettings();

    await user.click(within(detail).getByRole("button", { name: "Jetzt sichern" }));
    expect(
      await within(detail).findByText("Gesichert: /backups/test.werkstattbackup"),
    ).toBeInTheDocument();

    backend.planCancel("backup_now");
    await user.click(within(detail).getByRole("button", { name: "Jetzt sichern" }));
    await waitFor(() =>
      expect(backend.calls.filter((call) => call === "backup_now")).toHaveLength(2),
    );
    await waitFor(() =>
      expect(within(detail).getByRole("button", { name: "Jetzt sichern" })).toBeEnabled(),
    );
    expect(within(detail).queryByText(/Gesichert:/)).not.toBeInTheDocument();
  });

  it("meldet einen nicht erreichbaren zweiten Ordner einmal beim Start und dauerhaft in den Einstellungen", async () => {
    const { backend, user, detail } = await openBackupSettings((fake) => {
      fake.backupConfig.secondDir = "/media/usb/Sicherung";
      fake.backupConfig.reachable = false;
    });

    expect(screen.getByText(/Zweite Sicherung nicht möglich/)).toBeInTheDocument();
    expect(within(detail).getByText(/nicht erreichbar/)).toBeInTheDocument();
    expect(within(detail).queryByText(/Zuletzt gesichert: heute 08:12 .*/)).not.toBeInTheDocument();

    // „Jetzt sichern“ sagt ehrlich, dass es nicht geht.
    await user.click(within(detail).getByRole("button", { name: "Jetzt sichern" }));
    expect(await within(detail).findAllByText(/nicht erreichbar/)).toHaveLength(2);

    // Die Meldung verschwindet und kommt beim stündlichen Prüflauf nicht erneut.
    await vi.advanceTimersByTimeAsync(7000);
    await waitFor(() =>
      expect(screen.queryByText(/Zweite Sicherung nicht möglich/)).not.toBeInTheDocument(),
    );
    const before = dailyBackupCalls(backend);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await waitFor(() => expect(dailyBackupCalls(backend)).toBeGreaterThan(before));
    expect(screen.queryByText(/Zweite Sicherung nicht möglich/)).not.toBeInTheDocument();
  });

  it("erinnert am nächsten Tag noch einmal, wenn der zweite Ordner weiter fehlt", async () => {
    const { backend } = await openBackupSettings((fake) => {
      fake.backupConfig.secondDir = "/media/usb/Sicherung";
      fake.backupConfig.reachable = false;
    });
    expect(screen.getByText(/Zweite Sicherung nicht möglich/)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(7000);

    // Bis kurz vor Mitternacht bleibt es still (08:12 + 15 h = 23:12).
    await vi.advanceTimersByTimeAsync(15 * 60 * 60 * 1000);
    expect(screen.queryByText(/Zweite Sicherung nicht möglich/)).not.toBeInTheDocument();

    // Der erste Lauf des nächsten Tages (00:12) meldet das Problem erneut.
    const before = dailyBackupCalls(backend);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(dailyBackupCalls(backend)).toBeGreaterThan(before);
    expect(await screen.findByText(/Zweite Sicherung nicht möglich/)).toBeInTheDocument();
  });

  it("startet keinen neuen Lauf, solange der vorige am hängenden Laufwerk noch wartet", async () => {
    const backend = installFakeBackend({
      vehicles: [{ customerName: "Müller, Anna", vehicleName: "VW Golf", licensePlate: "M-AB 1" }],
    });
    const release = backend.holdDailyBackup();
    render(<App />);
    await screen.findByDisplayValue("Müller, Anna");
    expect(dailyBackupCalls(backend)).toBe(1);

    // Drei Stunden lang hängt der erste Lauf: Es kommt kein zweiter dazu.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(dailyBackupCalls(backend)).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await waitFor(() => expect(dailyBackupCalls(backend)).toBe(2));
  });

  it("färbt eine Sicherung rot, die länger als zwei Tage zurückliegt", async () => {
    const { backend, user, detail } = await openBackupSettings((fake) => {
      fake.backupConfig.secondDir = "/media/usb/Sicherung";
    });
    expect(within(detail).getAllByText("Zuletzt gesichert: heute 08:12")).toHaveLength(2);

    // Der Stick steckte tagelang nicht: Die letzte Kopie ist vom 18. Oktober.
    backend.backupConfig.localLastAt = new Date(2026, 9, 18, 8, 0).getTime();
    backend.backupConfig.secondLastAt = new Date(2026, 9, 18, 8, 0).getTime();
    const settings = screen.getByRole("region", { name: "Einstellungen" });
    await user.click(within(settings).getByRole("button", { name: "Fahrzeuge" }));
    await user.click(within(settings).getByRole("button", { name: "Datensicherung" }));

    const overdue = await screen.findAllByText(
      "Zuletzt gesichert: 18.10.2026 08:00 – länger als zwei Tage her",
    );
    expect(overdue).toHaveLength(2);
    overdue.forEach((line) => expect(line.className).toMatch(/is-error/));
  });
});
