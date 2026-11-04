import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { installFakeBackend } from "./test/fakeBackend";
import type { FakeBackend } from "./test/fakeBackend";

beforeEach(() => {
  // Mittwoch, 4. November 2026, 10:12 – „heute“ und die nächsten Termine stehen damit fest.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 4, 10, 12));
});

afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

const VEHICLES = [
  {
    customerName: "Müller",
    vehicleName: "VW Golf",
    licensePlate: "AB-CD 123",
    note: "Schlüssel im Kasten",
    appointmentAt: "2026-11-05T14:00",
  },
  {
    customerName: "Schmidt",
    vehicleName: "Opel Corsa",
    licensePlate: "EF-GH 456",
    appointmentAt: "2026-11-05T15:30",
  },
  {
    customerName: "Meyer",
    vehicleName: "Ford Focus",
    licensePlate: "IJ-KL 789",
    appointmentAt: "2026-11-06",
  },
  {
    customerName: "Früher",
    vehicleName: "Gestern-Auto",
    licensePlate: "X-Y 1",
    appointmentAt: "2026-11-03T09:00",
  },
];

function connected(backend: FakeBackend) {
  backend.google.email = "kollege@gmail.com";
  backend.google.lastSyncAt = Math.floor(new Date(2026, 10, 4, 9, 0).getTime() / 1000);
  backend.google.lastSyncCount = 4;
}

async function openCalendarSettings(configure?: (backend: FakeBackend) => void) {
  const backend = installFakeBackend({ vehicles: VEHICLES });
  configure?.(backend);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<App />);
  await screen.findByDisplayValue("Müller");
  const nav = screen.getByRole("navigation", { name: "Bereiche" });
  await user.click(within(nav).getByRole("button", { name: "Einstellungen" }));
  const settings = await screen.findByRole("region", { name: "Einstellungen" });
  await user.click(within(settings).getByRole("button", { name: "Kalender" }));
  const detail = await screen.findByRole("region", { name: "Einstellungen für Kalender" });
  await within(detail).findByText("Google Kalender");
  return { backend, user, detail };
}

function calls(backend: FakeBackend, cmd: string): number {
  return backend.calls.filter((call) => call === cmd).length;
}

function payloads(backend: FakeBackend, cmd: string) {
  return backend.callPayloads.filter((call) => call.cmd === cmd).map((call) => call.payload);
}

