import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InfoTip } from "./InfoTip";

function renderTip() {
  render(
    <div>
      <InfoTip label="Zweiter Speicherort">Eine zweite Kopie schützt dich.</InfoTip>
      <button type="button">Daneben</button>
    </div>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Info: Zweiter Speicherort" });
  return { user, trigger };
}

describe("InfoTip", () => {
  it("zeigt die Erklärung erst, wenn man darüberfährt, und blendet sie danach aus", async () => {
    const { user, trigger } = renderTip();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.hover(trigger);
    const bubble = screen.getByRole("tooltip");
    expect(bubble).toHaveTextContent("Eine zweite Kopie schützt dich.");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-describedby", bubble.id);

    await user.unhover(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("hält die Erklärung nach einem Klick offen und schließt sie mit einem zweiten Klick", async () => {
    const { user, trigger } = renderTip();

    await user.hover(trigger);
    await user.click(trigger);
    await user.unhover(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("schließt mit Esc und mit einem Klick daneben", async () => {
    const { user, trigger } = renderTip();

    await user.click(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Daneben" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("ist per Tastatur bedienbar und schließt beim Weitergehen mit Tab", async () => {
    const { user, trigger } = renderTip();

    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Eine zweite Kopie schützt dich.");

    await user.tab();
    expect(screen.getByRole("button", { name: "Daneben" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("bleibt offen, wenn man in die Erklärung klickt, um Text zu markieren", async () => {
    const { user, trigger } = renderTip();

    await user.click(trigger);
    await user.click(screen.getByRole("tooltip"));

    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });
});
