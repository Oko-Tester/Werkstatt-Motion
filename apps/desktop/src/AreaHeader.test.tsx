import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { AREAS } from "./areas";
import type { Area } from "./areas";
import { HeaderActions } from "./state/headerSlots";
import { installFakeBackend } from "./test/fakeBackend";

afterEach(() => {
  clearMocks();
});

async function renderApp(areas?: readonly Area[]) {
  installFakeBackend({
    vehicles: [{ customerName: "Müller, Anna", vehicleName: "VW Golf", licensePlate: "M-AB 1" }],
  });
  render(<App areas={areas} />);
  await screen.findByDisplayValue("Müller, Anna");
  return {
    nav: screen.getByRole("navigation", { name: "Bereiche" }),
    header: screen.getByRole("banner"),
  };
}

describe("Kopfzeile pro Bereich", () => {
  it("füllt die Kopfzeile in jedem Bereich mit dessen eigenen Teilen", async () => {
    const user = userEvent.setup();
    const { nav, header } = await renderApp();

    // Fahrzeuge: Suche und „+ Fahrzeug“.
    expect(
      within(header).getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }),
    ).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "+ Fahrzeug" })).toBeInTheDocument();

    // Kalender: Titel, Monat und Navigation stehen oben, nicht in einer eigenen Karte.
    await user.click(within(nav).getByRole("button", { name: "Kalender" }));
    const calendar = await screen.findByRole("region", { name: "Kalenderübersicht" });
    expect(within(header).getByRole("heading", { name: "Terminkalender" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Vorheriger Monat" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Nächster Monat" })).toBeInTheDocument();
    expect(
      within(calendar).queryByRole("heading", { name: "Terminkalender" }),
    ).not.toBeInTheDocument();
    expect(
      within(header).queryByRole("searchbox", { name: "Fahrzeuge durchsuchen" }),
    ).not.toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "+ Fahrzeug" })).not.toBeInTheDocument();
    // Die gemeinsamen Aktionen (Backup, Updates) bleiben in jedem Bereich.
    expect(within(header).getByRole("button", { name: "Weitere Aktionen" })).toBeInTheDocument();

    // Historie: Titel und eigene Suche.
    await user.click(within(nav).getByRole("button", { name: "Historie" }));
    const history = await screen.findByRole("region", { name: "Historienarbeitsansicht" });
    expect(within(header).getByRole("heading", { name: "Historie" })).toBeInTheDocument();
    expect(
      within(header).getByRole("searchbox", { name: "Historie durchsuchen" }),
    ).toBeInTheDocument();
    expect(within(history).queryByRole("heading", { name: "Historie" })).not.toBeInTheDocument();
    expect(
      within(header).queryByRole("heading", { name: "Terminkalender" }),
    ).not.toBeInTheDocument();

    // Einstellungen: nur der Titel.
    await user.click(within(nav).getByRole("button", { name: "Einstellungen" }));
    await screen.findByRole("region", { name: "Einstellungen" });
    expect(within(header).getByRole("heading", { name: "Einstellungen" })).toBeInTheDocument();
    expect(within(header).queryByRole("searchbox")).not.toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));
    expect(
      await within(header).findByRole("searchbox", { name: "Fahrzeuge durchsuchen" }),
    ).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "+ Fahrzeug" })).toBeInTheDocument();
  });

  it("behält den Suchtext der Fahrzeuge beim Bereichswechsel", async () => {
    const user = userEvent.setup();
    const { nav, header } = await renderApp();
    await user.type(within(header).getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }), "golf");

    await user.click(within(nav).getByRole("button", { name: "Kalender" }));
    await screen.findByRole("region", { name: "Kalenderübersicht" });
    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));

    expect(
      await within(header).findByRole("searchbox", { name: "Fahrzeuge durchsuchen" }),
    ).toHaveValue("golf");
  });

  it("zeigt die Kopfzeilen-Teile eines neuen Bereichs nur dort", async () => {
    const user = userEvent.setup();
    const areas: readonly Area[] = [
      ...AREAS,
      {
        id: "customers",
        label: "Kunden",
        icon: <span aria-hidden="true" />,
        Page: () => (
          <>
            <HeaderActions>
              <button type="button">Neuer Kunde</button>
            </HeaderActions>
            <p>Kundenseite</p>
          </>
        ),
      },
    ];
    const { nav, header } = await renderApp(areas);
    expect(within(header).queryByRole("button", { name: "Neuer Kunde" })).not.toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Kunden" }));
    expect(screen.getByText("Kundenseite")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Neuer Kunde" })).toBeInTheDocument();
    expect(within(header).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "+ Fahrzeug" })).not.toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));
    expect(within(header).queryByRole("button", { name: "Neuer Kunde" })).not.toBeInTheDocument();
  });

  it("fokussiert mit Strg+F die Suche des aktiven Bereichs", async () => {
    const user = userEvent.setup();
    const { nav } = await renderApp();

    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    expect(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" })).toHaveFocus();

    await user.click(within(nav).getByRole("button", { name: "Historie" }));
    await screen.findByRole("region", { name: "Historienarbeitsansicht" });
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    expect(screen.getByRole("searchbox", { name: "Historie durchsuchen" })).toHaveFocus();
  });
});
