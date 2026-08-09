import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineTextField } from "./InlineTextField";

describe("InlineTextField", () => {
  it("übernimmt Änderungen mit Enter", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineTextField value="Alt" label="Kunde" onCommit={onCommit} />);
    const input = screen.getByRole("textbox", { name: "Kunde" });
    await user.clear(input);
    await user.type(input, "Neu{Enter}");
    expect(onCommit).toHaveBeenCalledWith("Neu");
  });

  it("verwirft Änderungen mit Escape", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineTextField value="Alt" label="Kunde" onCommit={onCommit} />);
    const input = screen.getByRole("textbox", { name: "Kunde" });
    await user.type(input, "xyz");
    expect(input).toHaveValue("Altxyz");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("Alt");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("speichert automatisch beim Verlassen des Feldes", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineTextField value="Alt" label="Kunde" onCommit={onCommit} />);
    const input = screen.getByRole("textbox", { name: "Kunde" });
    await user.type(input, "us");
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith("Altus");
  });

  it("zeigt Fehler direkt am Feld an", () => {
    render(
      <InlineTextField value="" label="Kunde" onCommit={() => undefined} error="Kunde angeben" />,
    );
    const input = screen.getByRole("textbox", { name: "Kunde" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Kunde angeben");
  });

  it("behält die Hover-Vorschau und bearbeitet gefüllten Text in der großen Fläche", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <InlineTextField
        value="Erste Zeile"
        label="Notiz (M-AB 1)"
        onCommit={onCommit}
        previewOnHover
        editInPreview
      />,
    );
    const input = screen.getByRole("textbox", { name: "Notiz (M-AB 1)" });

    fireEvent.mouseEnter(input);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Erste Zeile");
    fireEvent.mouseLeave(input);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.click(input);
    const dialog = screen.getByRole("dialog", { name: "Notiz bearbeiten" });
    const editor = within(dialog).getByRole("textbox", {
      name: "Notiz (M-AB 1) groß bearbeiten",
    });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue("Erste Zeile");
    await user.type(editor, "{Enter}Zweite Zeile");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(onCommit).toHaveBeenCalledWith("Erste Zeile\nZweite Zeile");
    expect(screen.queryByRole("dialog", { name: "Notiz bearbeiten" })).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("verwirft Änderungen im großen Editor mit Escape", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <InlineTextField
        value="Bestehend"
        label="Notiz"
        onCommit={onCommit}
        previewOnHover
        editInPreview
      />,
    );

    await user.click(screen.getByRole("textbox", { name: "Notiz" }));
    const editor = screen.getByRole("textbox", { name: "Notiz groß bearbeiten" });
    await user.type(editor, " geändert");
    await user.keyboard("{Escape}");

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Notiz bearbeiten" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Notiz" })).toHaveValue("Bestehend");
  });
});
