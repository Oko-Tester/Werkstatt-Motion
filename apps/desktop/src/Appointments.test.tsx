import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { installFakeBackend } from "./test/fakeBackend";
import type { FakeBackend } from "./test/fakeBackend";

let backend: FakeBackend;

beforeEach(() => {
  // Der Kalender startet in der Woche des Beispieltermins. Dadurch bleiben die
  // Tests unabhängig vom Ausführungsdatum des Rechners.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 9, 10, 0));
  backend = installFakeBackend({
    vehicles: [
      {
        customerName: "Müller, Anna",
        vehicleName: "VW Golf VII",
        licensePlate: "M-AB 1234",
        appointmentAt: "2026-08-12T08:30",
      },
      {
        customerName: "Yilmaz, Emre",
        vehicleName: "BMW 320d",
        licensePlate: "M-EY 482",
      },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

async function renderApp() {
  render(<App />);
  await screen.findByDisplayValue("Müller, Anna");
}

function getVehicleRow(customerName: string): HTMLTableRowElement {
  const row = screen.getByDisplayValue(customerName).closest("tr");
  if (!(row instanceof HTMLTableRowElement)) {
    throw new Error(`Fahrzeugzeile für ${customerName} fehlt`);
  }
  return row;
}

async function enterAppointment(customerName: string, date: string, time: string) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const [year, month, day] = date.split("-");
  await user.click(
    within(getVehicleRow(customerName)).getByRole("button", {
      name: `Termin für ${customerName}`,
    }),
  );
  fireEvent.change(screen.getByLabelText("Datum"), {
    target: { value: `${day}.${month}.${year}` },
  });
  fireEvent.change(screen.getByLabelText("Uhrzeit"), { target: { value: time } });
  await user.click(screen.getByRole("button", { name: "Termin speichern" }));
}

describe("Fahrzeugtermine", () => {
  it("zeigt einen vorhandenen Termin mit automatisch ermitteltem Wochentag weit links in der Fahrzeugzeile", async () => {
    await renderApp();

    const row = getVehicleRow("Müller, Anna");
    const appointment = within(row).getByRole("button", { name: "Termin für Müller, Anna" });
    expect(appointment).toHaveTextContent("Mi 12.08. · 08:30");

    const cells = within(row).getAllByRole("cell");
    expect(cells.indexOf(appointment.closest("td")!)).toBeLessThan(
      cells.indexOf(screen.getByDisplayValue("Müller, Anna").closest("td")!),
    );
  });

  it("öffnet die Terminauswahl und speichert Datum und Uhrzeit automatisch", async () => {
    await renderApp();

    await enterAppointment("Yilmaz, Emre", "2026-08-13", "10:15");

    await waitFor(() => expect(backend.vehicles[1].appointmentAt).toBe("2026-08-13T10:15"));
    expect(backend.callPayloads).toContainEqual({
      cmd: "update_vehicle_appointment",
      payload: { id: backend.vehicles[1].id, appointmentAt: "2026-08-13T10:15" },
    });
    expect(
      within(getVehicleRow("Yilmaz, Emre")).getByRole("button", {
        name: "Termin für Yilmaz, Emre",
      }),
    ).toHaveTextContent("Do 13.08. · 10:15");
  });

  it("entfernt einen bestehenden Termin", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp();

    await user.click(
      within(getVehicleRow("Müller, Anna")).getByRole("button", {
        name: "Termin für Müller, Anna",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Termin entfernen" }));

    await waitFor(() => expect(backend.vehicles[0].appointmentAt).toBeNull());
    expect(backend.callPayloads).toContainEqual({
      cmd: "update_vehicle_appointment",
      payload: { id: backend.vehicles[0].id, appointmentAt: null },
    });
    expect(
      within(getVehicleRow("Müller, Anna")).getByRole("button", {
        name: "Termin für Müller, Anna",
      }),
    ).not.toHaveTextContent("08:30");
  });

  it("interpretiert das Datum immer deutsch und nicht als US-Monat/Tag", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp();

    await user.click(
      within(getVehicleRow("Yilmaz, Emre")).getByRole("button", {
        name: "Termin für Yilmaz, Emre",
      }),
    );
    const dateInput = screen.getByLabelText("Datum");
    fireEvent.change(dateInput, { target: { value: "09/11/2026" } });
    fireEvent.blur(dateInput);
    expect(dateInput).toHaveValue("09.11.2026");
    fireEvent.change(screen.getByLabelText("Uhrzeit"), { target: { value: "08:00" } });
    await user.click(screen.getByRole("button", { name: "Termin speichern" }));

    await waitFor(() => expect(backend.vehicles[1].appointmentAt).toBe("2026-11-09T08:00"));
    expect(
      within(getVehicleRow("Yilmaz, Emre")).getByRole("button", {
        name: "Termin für Yilmaz, Emre",
      }),
    ).toHaveTextContent("Mo 09.11. · 08:00");
  });

  it("wählt ein Datum im deutsch beschrifteten Kalender aus", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp();

    await user.click(
      within(getVehicleRow("Yilmaz, Emre")).getByRole("button", {
        name: "Termin für Yilmaz, Emre",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Kalender zur Datumsauswahl öffnen" }),
    );
    expect(screen.getByRole("dialog", { name: "August 2026" })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Donnerstag, 13. August 2026" }),
    );
    expect(screen.getByLabelText("Datum")).toHaveValue("13.08.2026");
    fireEvent.change(screen.getByLabelText("Uhrzeit"), { target: { value: "08:00" } });
    await user.click(screen.getByRole("button", { name: "Termin speichern" }));

    await waitFor(() => expect(backend.vehicles[1].appointmentAt).toBe("2026-08-13T08:00"));
  });

  it("speichert und zeigt einen Termin ohne Uhrzeit", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp();

    await user.click(
      within(getVehicleRow("Yilmaz, Emre")).getByRole("button", {
        name: "Termin für Yilmaz, Emre",
      }),
    );
    expect(screen.getByLabelText("Uhrzeit")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Datum"), { target: { value: "14.08.2026" } });
    await user.click(screen.getByRole("button", { name: "Termin speichern" }));

    await waitFor(() => expect(backend.vehicles[1].appointmentAt).toBe("2026-08-14"));
    expect(backend.callPayloads).toContainEqual({
      cmd: "update_vehicle_appointment",
      payload: { id: backend.vehicles[1].id, appointmentAt: "2026-08-14" },
    });
    const appointment = within(getVehicleRow("Yilmaz, Emre")).getByRole("button", {
      name: "Termin für Yilmaz, Emre",
    });
    expect(appointment).toHaveTextContent(/^Fr 14\.08\.$/);
    expect(appointment).not.toHaveTextContent("·");

    await user.click(screen.getByRole("button", { name: "Kalender" }));
    expect(await screen.findByRole("heading", { name: "Terminkalender" })).toBeInTheDocument();
    expect(screen.getByText("Ohne Uhrzeit")).toBeInTheDocument();
    expect(screen.getByText("Yilmaz, Emre")).toBeInTheDocument();
  });
});

describe("Terminkalender als zweite Ansicht derselben Fahrzeugtermine", () => {
  it("zeigt Uhrzeit, Kunde, Fahrzeug und Kennzeichen eines Fahrzeugtermins", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp();

    const calendarButton = screen.getByRole("button", { name: "Kalender" });
    expect(calendarButton).not.toHaveAttribute("aria-current");
    await user.click(calendarButton);
    expect(calendarButton).toHaveAttribute("aria-current", "page");
    expect(calendarButton).toHaveClass("is-active");

    expect(await screen.findByRole("heading", { name: "Terminkalender" })).toBeInTheDocument();
    expect(screen.getByText("08:30")).toBeInTheDocument();
    expect(screen.getByText("Müller, Anna")).toBeInTheDocument();
    expect(screen.getByText("VW Golf VII")).toBeInTheDocument();
    expect(screen.getByText("M-AB 1234")).toBeInTheDocument();
  });

  it("spiegelt eine Änderung aus der Fahrzeugzeile direkt im Kalender", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderApp();
    const initialVehicleLoads = backend.calls.filter((call) => call === "list_vehicles").length;

    await enterAppointment("Müller, Anna", "2026-08-13", "10:15");
    await waitFor(() => expect(backend.vehicles[0].appointmentAt).toBe("2026-08-13T10:15"));
    await user.click(screen.getByRole("button", { name: "Kalender" }));

    expect(await screen.findByRole("heading", { name: "Terminkalender" })).toBeInTheDocument();
    expect(screen.getByText("10:15")).toBeInTheDocument();
    expect(screen.queryByText("08:30")).not.toBeInTheDocument();
    expect(backend.calls.filter((call) => call === "list_vehicles")).toHaveLength(
      initialVehicleLoads,
    );
  });
});
