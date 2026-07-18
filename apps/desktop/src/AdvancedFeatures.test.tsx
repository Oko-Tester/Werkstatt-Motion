import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import { rankCustomerSuggestions } from "./components/CustomerAutocomplete";
import { installFakeBackend } from "./test/fakeBackend";
import type { CustomerSuggestion } from "./types";

const baseSeed = {
  vehicles: [
    {
      customerName: "Müller, Anna",
      vehicleName: "VW Golf",
      licensePlate: "M-AB 1",
      isDone: true,
    },
    { customerName: "Auto König", vehicleName: "Audi A4", licensePlate: "M-K 2" },
  ],
  payments: [{ customerName: "Bestandskunde", amountCents: 9999, note: "Inspektion" }],
  hidden: [{ name: "Geheimkonto", amountCents: 77700, note: "Nur intern" }],
};

async function renderReady(seed = baseSeed) {
  const backend = installFakeBackend(seed);
  const view = render(<App />);
  await screen.findByDisplayValue("Müller, Anna");
  return { backend, view };
}

function getLogo(container: HTMLElement): Element {
  const logo = container.querySelector(".app-logo");
  if (!logo) throw new Error("Logo fehlt");
  return logo;
}

async function openSecret(container: HTMLElement) {
  fireEvent.pointerDown(getLogo(container), { button: 0 });
  act(() => vi.advanceTimersByTime(3000));
  await screen.findByRole("region", { name: "Weitere Zahlungen" });
  fireEvent.pointerUp(getLogo(container));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearMocks();
});

