import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { AREAS } from "./areas";
import type { Area } from "./areas";
import { installFakeBackend } from "./test/fakeBackend";
import { VEHICLE_COLUMN_IDS } from "./types";

afterEach(() => {
  clearMocks();
});

async function openSettings(areas?: readonly Area[]) {
  const backend = installFakeBackend({
    vehicles: [{ customerName: "Müller, Anna", vehicleName: "VW Golf", licensePlate: "M-AB 1" }],
  });
  const user = userEvent.setup();
  render(<App areas={areas} />);
  await screen.findByDisplayValue("Müller, Anna");
  const nav = screen.getByRole("navigation", { name: "Bereiche" });
  await user.click(within(nav).getByRole("button", { name: "Einstellungen" }));
  const settings = await screen.findByRole("region", { name: "Einstellungen" });
  const list = within(settings).getByRole("list", { name: "Einstellungsgruppen" });
  return { backend, user, nav, settings, list };
}

describe("Einstellungen", () => {
  it("führt jeden Bereich einzeln auf, dazu die Datensicherung, nur nicht die Einstellungen selbst", async () => {
    const { list } = await openSettings();

    expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Fahrzeuge",
      "Kalender",
      "Historie",
      "Datensicherung",
    ]);
    expect(within(list).getByRole("button", { name: "Fahrzeuge" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(list).getByRole("button", { name: "Kalender" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("zeigt für Bereiche ohne Einstellungen einen Hinweis und wechselt die Auswahl", async () => {
    const { user, list } = await openSettings();

    await user.click(within(list).getByRole("button", { name: "Kalender" }));

    const detail = screen.getByRole("region", { name: "Einstellungen für Kalender" });
    expect(
      within(detail).getByText("Für diesen Bereich gibt es noch keine Einstellungen."),
    ).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "Kalender" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(list).getByRole("button", { name: "Fahrzeuge" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("nimmt einen neuen Bereich samt seinen Einstellungen von selbst auf", async () => {
    const customers: Area = {
      id: "customers",
      label: "Kunden",
      icon: <span aria-hidden="true" />,
      Page: () => <p>Kundenseite</p>,
      Settings: () => <p>Kundenoptionen</p>,
    };
    const { user, list } = await openSettings([...AREAS, customers]);

    expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Fahrzeuge",
      "Kalender",
      "Historie",
      "Kunden",
      "Datensicherung",
    ]);
    await user.click(within(list).getByRole("button", { name: "Kunden" }));

    const detail = screen.getByRole("region", { name: "Einstellungen für Kunden" });
    expect(within(detail).getByText("Kundenoptionen")).toBeInTheDocument();
  });
});

describe("Einstellungen: Fahrzeuge", () => {
  it("zeigt alle Spalten der Fahrzeugliste in ihrer Reihenfolge, alle sichtbar", async () => {
    const { settings } = await openSettings();

    const group = within(settings).getByRole("group", { name: "Sichtbare Spalten" });
    const boxes = within(group).getAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual([
      "Termin",
      "Kunde",
      "Fahrzeug",
      "Kennzeichen",
      "TÜV nötig",
      "Teile bestellen",
      "Teile angekommen",
      "Fertig",
      "Notiz",
    ]);
    boxes.forEach((box) => expect(box).toBeChecked());
  });

  it("blendet eine Spalte aus und wieder ein, und die Fahrzeugliste folgt", async () => {
    const { backend, user, nav } = await openSettings();

    await user.click(screen.getByRole("checkbox", { name: "Kennzeichen" }));
    expect(screen.getByRole("checkbox", { name: "Kennzeichen" })).not.toBeChecked();
    await waitFor(() =>
      expect(backend.preferences.vehicleHiddenColumns).toEqual(["licensePlate"]),
    );

    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));
    expect(await screen.findByDisplayValue("Müller, Anna")).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: /Kennzeichen, Spalte verschieben/ }),
    ).not.toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Einstellungen" }));
    await user.click(await screen.findByRole("checkbox", { name: "Kennzeichen" }));
    await waitFor(() => expect(backend.preferences.vehicleHiddenColumns).toEqual([]));

    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));
    expect(
      await screen.findByRole("columnheader", { name: /Kennzeichen, Spalte verschieben/ }),
    ).toBeInTheDocument();
  });

  it("lässt die letzte sichtbare Spalte stehen", async () => {
    const { user } = await openSettings();

    for (const label of [
      "Termin",
      "Kunde",
      "Fahrzeug",
      "Kennzeichen",
      "TÜV nötig",
      "Teile bestellen",
      "Teile angekommen",
      "Fertig",
    ]) {
      await user.click(screen.getByRole("checkbox", { name: label }));
    }

    const last = screen.getByRole("checkbox", { name: "Notiz" });
    expect(last).toBeChecked();
    expect(last).toBeDisabled();
  });

  it("setzt die geänderte Reihenfolge der Spalten zurück", async () => {
    const { backend, user, nav } = await openSettings();
    expect(screen.getByRole("button", { name: "Reihenfolge zurücksetzen" })).toBeDisabled();

    await user.click(within(nav).getByRole("button", { name: "Fahrzeuge" }));
    const handle = await screen.findByRole("button", { name: "Kunde, Spalte verschieben" });
    fireEvent.keyDown(handle, { key: "ArrowRight", altKey: true });
    await waitFor(() =>
      expect(backend.preferences.vehicleColumnOrder.slice(0, 3)).toEqual([
        "appointmentAt",
        "vehicleName",
        "customerName",
      ]),
    );

    await user.click(within(nav).getByRole("button", { name: "Einstellungen" }));
    const reset = await screen.findByRole("button", { name: "Reihenfolge zurücksetzen" });
    expect(reset).toBeEnabled();
    await user.click(reset);

    await waitFor(() =>
      expect(backend.preferences.vehicleColumnOrder).toEqual([...VEHICLE_COLUMN_IDS]),
    );
    expect(reset).toBeDisabled();
  });
});
