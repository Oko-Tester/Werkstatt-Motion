const euroFormat = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

/** Formatiert Cent als Eurobetrag, z. B. 48650 → "486,50 €". */
export function formatCents(cents: number): string {
  return euroFormat.format(cents / 100);
}

/** Cent als editierbarer Text ohne Währungszeichen, z. B. 48650 → "486,50". */
export function centsToEditable(cents: number | null): string {
  if (cents === null) {
    return "";
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const euros = Math.trunc(absolute / 100);
  const rest = absolute % 100;
  return `${sign}${euros},${String(rest).padStart(2, "0")}`;
}

/**
 * Parst deutsche Betragseingaben in Cent, ohne Gleitkommarechnung:
 * "12" → 1200, "486,50" → 48650, "1.234,56" → 123456, "1.234" → 123400.
 * Ungültige Eingaben ergeben null. Leere Eingaben sind Sache des Aufrufers.
 */
export function parseEuroInput(raw: string): number | null {
  let text = raw.replace(/€/g, "").replace(/\s+/g, "");
  if (text === "") {
    return null;
  }
  if (text.includes(",")) {
    // Punkt = Tausendertrennzeichen, Komma = Dezimaltrennzeichen.
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    // Nur Punkte in Dreiergruppen: als Tausendertrennzeichen lesen.
    text = text.replace(/\./g, "");
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) {
    return null;
  }
  const euros = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0") || "0");
  const total = euros * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}