describe("Secret-Sitzung und Inline-Historie", () => {
  it("zeigt Fahrzeughistorie bereits gesperrt und lädt Secret-Daten erst nach Long-Press", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const storageGet = vi.spyOn(Storage.prototype, "getItem");
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const { backend, view } = await renderReady();

    expect(screen.queryByRole("region", { name: "Weitere Zahlungen" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Historie" })).toBeInTheDocument();
    expect(backend.calls).not.toContain("begin_secret_session");

    fireEvent.click(screen.getByRole("button", { name: "Historie" }));
    const publicWorkspace = await screen.findByRole("region", { name: "Historienarbeitsansicht" });
    expect(within(publicWorkspace).getByText("Müller, Anna")).toBeInTheDocument();
    expect(within(publicWorkspace).queryByText("Entschlüsselte Secret-History")).not.toBeInTheDocument();
    expect(within(publicWorkspace).queryByText("Geheimkonto")).not.toBeInTheDocument();
    expect(backend.calls).toContain("list_completed_vehicle_history");
    expect(backend.calls).not.toContain("list_hidden_entry_history");
    fireEvent.click(within(publicWorkspace).getByRole("button", { name: "← Zurück" }));

    await openSecret(view.container);
    expect(await screen.findByDisplayValue("Geheimkonto")).toBeInTheDocument();
    expect(backend.calls.indexOf("begin_secret_session")).toBeLessThan(
      backend.calls.indexOf("list_hidden_entries"),
    );
    const token = [...backend.activeSessionTokens][0];
    expect(token).toBeTruthy();
    expect(
      backend.callPayloads.find((call) => call.cmd === "list_hidden_entries")?.payload.sessionToken,
    ).toBe(token);
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("blendet Secret-History in der bereits geöffneten Historie erst nach Long-Press ein", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { backend, view } = await renderReady();
    backend.secretHistory.push({
      id: "sh-seeded",
      sourceHiddenEntryId: backend.hiddenEntries[0].id,
      name: "Versteckte Rechnung",
      amountCents: 77700,
      note: "Nur intern",
      completedOrArchivedAt: "2026-01-02T10:00:00.000Z",
      completedAt: "2026-01-02T10:00:00.000Z",
      createdAt: "2026-01-02T10:00:01.000Z",
    });

    fireEvent.click(screen.getByRole("button", { name: "Historie" }));
    const workspace = await screen.findByRole("region", { name: "Historienarbeitsansicht" });
    expect(within(workspace).queryByText("Versteckte Rechnung")).not.toBeInTheDocument();
    expect(backend.calls).not.toContain("list_hidden_entry_history");

    fireEvent.pointerDown(getLogo(view.container), { button: 0 });
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.pointerUp(getLogo(view.container));

    expect(await within(workspace).findByText("Entschlüsselte Secret-History")).toBeInTheDocument();
    expect(await within(workspace).findByText("Versteckte Rechnung")).toBeInTheDocument();
    expect(backend.calls).toContain("list_hidden_entry_history");
  });

  it("zeigt beide Historien als direkte Arbeitsansicht und kehrt sichtbar zurück", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { backend, view } = await renderReady();
    await openSecret(view.container);
    await screen.findByDisplayValue("Geheimkonto");

    fireEvent.click(screen.getByRole("button", { name: "Geheimkonto archivieren" }));
    await waitFor(() => expect(backend.secretHistory).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Historie" }));

    const workspace = await screen.findByRole("region", { name: "Historienarbeitsansicht" });
    expect(within(workspace).getByText("Fahrzeug-Snapshots")).toBeInTheDocument();
    expect(within(workspace).getByText("Entschlüsselte Secret-History")).toBeInTheDocument();
    expect(within(workspace).getByText("Geheimkonto")).toBeInTheDocument();
    expect(within(workspace).getByText("Müller, Anna")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Fahrzeuge" })).not.toBeInTheDocument();

    fireEvent.change(within(workspace).getByRole("searchbox", { name: "Historie durchsuchen" }), {
      target: { value: "Geheimkonto" },
    });
    expect(within(workspace).queryByText("Müller, Anna")).not.toBeInTheDocument();
    expect(within(workspace).getByText("Geheimkonto")).toBeInTheDocument();

    fireEvent.click(within(workspace).getByRole("button", { name: "← Zurück" }));
    expect(await screen.findByRole("region", { name: "Fahrzeuge" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Weitere Zahlungen" })).toBeInTheDocument();
  });

  it("entfernt beim Sperren alle Secret-Daten, lässt aber die öffentliche Fahrzeughistorie offen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { backend, view } = await renderReady();
    await openSecret(view.container);
    await screen.findByDisplayValue("Geheimkonto");

    fireEvent.click(screen.getByRole("button", { name: "Geheimkonto archivieren" }));
    await waitFor(() => expect(backend.secretHistory).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "+ Eintrag" }));
    const draft = screen.getByRole("combobox", { name: "Bezeichnung (Neuer Eintrag)" });
    fireEvent.change(draft, { target: { value: "Hochsensibler Entwurf" } });
    fireEvent.click(screen.getByRole("button", { name: "Historie" }));
    const workspace = await screen.findByRole("region", { name: "Historienarbeitsansicht" });
    expect(within(workspace).getByText("Geheimkonto")).toBeInTheDocument();

    fireEvent.click(within(workspace).getByRole("button", { name: "Secret-Bereich schließen" }));
    expect(screen.getByRole("region", { name: "Historienarbeitsansicht" })).toBeInTheDocument();
    expect(await within(workspace).findByText("Müller, Anna")).toBeInTheDocument();
    expect(within(workspace).queryByText("Entschlüsselte Secret-History")).not.toBeInTheDocument();
    expect(within(workspace).queryByText("Geheimkonto")).not.toBeInTheDocument();
    expect(within(workspace).queryByText("Hochsensibler Entwurf")).not.toBeInTheDocument();
    await waitFor(() => expect(backend.calls).toContain("end_secret_session"));
    expect(backend.activeSessionTokens.size).toBe(0);

    fireEvent.click(within(workspace).getByRole("button", { name: "← Zurück" }));
    expect(screen.getByRole("region", { name: "Fahrzeuge" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Weitere Zahlungen" })).not.toBeInTheDocument();
    expect(screen.queryByText("Hochsensibler Entwurf")).not.toBeInTheDocument();
  });

  it("verweigert Secret-CRUD und Secret-History ohne gültigen Token im Fake-Backend", async () => {
    installFakeBackend(baseSeed);
    await expect(api.listHiddenEntries("ungueltig")).rejects.toMatchObject({
      field: "sessionToken",
    });
    await expect(api.listEncryptedSecretHistory("ungueltig")).rejects.toMatchObject({
      field: "sessionToken",
    });
  });
});

describe("Zahlungsbereich und persistente UI-Präferenzen", () => {
  it("vergrößert den Bereich per Ziehgriff und stellt die Höhe nach Remount wieder her", async () => {
    const { backend, view } = await renderReady();
    const handle = screen.getByRole("separator", {
      name: "Höhe der offenen Zahlungen ändern",
    });

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientY: 400 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientY: 300 }));
    fireEvent(handle, new MouseEvent("pointerup", { bubbles: true, clientY: 300 }));

    await waitFor(() => expect(backend.preferences.paymentsPanelHeight).toBe(340));
    expect(screen.getByRole("region", { name: "Offene Zahlungen" })).toHaveStyle({
      height: "340px",
    });

    view.unmount();
    render(<App />);
    await screen.findByDisplayValue("Müller, Anna");
    expect(screen.getByRole("region", { name: "Offene Zahlungen" })).toHaveStyle({
      height: "340px",
    });
  });

  it("ändert die Höhe am Ziehgriff auch mit der Tastatur", async () => {
    const { backend } = await renderReady();
    const handle = screen.getByRole("separator", {
      name: "Höhe der offenen Zahlungen ändern",
    });

    fireEvent.keyDown(handle, { key: "ArrowUp" });

    await waitFor(() => expect(backend.preferences.paymentsPanelHeight).toBe(280));
    expect(handle).toHaveAttribute("aria-valuenow", "280");
  });

  it("minimiert mit einem Klick ohne sensible Inhaltsreste und stellt den Zustand nach Remount wieder her", async () => {
    const { backend, view } = await renderReady();
    const region = screen.getByRole("region", { name: "Offene Zahlungen" });
    expect(within(region).getByDisplayValue("Bestandskunde")).toBeInTheDocument();

    fireEvent.click(within(region).getByRole("button", { name: "Offene Zahlungen minimieren" }));
    const collapsed = screen.getByRole("region", { name: "Offene Zahlungen" });
    expect(within(collapsed).getByRole("heading", { name: "Offene Zahlungen" })).toBeInTheDocument();
    expect(within(collapsed).getByRole("button", { name: "Erweitern" })).toBeInTheDocument();
    expect(within(collapsed).queryByText("Bestandskunde")).not.toBeInTheDocument();
    expect(within(collapsed).queryByText(/99,99|Summe|Inspektion|Alles bezahlt/)).not.toBeInTheDocument();
    await waitFor(() => expect(backend.preferences.paymentsPanelCollapsed).toBe(true));

    view.unmount();
    render(<App />);
    await screen.findByDisplayValue("Müller, Anna");
    expect(
      within(screen.getByRole("region", { name: "Offene Zahlungen" })).getByRole("button", {
        name: "Erweitern",
      }),
    ).toBeInTheDocument();
    expect(backend.calls.filter((call) => call === "get_ui_preferences").length).toBeGreaterThanOrEqual(2);
  });

  it("stellt minimierten Zustand und Spaltenreihenfolge über Backup-Restore wieder her", async () => {
    const user = userEvent.setup();
    const { backend } = await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Offene Zahlungen minimieren" }));
    const customerHeader = screen.getByRole("columnheader", { name: /Kunde, Spalte verschieben/ });
    fireEvent.keyDown(within(customerHeader).getByRole("button"), {
      key: "ArrowRight",
      altKey: true,
    });
    await waitFor(() => expect(backend.preferences.vehicleColumnOrder[0]).toBe("vehicleName"));
    await user.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await user.click(screen.getByRole("menuitem", { name: "Backup" }));
    await screen.findByText("Backup erstellt");

    fireEvent.click(screen.getByRole("button", { name: "Erweitern" }));
    const vehicleHeader = screen.getByRole("columnheader", { name: /Fahrzeug, Spalte verschieben/ });
    fireEvent.keyDown(within(vehicleHeader).getByRole("button"), {
      key: "ArrowRight",
      altKey: true,
    });
    await waitFor(() => expect(backend.preferences.paymentsPanelCollapsed).toBe(false));

    await user.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await user.click(screen.getByRole("menuitem", { name: "Wiederherstellen" }));
    await user.click(await screen.findByRole("button", { name: "Jetzt wiederherstellen" }));
    expect(await screen.findByRole("button", { name: "Erweitern" })).toBeInTheDocument();
    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.getAttribute("data-column-id"))
      .filter(Boolean);
    expect(headers.slice(0, 2)).toEqual(["vehicleName", "customerName"]);
  });
});

describe("Fahrzeugspalten", () => {
  it("blendet Spalten per Rechtsklick aus und stellt die persistierte Auswahl wieder her", async () => {
    const user = userEvent.setup();
    const { backend, view } = await renderReady();
    const header = screen.getByRole("columnheader", { name: /Kennzeichen, Spalte verschieben/ });

    fireEvent.contextMenu(header, { clientX: 120, clientY: 80 });
    const menu = screen.getByRole("dialog", { name: "Spalten auswählen" });
    await user.click(within(menu).getByRole("checkbox", { name: "Kennzeichen" }));

    expect(
      screen.queryByRole("columnheader", { name: /Kennzeichen, Spalte verschieben/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("M-AB 1")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(backend.preferences.vehicleHiddenColumns).toEqual(["licensePlate"]),
    );

    view.unmount();
    render(<App />);
    await screen.findByDisplayValue("Müller, Anna");
    expect(
      screen.queryByRole("columnheader", { name: /Kennzeichen, Spalte verschieben/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("M-AB 1")).not.toBeInTheDocument();
  });

  it("rendert Header und Zeilen aus derselben gespeicherten Reihenfolge", async () => {
    installFakeBackend({
      ...baseSeed,
      uiPreferences: {
        vehicleColumnOrder: [
          "licensePlate",
          "customerName",
          "vehicleName",
          "isDone",
          "tuvRequired",
          "partsOrdered",
          "partsArrived",
        ],
      },
    });
    render(<App />);
    await screen.findByDisplayValue("Müller, Anna");

    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.getAttribute("data-column-id"))
      .filter(Boolean);
    expect(headers.slice(0, 3)).toEqual(["licensePlate", "customerName", "vehicleName"]);
    const firstDataRow = screen.getAllByRole("row")[1];
    const dataCells = within(firstDataRow).getAllByRole("cell");
    expect(within(dataCells[1]).getByDisplayValue("M-AB 1")).toBeInTheDocument();
    expect(within(dataCells[2]).getByDisplayValue("Müller, Anna")).toBeInTheDocument();
  });

  it("verschiebt per HTML5-DnD, zeigt aktive/drop Position, persistiert sofort und löst kein Zeilen-DnD aus", async () => {
    const { backend } = await renderReady();
    const customer = screen.getByRole("columnheader", { name: /Kunde, Spalte verschieben/ });
    const vehicle = screen.getByRole("columnheader", { name: /Fahrzeug, Spalte verschieben/ });
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(customer, { dataTransfer });
    expect(customer).toHaveClass("is-column-dragging");
    fireEvent.dragOver(vehicle, { dataTransfer, clientX: 1 });
    expect(vehicle).toHaveClass("is-column-drop-after");
    fireEvent.drop(vehicle, { dataTransfer, clientX: 1 });

    await waitFor(() => expect(backend.calls).toContain("update_vehicle_column_order"));
    expect(backend.preferences.vehicleColumnOrder.slice(0, 2)).toEqual([
      "vehicleName",
      "customerName",
    ]);
    expect(backend.calls).not.toContain("reorder_vehicles");
    const firstRow = screen.getAllByRole("row")[1];
    const cells = within(firstRow).getAllByRole("cell");
    expect(within(cells[1]).getByDisplayValue("VW Golf")).toBeInTheDocument();
    expect(within(firstRow).getByRole("button", { name: "Fertig (M-AB 1)" })).toBeInTheDocument();
  });

  it("verschiebt mit Alt+Pfeil und erhält den Tastaturfokus", async () => {
    const { backend } = await renderReady();
    const handle = screen.getByRole("button", { name: "Kunde, Spalte verschieben" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight", altKey: true });

    await waitFor(() => expect(backend.preferences.vehicleColumnOrder[0]).toBe("vehicleName"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Kunde, Spalte verschieben" })).toHaveFocus(),
    );
  });
});

describe("Kunden-Autocomplete", () => {
  it("rankt exakt, Anfang, Wortanfang und enthält, dann nach lastUsedAt, und begrenzt auf fünf", () => {
    const make = (id: string, customerName: string, lastUsedAt: string): CustomerSuggestion => ({
      id,
      customerName,
      vehicleName: null,
      licensePlate: null,
      lastUsedAt,
    });
    const suggestions = [
      make("1", "Müller", "2024-01-01"),
      make("2", "Müller & Sohn", "2025-01-01"),
      make("3", "Auto Müller", "2026-01-01"),
      make("4", "Altmüller", "2027-01-01"),
      make("5", "Auto Müller Süd", "2023-01-01"),
      make("6", "Müller Nord", "2022-01-01"),
      make("7", "Müller West", "2021-01-01"),
    ];
    expect(rankCustomerSuggestions(suggestions, "  MÜLLER ").map((item) => item.id)).toEqual([
      "1",
      "2",
      "6",
      "7",
      "3",
    ]);
  });

  it("lädt Vorschläge einmal, filtert Umlaute lokal und übernimmt per Maus nur den Namen mit Fokus auf Betrag", async () => {
    const user = userEvent.setup();
    const { backend } = await renderReady();
    await user.click(screen.getByRole("button", { name: "+ Offener Betrag" }));
    const customer = screen.getByRole("combobox", { name: "Kunde (Neue Zahlung)" });
    const initialLoads = backend.calls.filter((call) => call === "list_customer_suggestions").length;

    await user.type(customer, "mü");
    const option = screen.getByRole("option", { name: /Müller, Anna/ });
    expect(option).toBeInTheDocument();
    expect(option.closest(".payments-list")).not.toBeInTheDocument();
    expect(option.closest(".customer-suggestions")?.parentElement).toBe(document.body);
    expect(backend.calls.filter((call) => call === "list_customer_suggestions")).toHaveLength(
      initialLoads,
    );
    await user.click(option);
    expect(customer).toHaveValue("Müller, Anna");
    expect(String((customer as HTMLInputElement).value)).not.toContain("VW Golf");
    expect(screen.getByText(/VW Golf.*M-AB 1/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Betrag (Müller, Anna)" })).toHaveFocus(),
    );
  });

  it("unterstützt Pfeile, Enter, Escape, Tab und freie Eingabe ohne Hidden-Namen vorzuschlagen", async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.click(screen.getByRole("button", { name: "+ Offener Betrag" }));
    const customer = screen.getByRole("combobox", { name: "Kunde (Neue Zahlung)" });
    await user.type(customer, "a");
    expect(screen.queryByRole("option", { name: /Geheimkonto/ })).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}{ArrowUp}{Escape}");
    expect(screen.queryByRole("listbox", { name: "Kundenvorschläge" })).not.toBeInTheDocument();
    expect(customer).toHaveValue("a");
    await user.keyboard("{Tab}");
    expect(customer).toHaveValue("a");

    customer.focus();
    await user.clear(customer);
    await user.type(customer, "mü{ArrowDown}{Enter}");
    expect(customer).toHaveValue("Müller, Anna");
  });

  it("aktualisiert die einmal geladene Vorschlagsquelle nach allen Fahrzeug-Lebenszyklusaktionen und Restore", async () => {
    const user = userEvent.setup();
    const { backend } = await renderReady();
    const suggestionCalls = () =>
      backend.calls.filter((call) => call === "list_customer_suggestions").length;
    expect(suggestionCalls()).toBe(1);

    await user.click(screen.getByRole("button", { name: "+ Fahrzeug" }));
    const draftRow = (document.activeElement as HTMLInputElement).closest("tr")!;
    await user.type(within(draftRow).getByPlaceholderText("Kunde"), "Neukunde{Enter}");
    await user.type(within(draftRow).getByPlaceholderText("Fahrzeug"), "Corsa{Enter}");
    await user.type(within(draftRow).getByPlaceholderText("Kennzeichen"), "M-N 9");
    await user.click(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }));
    await waitFor(() => expect(suggestionCalls()).toBe(2));

    const name = await screen.findByDisplayValue("Neukunde");
    await user.clear(name);
    await user.type(name, "Neukunde Neu");
    await user.tab();
    await waitFor(() => expect(suggestionCalls()).toBe(3));

    await user.click(screen.getByRole("button", { name: "Fertig (M-N 9)" }));
    await waitFor(() => expect(suggestionCalls()).toBe(4));
    await user.click(screen.getByRole("button", { name: "M-N 9 archivieren" }));
    await waitFor(() => expect(suggestionCalls()).toBe(5));
    await user.click(await screen.findByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(suggestionCalls()).toBe(6));

    await user.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await user.click(screen.getByRole("menuitem", { name: "Backup" }));
    await screen.findByText("Backup erstellt");
    await user.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    await user.click(screen.getByRole("menuitem", { name: "Wiederherstellen" }));
    await user.click(await screen.findByRole("button", { name: "Jetzt wiederherstellen" }));
    await waitFor(() => expect(suggestionCalls()).toBe(7));
  });
});
