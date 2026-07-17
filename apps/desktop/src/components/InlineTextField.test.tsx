import { render, screen } from "@testing-library/react";
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
});
