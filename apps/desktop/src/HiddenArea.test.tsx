import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { installFakeBackend } from "./test/fakeBackend";
import type { FakeBackend } from "./test/fakeBackend";

const HIDDEN_REGION = { name: "Versteckte Einträge" };

function seedData() {
  return {
    vehicles: [
      { customerName: "Müller, Anna", vehicleName: "VW Golf VII", licensePlate: "M-AB 1234" },
    ],
    payments: [{ customerName: "Schneider, Thomas", amountCents: 48650, note: "Bremsen" }],
    hidden: [{ name: "Kasse B", amountCents: 77700, note: "" }],
  };
}

async function renderApp() {
  const view = render(<App />);
  await screen.findByDisplayValue("Müller, Anna");
  return view;
}

function logo(container: HTMLElement): Element {
  const element = container.querySelector(".app-logo");
  if (!element) {
    throw new Error("Logo nicht gefunden");
  }
  return element;
}

/** Hält das Logo gedrückt und lässt die Zeit verstreichen. */
function holdLogo(container: HTMLElement, ms: number) {
  fireEvent.pointerDown(logo(container), { button: 0 });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("Versteckter Bereich: Long-Press am Logo", () => {
  let backend: FakeBackend;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend = installFakeBackend(seedData());
  });

  afterEach(() => {
    vi.useRealTimers();
    clearMocks();
  });

  it("öffnet nichts bei normalem Klick oder unter drei Sekunden", async () => {
    const { container } = await renderApp();

    fireEvent.click(logo(container));
    holdLogo(container, 2999);
    fireEvent.pointerUp(logo(container));
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByRole("region", HIDDEN_REGION)).not.toBeInTheDocument();
    expect(backend.calls).not.toContain("hidden_status");
  });

  it("öffnet nach drei Sekunden Gedrückthalten genau einmal", async () => {
    const { container } = await renderApp();

    holdLogo(container, 3000);
    expect(await screen.findByRole("region", HIDDEN_REGION)).toBeInTheDocument();

    // Weiteres Halten oder erneutes Drücken löst nicht erneut aus.
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    fireEvent.pointerUp(logo(container));
    holdLogo(container, 3000);
    expect(screen.getAllByRole("region", HIDDEN_REGION)).toHaveLength(1);
    fireEvent.pointerUp(logo(container));
  });

  it("bricht bei pointercancel und pointerleave korrekt ab", async () => {
    const { container } = await renderApp();

    holdLogo(container, 1500);
    fireEvent.pointerCancel(logo(container));
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.queryByRole("region", HIDDEN_REGION)).not.toBeInTheDocument();

    holdLogo(container, 1500);
    fireEvent.pointerLeave(logo(container));
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.queryByRole("region", HIDDEN_REGION)).not.toBeInTheDocument();
  });

  it("zeigt während des Gedrückthaltens keinerlei Fortschrittsanzeige", async () => {
    const { container } = await renderApp();

    const before = container.innerHTML;
    fireEvent.pointerDown(logo(container), { button: 0 });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // Kein Ring, kein Balken, kein Countdown, keine DOM-Änderung.
    expect(container.innerHTML).toBe(before);
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    fireEvent.pointerUp(logo(container));
  });

  it("schließt den Bereich mit einem Klick auf das X", async () => {
    const { container } = await renderApp();

    holdLogo(container, 3000);
    await screen.findByRole("region", HIDDEN_REGION);

    fireEvent.click(screen.getByRole("button", { name: "Versteckten Bereich schließen" }));
    expect(screen.queryByRole("region", HIDDEN_REGION)).not.toBeInTheDocument();
    // Die offenen Zahlungen bleiben sichtbar.
    expect(screen.getByRole("region", { name: "Offene Zahlungen" })).toBeInTheDocument();
  });
});

