import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { installFakeBackend } from "./test/fakeBackend";
import type { FakeBackend } from "./test/fakeBackend";

let backend: FakeBackend;

beforeEach(() => {
  backend = installFakeBackend({
    vehicles: [
      {
        customerName: "Müller, Anna",
        vehicleName: "VW Golf VII",
        licensePlate: "M-AB 1234",
        tuvRequired: true,
        partsOrdered: true,
      },
      { customerName: "Yilmaz, Emre", vehicleName: "BMW 320d", licensePlate: "M-EY 482" },
      { customerName: "Schneider, Thomas", vehicleName: "Audi A4", licensePlate: "EBE-TS 77" },
    ],
    payments: [
      { customerName: "Schneider, Thomas", amountCents: 48650, note: "Bremsen" },
      { customerName: "Lang, Sabine", amountCents: 12990 },
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

describe("App: Laden und Suche", () => {
  it("lädt Fahrzeuge und Zahlungen aus der Datenbank", async () => {
    await renderApp();
    expect(screen.getByDisplayValue("M-AB 1234")).toBeInTheDocument();
    // Fahrzeugzeile und Zahlungszeile zeigen denselben Kunden.
    expect(screen.getAllByDisplayValue("Schneider, Thomas")).toHaveLength(2);
    // Kopfzeile + 3 Fahrzeuge
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText(/616,40/)).toBeInTheDocument();
    expect(backend.calls).toContain("list_vehicles");
    expect(backend.calls).toContain("list_open_payments");
  });

  it("filtert Fahrzeuge sofort über das Suchfeld", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.type(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }), "golf");
    expect(screen.getByDisplayValue("Müller, Anna")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Yilmaz, Emre")).not.toBeInTheDocument();
  });

  it("fokussiert die interne Suche mit Strg+F", async () => {
    await renderApp();
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    expect(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" })).toHaveFocus();
  });
});

describe("App: Fahrzeug anlegen", () => {
  it("legt über eine bearbeitbare Zeile ein Fahrzeug in der Datenbank an", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "+ Fahrzeug" }));

    const draftRow = screen.getAllByRole("row")[1];
    expect(within(draftRow).getByPlaceholderText("Kunde")).toHaveFocus();

    // Enter führt durch die Felder, gespeichert wird beim Verlassen der Zeile.
    await user.keyboard("Neu, Kunde{Enter}");
    expect(within(draftRow).getByPlaceholderText("Fahrzeug")).toHaveFocus();
    await user.keyboard("Opel Corsa{Enter}");
    await user.keyboard("m ab 99");
    await user.click(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }));

    await waitFor(() => expect(backend.calls).toContain("create_vehicle"));
    const created = backend.vehicles.find((entry) => entry.customerName === "Neu, Kunde");
    expect(created).toBeDefined();
    expect(created?.vehicleName).toBe("Opel Corsa");
    // Kennzeichen wird normalisiert gespeichert.
    expect(created?.licensePlate).toBe("M AB 99");
    expect(await screen.findByDisplayValue("M AB 99")).toBeInTheDocument();
    // Neues Fahrzeug steht oben.
    expect(backend.vehicles.every((entry) => created!.position <= entry.position)).toBe(true);
  });

  it("verwirft eine leer verlassene neue Zeile ohne Rückfrage", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "+ Fahrzeug" }));
    expect(screen.getAllByRole("row")).toHaveLength(5);

    await user.click(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(4));
    expect(backend.calls).not.toContain("create_vehicle");
  });

  it("zeigt Pflichtfeld-Hinweise an einer unvollständigen neuen Zeile", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "+ Fahrzeug" }));
    await user.keyboard("Nur Kunde");
    await user.click(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }));

    expect(await screen.findByText("Fahrzeug oder Kennzeichen angeben")).toBeInTheDocument();
    expect(backend.calls).not.toContain("create_vehicle");
    // Die Zeile bleibt erhalten und kann vervollständigt werden.
    expect(screen.getByDisplayValue("Nur Kunde")).toBeInTheDocument();
  });
});

