import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { AREAS } from "../areas";
import type { Area } from "../areas";
import { installFakeBackend } from "../test/fakeBackend";
import { NavRail } from "./NavRail";

afterEach(() => {
  clearMocks();
});

describe("NavRail", () => {
  it("baut die Einträge in Listenreihenfolge aus der Bereichsliste", () => {
    render(
      <NavRail
        areas={AREAS}
        activeAreaId="vehicles"
        onSelectArea={vi.fn()}
        onOpenHiddenArea={vi.fn()}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Bereiche" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual(
      AREAS.map((area) => area.label),
    );
  });

  it("markiert genau den aktiven Bereich und meldet Klicks mit der Kennung", async () => {
    const user = userEvent.setup();
    const onSelectArea = vi.fn();
    render(
      <NavRail
        areas={AREAS}
        activeAreaId="calendar"
        onSelectArea={onSelectArea}
        onOpenHiddenArea={vi.fn()}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Bereiche" });
    expect(within(nav).getByRole("button", { name: "Kalender" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("button", { name: "Fahrzeuge" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(within(nav).getByRole("button", { name: "Historie" })).not.toHaveAttribute(
      "aria-current",
    );

    await user.click(within(nav).getByRole("button", { name: "Historie" }));
    expect(onSelectArea).toHaveBeenCalledWith("history");
  });

  it("stellt Bereiche mit placement bottom ans Ende der Leiste", () => {
    const areas: readonly Area[] = [
      {
        id: "settings",
        label: "Einstellungen",
        icon: <span aria-hidden="true" />,
        Page: () => null,
        placement: "bottom",
      },
      { id: "alpha", label: "Alpha", icon: <span aria-hidden="true" />, Page: () => null },
    ];
    render(
      <NavRail
        areas={areas}
        activeAreaId="alpha"
        onSelectArea={vi.fn()}
        onOpenHiddenArea={vi.fn()}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Bereiche" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Alpha",
      "Einstellungen",
    ]);
  });
});

describe("Bereichswechsel in der App", () => {
  const seed = {
    vehicles: [{ customerName: "Müller, Anna", vehicleName: "VW Golf", licensePlate: "M-AB 1" }],
  };

  it("wechselt über die Leiste direkt zwischen Fahrzeugen, Kalender und Historie", async () => {
    installFakeBackend(seed);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByDisplayValue("Müller, Anna");
    const nav = screen.getByRole("navigation", { name: "Bereiche" });

    expect(within(nav).getByRole("button", { name: "Fahrzeuge" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(within(nav).getByRole("button", { name: "Kalender" }));
    expect(await screen.findByRole("region", { name: "Kalenderübersicht" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Fahrzeuge" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Kalender" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Direkt von einem Bereich in den nächsten, ohne Umweg über die Fahrzeuge.
    await user.click(within(nav).getByRole("button", { name: "Historie" }));
    expect(
      await screen.findByRole("region", { name: "Historienarbeitsansicht" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Kalenderübersicht" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Historie" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));
    expect(await screen.findByRole("region", { name: "Fahrzeuge" })).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Historienarbeitsansicht" }),
    ).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Fahrzeuge" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("zeigt einen neuen Eintrag der Bereichsliste samt Seite, ohne dass App davon weiß", async () => {
    installFakeBackend(seed);
    const user = userEvent.setup();
    const areas: readonly Area[] = [
      ...AREAS,
      {
        id: "customers",
        label: "Kunden",
        icon: <span aria-hidden="true">K</span>,
        Page: () => <p>Kundenseite</p>,
      },
    ];
    render(<App areas={areas} />);
    await screen.findByDisplayValue("Müller, Anna");
    const nav = screen.getByRole("navigation", { name: "Bereiche" });

    await user.click(within(nav).getByRole("button", { name: "Kunden" }));
    expect(screen.getByText("Kundenseite")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Fahrzeuge" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Kunden" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("behält eine angefangene neue Fahrzeugzeile beim Bereichswechsel", async () => {
    installFakeBackend(seed);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByDisplayValue("Müller, Anna");
    const nav = screen.getByRole("navigation", { name: "Bereiche" });

    await user.click(screen.getByRole("button", { name: "+ Fahrzeug" }));
    await user.keyboard("Nur Kunde");
    await user.click(within(nav).getByRole("button", { name: "Kalender" }));
    expect(await screen.findByRole("region", { name: "Kalenderübersicht" })).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));
    expect(await screen.findByDisplayValue("Nur Kunde")).toBeInTheDocument();
  });

  it("speichert eine angefangene Änderung, wenn man mitten im Feld den Bereich wechselt", async () => {
    const backend = installFakeBackend(seed);
    const user = userEvent.setup();
    render(<App />);
    const customerField = await screen.findByDisplayValue("Müller, Anna");
    const nav = screen.getByRole("navigation", { name: "Bereiche" });

    await user.clear(customerField);
    await user.type(customerField, "Meier, Berta");
    await user.click(within(nav).getByRole("button", { name: "Kalender" }));
    expect(await screen.findByRole("region", { name: "Kalenderübersicht" })).toBeInTheDocument();

    await waitFor(() => expect(backend.vehicles[0].customerName).toBe("Meier, Berta"));
    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));
    expect(await screen.findByDisplayValue("Meier, Berta")).toBeInTheDocument();
  });
});