describe("Versteckter Bereich: Einträge", () => {
  let backend: FakeBackend;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend = installFakeBackend(seedData());
  });

  afterEach(() => {
    vi.useRealTimers();
    clearMocks();
  });

  async function openHiddenArea(container: HTMLElement) {
    holdLogo(container, 3000);
    await screen.findByRole("region", HIDDEN_REGION);
    fireEvent.pointerUp(logo(container));
  }

  it("zeigt vorhandene Einträge entschlüsselt an", async () => {
    const { container } = await renderApp();
    await openHiddenArea(container);

    expect(await screen.findByDisplayValue("Kasse B")).toBeInTheDocument();
    expect(backend.calls).toContain("list_hidden_entries");
  });

  it("legt über eine bearbeitbare Zeile einen Eintrag an", async () => {
    const { container } = await renderApp();
    await openHiddenArea(container);
    await screen.findByDisplayValue("Kasse B");

    fireEvent.click(screen.getByRole("button", { name: "+ Eintrag" }));
    const nameField = screen.getByRole("textbox", { name: "Bezeichnung (Neuer Eintrag)" });
    expect(nameField).toHaveFocus();

    fireEvent.change(nameField, { target: { value: "Nebenkasse" } });
    fireEvent.blur(nameField);
    act(() => {
      vi.advanceTimersByTime(10);
    });

    const amountField = screen.getByRole("textbox", { name: "Betrag (Nebenkasse)" });
    fireEvent.change(amountField, { target: { value: "1.234,56" } });
    fireEvent.blur(amountField);
    act(() => {
      vi.advanceTimersByTime(10);
    });

    await waitFor(() => expect(backend.calls).toContain("create_hidden_entry"));
    const created = backend.hiddenEntries.find((entry) => entry.name === "Nebenkasse");
    expect(created?.amountCents).toBe(123456);
    expect(await screen.findByDisplayValue(/1\.234,56/)).toBeInTheDocument();
  });

  it("bearbeitet den Betrag direkt und speichert automatisch", async () => {
    const { container } = await renderApp();
    await openHiddenArea(container);
    const amountField = await screen.findByDisplayValue(/777,00/);

    fireEvent.change(amountField, { target: { value: "500" } });
    fireEvent.blur(amountField);

    await waitFor(() => expect(backend.calls).toContain("update_hidden_entry"));
    expect(backend.hiddenEntries[0].amountCents).toBe(50000);
  });

  it("archiviert mit Rückgängig statt Bestätigungsdialog", async () => {
    const { container } = await renderApp();
    await openHiddenArea(container);
    await screen.findByDisplayValue("Kasse B");

    fireEvent.click(screen.getByRole("button", { name: "Kasse B archivieren" }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue("Kasse B")).not.toBeInTheDocument(),
    );
    expect(backend.hiddenEntries[0].archivedAt).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Rückgängig" }));
    expect(await screen.findByDisplayValue("Kasse B")).toBeInTheDocument();
    expect(backend.hiddenEntries[0].archivedAt).toBeNull();
  });

  it("zeigt bei fehlendem Schlüssel einen sicheren Fehlerzustand", async () => {
    clearMocks();
    backend = installFakeBackend({
      ...seedData(),
      hiddenError: {
        code: "key_missing",
        message: "Schlüssel nicht gefunden, aber es existieren bereits verschlüsselte Einträge.",
      },
    });
    const { container } = await renderApp();
    await openHiddenArea(container);

    expect(await screen.findByRole("alert")).toHaveTextContent("Schlüssel nicht gefunden");
    expect(screen.queryByRole("button", { name: "+ Eintrag" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Kasse B")).not.toBeInTheDocument();
  });
});

describe("Backup und Wiederherstellung", () => {
  let backend: FakeBackend;

  beforeEach(() => {
    backend = installFakeBackend(seedData());
  });

  afterEach(() => {
    clearMocks();
  });

  it("erstellt ein Backup mit einem Klick und zeigt eine dezente Bestätigung", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Backup" }));

    expect(await screen.findByText("Backup erstellt")).toBeInTheDocument();
    expect(backend.calls).toContain("create_backup");
    expect(backend.backups).toHaveLength(1);
  });

  it("zeigt bei abgebrochenem Dialog keine Erfolgsmeldung", async () => {
    const user = userEvent.setup();
    await renderApp();
    backend.planCancel("create_backup");

    await user.click(screen.getByRole("button", { name: "Backup" }));

    await waitFor(() => expect(backend.calls).toContain("create_backup"));
    expect(backend.backups).toHaveLength(0);
    expect(screen.queryByText("Backup erstellt")).not.toBeInTheDocument();
  });

  it("stellt ein gültiges Backup über die zweistufige Inline-Aktion wieder her", async () => {
    const user = userEvent.setup();
    await renderApp();

    // Backup erstellen, danach Daten verändern.
    await user.click(screen.getByRole("button", { name: "Backup" }));
    await screen.findByText("Backup erstellt");
    await user.click(screen.getByRole("button", { name: "M-AB 1234 archivieren" }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue("Müller, Anna")).not.toBeInTheDocument(),
    );

    // Klick 1: Datei wählen (nativer Dialog) und validieren.
    await user.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    const confirmButton = await screen.findByRole("button", { name: "Jetzt wiederherstellen" });
    expect(screen.getByText(/Backup vom .* ersetzt die aktuellen Daten/)).toBeInTheDocument();

    // Klick 2: bestätigen – mehr Klicks braucht es nicht.
    await user.click(confirmButton);

    expect(await screen.findByText("Wiederherstellung abgeschlossen")).toBeInTheDocument();
    expect(backend.calls).toContain("confirm_restore");
    expect(await screen.findByDisplayValue("Müller, Anna")).toBeInTheDocument();
  });

  it("bricht die vorbereitete Wiederherstellung mit einem Klick ab", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Backup" }));
    await screen.findByText("Backup erstellt");

    await user.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    await screen.findByRole("button", { name: "Jetzt wiederherstellen" });

    await user.click(screen.getByRole("button", { name: "Wiederherstellung abbrechen" }));

    expect(screen.queryByRole("button", { name: "Jetzt wiederherstellen" })).not.toBeInTheDocument();
    await waitFor(() => expect(backend.calls).toContain("cancel_restore"));
    expect(backend.calls).not.toContain("confirm_restore");
    expect(screen.getByDisplayValue("Müller, Anna")).toBeInTheDocument();
  });

  it("lehnt ein beschädigtes Backup ab, ohne die aktuellen Daten anzufassen", async () => {
    const user = userEvent.setup();
    await renderApp();
    backend.planFailure("prepare_restore", {
      code: "backup",
      message: "Backup ist beschädigt (Prüfsumme stimmt nicht)",
    });

    await user.click(screen.getByRole("button", { name: "Wiederherstellen" }));

    expect(await screen.findByText(/Backup ist beschädigt/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jetzt wiederherstellen" })).not.toBeInTheDocument();
    expect(backend.calls).not.toContain("confirm_restore");
    // Bestehende Daten unverändert sichtbar.
    expect(screen.getByDisplayValue("Müller, Anna")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/486,50/)).toBeInTheDocument();
  });
});