describe("App: Inline-Bearbeitung", () => {
  it("speichert Textänderungen beim Verlassen des Feldes und normalisiert Kennzeichen", async () => {
    const user = userEvent.setup();
    await renderApp();
    const plateField = screen.getByDisplayValue("M-AB 1234");
    await user.clear(plateField);
    await user.type(plateField, "m  neu 77");
    await user.tab();

    await waitFor(() => expect(backend.calls).toContain("update_vehicle"));
    expect(await screen.findByDisplayValue("M NEU 77")).toBeInTheDocument();
    expect(backend.vehicles[0].licensePlate).toBe("M NEU 77");
  });

  it("zeigt Validierungsfehler direkt am Feld und stellt den alten Wert wieder her", async () => {
    const user = userEvent.setup();
    await renderApp();
    const customerField = screen.getByDisplayValue("Müller, Anna");
    await user.clear(customerField);
    await user.tab();

    expect(await screen.findByText("Kunde darf nicht leer sein")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Müller, Anna")).toBeInTheDocument();
    expect(backend.vehicles[0].customerName).toBe("Müller, Anna");
  });

  it("verwirft lokale Änderungen mit Escape ohne zu speichern", async () => {
    const user = userEvent.setup();
    await renderApp();
    const customerField = screen.getByDisplayValue("Müller, Anna");
    await user.type(customerField, "xyz");
    await user.keyboard("{Escape}");
    expect(screen.getByDisplayValue("Müller, Anna")).toBeInTheDocument();
    expect(backend.calls).not.toContain("update_vehicle");
  });
});

describe("App: Status", () => {
  it("ändert einen Status mit einem Klick und ohne Nebenwirkungen", async () => {
    const user = userEvent.setup();
    await renderApp();
    const toggle = screen.getByRole("button", { name: "Fertig (M-AB 1234)" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(backend.vehicles[0].isDone).toBe(true));
    // „Fertig“ überschreibt keine anderen Status.
    expect(backend.vehicles[0].tuvRequired).toBe(true);
    expect(backend.vehicles[0].partsOrdered).toBe(true);
    expect(backend.vehicles[0].partsArrived).toBe(false);
  });

  it("setzt den Status bei einem Speicherfehler zurück", async () => {
    const user = userEvent.setup();
    await renderApp();
    backend.planFailure("update_vehicle_status");
    const toggle = screen.getByRole("button", { name: "Fertig (M-AB 1234)" });
    await user.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByText("Speichern fehlgeschlagen")).toBeInTheDocument();
    expect(backend.vehicles[0].isDone).toBe(false);
  });
});

describe("App: Priorisierung", () => {
  it("speichert die Reihenfolge nach dem Verschieben dauerhaft", async () => {
    const user = userEvent.setup();
    await renderApp();
    const handle = screen.getByRole("button", { name: "Priorität von M-AB 1234 ändern" });
    handle.focus();
    await user.keyboard("{ArrowDown}");

    await waitFor(() => expect(backend.calls).toContain("reorder_vehicles"));
    const order = backend.vehicles
      .filter((entry) => entry.archivedAt === null)
      .sort((a, b) => a.position - b.position)
      .map((entry) => entry.customerName);
    expect(order).toEqual(["Yilmaz, Emre", "Müller, Anna", "Schneider, Thomas"]);
    const firstRow = screen.getAllByRole("row")[1];
    expect(within(firstRow).getByDisplayValue("Yilmaz, Emre")).toBeInTheDocument();
  });

  it("stellt bei einem Speicherfehler die vorherige Reihenfolge wieder her", async () => {
    const user = userEvent.setup();
    await renderApp();
    backend.planFailure("reorder_vehicles");
    const handle = screen.getByRole("button", { name: "Priorität von M-AB 1234 ändern" });
    handle.focus();
    await user.keyboard("{ArrowDown}");

    await waitFor(() => expect(backend.calls).toContain("reorder_vehicles"));
    await waitFor(() => {
      const firstRow = screen.getAllByRole("row")[1];
      expect(within(firstRow).getByDisplayValue("Müller, Anna")).toBeInTheDocument();
    });
    expect(screen.getByText("Speichern fehlgeschlagen")).toBeInTheDocument();
  });
});

describe("App: Archivieren und Undo", () => {
  it("archiviert ohne Rückfrage und stellt über Rückgängig wieder her", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "M-AB 1234 archivieren" }));

    expect(screen.queryByDisplayValue("Müller, Anna")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(backend.vehicles.find((entry) => entry.licensePlate === "M-AB 1234")?.archivedAt)
        .not.toBeNull(),
    );

    await user.click(await screen.findByRole("button", { name: "Rückgängig" }));
    expect(await screen.findByDisplayValue("Müller, Anna")).toBeInTheDocument();
    expect(
      backend.vehicles.find((entry) => entry.licensePlate === "M-AB 1234")?.archivedAt,
    ).toBeNull();
  });
});

