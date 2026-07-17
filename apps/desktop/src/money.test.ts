import { describe, expect, it } from "vitest";
import { centsToEditable, formatCents, parseEuroInput } from "./money";

describe("parseEuroInput", () => {
  it("parst ganze Eurobeträge", () => {
    expect(parseEuroInput("12")).toBe(1200);
    expect(parseEuroInput("0")).toBe(0);
    expect(parseEuroInput("1240")).toBe(124000);
  });

  it("parst deutsche Dezimalschreibweise", () => {
    expect(parseEuroInput("486,50")).toBe(48650);
    expect(parseEuroInput("12,5")).toBe(1250);
    expect(parseEuroInput("0,09")).toBe(9);
  });

  it("parst Tausendertrennzeichen", () => {
    expect(parseEuroInput("1.234,56")).toBe(123456);
    expect(parseEuroInput("1.234")).toBe(123400);
    expect(parseEuroInput("12.345.678,90")).toBe(1234567890);
  });

  it("ignoriert Eurozeichen und Leerzeichen", () => {
    expect(parseEuroInput(" 486,50 € ")).toBe(48650);
  });

  it("akzeptiert Punkt als Dezimaltrennzeichen ohne Komma", () => {
    expect(parseEuroInput("486.50")).toBe(48650);
    expect(parseEuroInput("12.5")).toBe(1250);
  });

  it("lehnt ungültige Eingaben ab", () => {
    expect(parseEuroInput("")).toBeNull();
    expect(parseEuroInput("abc")).toBeNull();
    expect(parseEuroInput("12,345")).toBeNull();
    expect(parseEuroInput("1,2,3")).toBeNull();
    expect(parseEuroInput("-5")).toBeNull();
  });
});

describe("formatCents", () => {
  it("formatiert Cent als Euro", () => {
    expect(formatCents(48650)).toMatch(/486,50/);
    expect(formatCents(0)).toMatch(/0,00/);
    expect(formatCents(123456)).toMatch(/1\.234,56/);
  });
});

describe("centsToEditable", () => {
  it("liefert editierbaren Text ohne Währungszeichen", () => {
    expect(centsToEditable(48650)).toBe("486,50");
    expect(centsToEditable(9)).toBe("0,09");
    expect(centsToEditable(123456)).toBe("1234,56");
    expect(centsToEditable(null)).toBe("");
  });
});