describe("Einstellungen: Google Kalender", () => {
  it("verbindet über den Browser und zeigt danach Konto, Stand und die nächsten Termine", async () => {
    const { backend, user, detail } = await openCalendarSettings();
    expect(await within(detail).findByText("Nicht verbunden")).toBeInTheDocument();

    await user.click(within(detail).getByRole("button", { name: "Mit Google verbinden" }));
    expect(
      await within(detail).findByText(
        "Browser geöffnet: bei Google anmelden und den Zugriff erlauben.",
      ),
    ).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Abbrechen" })).toBeInTheDocument();
    expect(backend.calls).toContain("google_connect");

    backend.finishGoogleConnect({ email: "kollege@gmail.com" });

    expect(await within(detail).findByText("kollege@gmail.com")).toBeInTheDocument();
    expect(
      within(detail).getByText("Zuletzt abgeglichen: heute 10:12 · 4 Termine"),
    ).toBeInTheDocument();
    expect(within(detail).getByRole("status")).toHaveTextContent(
      "Verbunden. Die Termine stehen jetzt im Google Kalender.",
    );

    const list = within(detail).getByRole("list", { name: "Nächste Termine bei Google" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Do 05.11.14:00–15:00VW Golf",
      "Do 05.11.15:30–16:30Opel Corsa",
      "Fr 06.11.GanztägigFord Focus",
    ]);
    // Knapper Inhalt: keine Kundennamen, keine Kennzeichen, nie Notizen.
    expect(list).not.toHaveTextContent("Müller");
    expect(list).not.toHaveTextContent("AB-CD");
    expect(list).not.toHaveTextContent("Schlüssel");
  });

  it("bricht eine wartende Anmeldung ab, ohne etwas zu ändern", async () => {
    const { backend, user, detail } = await openCalendarSettings();
    await user.click(await within(detail).findByRole("button", { name: "Mit Google verbinden" }));
    await user.click(await within(detail).findByRole("button", { name: "Abbrechen" }));

    expect(await within(detail).findByText("Nicht verbunden")).toBeInTheDocument();
    expect(backend.calls).toContain("google_cancel_connect");
    expect(within(detail).queryByRole("alert")).not.toBeInTheDocument();
    expect(backend.google.email).toBeNull();
  });

  it("bricht die Anmeldung ab, wenn man die Seite verlässt", async () => {
    const { backend, user, detail } = await openCalendarSettings();
    await user.click(await within(detail).findByRole("button", { name: "Mit Google verbinden" }));
    await within(detail).findByRole("button", { name: "Abbrechen" });

    const settings = screen.getByRole("region", { name: "Einstellungen" });
    await user.click(within(settings).getByRole("button", { name: "Fahrzeuge" }));

    await waitFor(() => expect(backend.calls).toContain("google_cancel_connect"));
  });

  it("gibt die Adresse zum Kopieren heraus, falls sich kein Browser öffnet", async () => {
    const { user, detail } = await openCalendarSettings();
    await user.click(await within(detail).findByRole("button", { name: "Mit Google verbinden" }));
    await user.click(await within(detail).findByRole("button", { name: "Adresse kopieren" }));

    const address = await within(detail).findByRole("textbox", { name: "Adresse der Anmeldung" });
    expect(address).toHaveValue("https://accounts.google.com/o/oauth2/v2/auth?client_id=test");
    expect(await within(detail).findByRole("status")).toHaveTextContent("Adresse kopiert");
    await expect(navigator.clipboard.readText()).resolves.toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    );
  });

  it("zeigt einen Fehler der Anmeldung und bleibt unverbunden", async () => {
    const { backend, user, detail } = await openCalendarSettings();
    await user.click(await within(detail).findByRole("button", { name: "Mit Google verbinden" }));
    await within(detail).findByRole("button", { name: "Abbrechen" });

    backend.finishGoogleConnect({
      code: "google",
      message: "Der Zugriff wurde in Google nicht erlaubt.",
    });

    expect(await within(detail).findByRole("alert")).toHaveTextContent(
      "Der Zugriff wurde in Google nicht erlaubt.",
    );
    expect(within(detail).getByText("Nicht verbunden")).toBeInTheDocument();
  });

  it("wechselt den Inhalt, zeigt ihn gleich in der Vorschau und gleicht ab", async () => {
    const { backend, user, detail } = await openCalendarSettings(connected);
    const syncsBefore = calls(backend, "google_sync");

    await user.click(
      await within(detail).findByRole("radio", { name: "Mit Kunde und Kennzeichen" }),
    );

    const list = within(detail).getByRole("list", { name: "Nächste Termine bei Google" });
    expect(await within(list).findByText("Müller – VW Golf · AB-CD 123")).toBeInTheDocument();
    expect(payloads(backend, "google_set_content")).toEqual([{ content: "full" }]);
    await waitFor(() => expect(calls(backend, "google_sync")).toBe(syncsBefore + 1));
    expect(within(detail).getByRole("radio", { name: "Mit Kunde und Kennzeichen" })).toBeChecked();
  });

  it("gleicht auf Knopfdruck ab und meldet einen Fehlschlag ehrlich", async () => {
    const { backend, user, detail } = await openCalendarSettings(connected);
    backend.google.syncError =
      "Keine Verbindung zu Google. Der nächste Versuch läuft automatisch.";

    await user.click(await within(detail).findByRole("button", { name: "Jetzt abgleichen" }));
    expect(await within(detail).findByRole("alert")).toHaveTextContent("Keine Verbindung zu Google.");
    const detailLine = within(detail).getAllByText(/Keine Verbindung zu Google/)[0];
    expect(detailLine.className).toMatch(/is-error/);

    backend.google.syncError = null;
    await user.click(within(detail).getByRole("button", { name: "Jetzt abgleichen" }));
    expect(await within(detail).findByRole("status")).toHaveTextContent("Abgeglichen.");
    expect(
      within(detail).getByText("Zuletzt abgeglichen: heute 10:12 · 4 Termine"),
    ).toBeInTheDocument();
  });

  it("trennt erst nach Rückfrage und löscht dabei den Kalender bei Google", async () => {
    const { backend, user, detail } = await openCalendarSettings(connected);
    await user.click(await within(detail).findByRole("button", { name: "Trennen" }));

    const confirm = within(detail).getByRole("group", { name: "Trennen bestätigen" });
    expect(confirm).toHaveTextContent("Der Kalender „Werkstatt Motion“ wird bei Google gelöscht.");
    expect(backend.calls).not.toContain("google_disconnect");

    await user.click(within(confirm).getByRole("button", { name: "Trennen" }));

    expect(await within(detail).findByText("Nicht verbunden")).toBeInTheDocument();
    expect(within(detail).getByRole("status")).toHaveTextContent(
      "Getrennt. Der Kalender „Werkstatt Motion“ ist bei Google gelöscht.",
    );
    expect(payloads(backend, "google_disconnect")).toEqual([{ deleteCalendar: true }]);
    expect(backend.google.calendarDeleted).toBe(true);
  });

  it("lässt das Trennen abbrechen", async () => {
    const { backend, user, detail } = await openCalendarSettings(connected);
    await user.click(await within(detail).findByRole("button", { name: "Trennen" }));
    const confirm = within(detail).getByRole("group", { name: "Trennen bestätigen" });
    await user.click(within(confirm).getByRole("button", { name: "Abbrechen" }));

    expect(within(detail).queryByRole("group", { name: "Trennen bestätigen" })).toBeNull();
    expect(within(detail).getByText("kollege@gmail.com")).toBeInTheDocument();
    expect(backend.calls).not.toContain("google_disconnect");
  });

  it("bietet „Nur hier trennen“ an, wenn Google den Kalender nicht löschen kann", async () => {
    const { backend, user, detail } = await openCalendarSettings((fake) => {
      connected(fake);
      fake.google.disconnectError = {
        code: "google",
        message:
          "Der Kalender „Werkstatt Motion“ konnte bei Google nicht gelöscht werden. Google ist gerade nicht erreichbar. Die Verbindung bleibt bestehen.",
      };
    });
    await user.click(await within(detail).findByRole("button", { name: "Trennen" }));
    const confirm = within(detail).getByRole("group", { name: "Trennen bestätigen" });
    await user.click(within(confirm).getByRole("button", { name: "Trennen" }));

    expect(await within(detail).findByRole("alert")).toHaveTextContent("Die Verbindung bleibt bestehen.");
    expect(within(detail).getByText("kollege@gmail.com")).toBeInTheDocument();

    await user.click(await within(confirm).findByRole("button", { name: "Nur hier trennen" }));

    expect(await within(detail).findByText("Nicht verbunden")).toBeInTheDocument();
    expect(within(detail).getByRole("status")).toHaveTextContent(
      "Den Kalender „Werkstatt Motion“ kannst du in Google selbst löschen.",
    );
    expect(payloads(backend, "google_disconnect")).toEqual([
      { deleteCalendar: true },
      { deleteCalendar: false },
    ]);
    expect(backend.google.calendarDeleted).toBe(false);
  });

  it("meldet eine abgelaufene Verbindung einmal am Tag und lässt neu verbinden", async () => {
    const { backend, user, detail } = await openCalendarSettings((fake) => {
      connected(fake);
      fake.google.needsReconnect = true;
    });

    expect(screen.getByText(/Google Kalender: Die Verbindung ist abgelaufen/)).toBeInTheDocument();
    expect(
      within(detail).getByText(
        "Die Verbindung zu Google ist abgelaufen oder wurde widerrufen. Bitte neu verbinden.",
      ),
    ).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Jetzt abgleichen" })).toBeNull();

    // Der Hinweis verschwindet und kommt beim stündlichen Lauf am selben Tag nicht wieder.
    await vi.advanceTimersByTimeAsync(7000);
    await waitFor(() =>
      expect(screen.queryByText(/Google Kalender: Die Verbindung ist abgelaufen/)).toBeNull(),
    );
    const before = calls(backend, "google_sync");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await waitFor(() => expect(calls(backend, "google_sync")).toBeGreaterThan(before));
    expect(screen.queryByText(/Google Kalender: Die Verbindung ist abgelaufen/)).toBeNull();

    await user.click(within(detail).getByRole("button", { name: "Neu verbinden" }));
    await within(detail).findByRole("button", { name: "Abbrechen" });
    backend.finishGoogleConnect({ email: "kollege@gmail.com" });

    expect(await within(detail).findByRole("button", { name: "Jetzt abgleichen" })).toBeInTheDocument();
    expect(within(detail).getByText(/Zuletzt abgeglichen: heute/)).toBeInTheDocument();
  });

  it("ist ohne Google-Zugangs-ID nicht verfügbar", async () => {
    const { detail } = await openCalendarSettings((fake) => {
      fake.google.configured = false;
    });
    expect(await within(detail).findByText("In dieser Version nicht verfügbar")).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Mit Google verbinden" })).toBeNull();
  });

  it("hält die Erklärung hinter dem Info-Knopf", async () => {
    const { user, detail } = await openCalendarSettings();
    expect(within(detail).queryByRole("tooltip")).toBeNull();
    await user.click(within(detail).getByRole("button", { name: "Info: Google Kalender" }));
    const tip = within(detail).getByRole("tooltip");
    expect(tip).toHaveTextContent("eigenen Kalender „Werkstatt Motion“");
    expect(tip).toHaveTextContent("Andere Kalender liest oder ändert sie nie.");
  });
});

describe("Abgleich mit Google Kalender im Hintergrund", () => {
  it("gleicht beim Start und danach stündlich ab", async () => {
    const backend = installFakeBackend({ vehicles: VEHICLES });
    connected(backend);
    render(<App />);
    await screen.findByDisplayValue("Müller");
    await waitFor(() => expect(calls(backend, "google_sync")).toBe(1));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await waitFor(() => expect(calls(backend, "google_sync")).toBe(2));
    expect(backend.google.lastError).toBeNull();
  });

  it("bleibt ohne Netz still", async () => {
    const backend = installFakeBackend({ vehicles: VEHICLES });
    connected(backend);
    backend.google.syncError = "Keine Verbindung zu Google. Der nächste Versuch läuft automatisch.";
    render(<App />);
    await screen.findByDisplayValue("Müller");
    await waitFor(() => expect(calls(backend, "google_sync")).toBe(1));
    expect(screen.queryByText(/Keine Verbindung zu Google/)).toBeNull();
  });
});