describe("App: Offene Zahlungen", () => {
  it("zeigt Beträge als Euro formatiert an", async () => {
    await renderApp();
    expect(screen.getByDisplayValue(/486,50/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/129,90/)).toBeInTheDocument();
  });

  it("legt über eine bearbeitbare Zeile eine Zahlung in Cent an", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "+ Offener Betrag" }));
    expect(screen.getByRole("textbox", { name: "Kunde (Neue Zahlung)" })).toHaveFocus();

    await user.keyboard("Neukunde{Enter}");
    await user.keyboard("1.234,56{Enter}");
    await user.keyboard("Ölwechsel");
    await user.click(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }));

    await waitFor(() => expect(backend.calls).toContain("create_payment"));
    const created = backend.payments.find((entry) => entry.customerName === "Neukunde");
    expect(created?.amountCents).toBe(123456);
    expect(created?.note).toBe("Ölwechsel");
    expect(await screen.findByDisplayValue(/1\.234,56/)).toBeInTheDocument();
  });

  it("verwirft eine leer verlassene Zahlungszeile", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "+ Offener Betrag" }));
    await user.click(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }));

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Kunde (Neue Zahlung)" })).not.toBeInTheDocument(),
    );
    expect(backend.calls).not.toContain("create_payment");
  });

  it("bearbeitet den Betrag direkt und speichert Cent-Werte", async () => {
    const user = userEvent.setup();
    await renderApp();
    const amountField = screen.getByDisplayValue(/486,50/);
    await user.clear(amountField);
    await user.type(amountField, "500");
    await user.tab();

    await waitFor(() => expect(backend.calls).toContain("update_payment"));
    expect(backend.payments[0].amountCents).toBe(50000);
    expect(await screen.findByDisplayValue(/500,00/)).toBeInTheDocument();
  });

  it("lehnt ungültige Beträge mit Fehler am Feld ab, ohne zu speichern", async () => {
    const user = userEvent.setup();
    await renderApp();
    const amountField = screen.getByDisplayValue(/486,50/);
    await user.clear(amountField);
    await user.type(amountField, "abc");
    await user.tab();

    expect(await screen.findByText(/Ungültiger Betrag/)).toBeInTheDocument();
    expect(backend.calls).not.toContain("update_payment");
    expect(backend.payments[0].amountCents).toBe(48650);
  });

  it("markiert Zahlungen mit einem Klick als bezahlt und erlaubt Rückgängig", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(
      screen.getByRole("button", { name: "Zahlung von Schneider, Thomas als bezahlt markieren" }),
    );

    expect(screen.queryByDisplayValue(/486,50/)).not.toBeInTheDocument();
    await waitFor(() => expect(backend.payments[0].paidAt).not.toBeNull());

    await user.click(await screen.findByRole("button", { name: "Rückgängig" }));
    expect(await screen.findByDisplayValue(/486,50/)).toBeInTheDocument();
    expect(backend.payments[0].paidAt).toBeNull();
  });
});
