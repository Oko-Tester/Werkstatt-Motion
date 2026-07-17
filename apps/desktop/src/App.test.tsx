import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("zeigt Kopfzeile mit Titel, Suche und Hauptaktionen", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Werkstatt Manager" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Fahrzeug" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backup" })).toBeInTheDocument();
  });

  it("zeigt die Mock-Fahrzeuge in der Tabelle", () => {
    render(<App />);
    expect(screen.getByDisplayValue("Müller, Anna")).toBeInTheDocument();
    expect(screen.getByDisplayValue("M-AB 1234")).toBeInTheDocument();
    // 6 Fahrzeuge + Kopfzeile
    expect(screen.getAllByRole("row")).toHaveLength(7);
  });

  it("filtert Fahrzeuge über das Suchfeld", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox", { name: "Fahrzeuge durchsuchen" }), "golf");
    expect(screen.getByDisplayValue("Müller, Anna")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Yilmaz, Emre")).not.toBeInTheDocument();
  });

  it("schaltet einen Status mit einem Klick um", async () => {
    const user = userEvent.setup();
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Fertig (M-AB 1234)" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("archiviert ein Fahrzeug und stellt es über Rückgängig wieder her", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "M-AB 1234 archivieren" }));
    expect(screen.queryByDisplayValue("Müller, Anna")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rückgängig" }));
    expect(screen.getByDisplayValue("Müller, Anna")).toBeInTheDocument();
  });

  it("legt ein neues Fahrzeug an und fokussiert das erste Feld", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "+ Fahrzeug" }));
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(8);
    const firstDataRow = rows[1];
    expect(within(firstDataRow).getByPlaceholderText("Kunde")).toHaveFocus();
  });

  it("zeigt offene Zahlungen und markiert sie als bezahlt", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole("heading", { name: "Offene Zahlungen" })).toBeInTheDocument();
    expect(screen.getByText(/486,50/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Zahlung von Schneider, Thomas als bezahlt markieren" }),
    );
    expect(screen.queryByText(/486,50/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rückgängig" })).toBeInTheDocument();
  });
});
