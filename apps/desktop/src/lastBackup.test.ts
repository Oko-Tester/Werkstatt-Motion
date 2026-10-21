import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLastBackup, isBackupOverdue } from "./lastBackup";

describe("formatLastBackup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 21, 12, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("nennt heute und gestern beim Namen", () => {
    expect(formatLastBackup(new Date(2026, 9, 21, 8, 12).getTime())).toBe("heute 08:12");
    expect(formatLastBackup(new Date(2026, 9, 20, 17, 30).getTime())).toBe("gestern 17:30");
  });

  it("zeigt sonst das Datum", () => {
    expect(formatLastBackup(new Date(2026, 9, 19, 8, 12).getTime())).toBe("19.10.2026 08:12");
    expect(formatLastBackup(new Date(2025, 11, 31, 23, 5).getTime())).toBe("31.12.2025 23:05");
  });

  it("sagt, wenn es noch keine Sicherung gibt", () => {
    expect(formatLastBackup(null)).toBe("noch keine Sicherung");
  });
});

describe("isBackupOverdue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 21, 12, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lässt heute, gestern und vorgestern gelten", () => {
    expect(isBackupOverdue(new Date(2026, 9, 21, 8, 12).getTime())).toBe(false);
    expect(isBackupOverdue(new Date(2026, 9, 20, 8, 12).getTime())).toBe(false);
    expect(isBackupOverdue(new Date(2026, 9, 19, 12, 0).getTime())).toBe(false);
  });

  it("schlägt an, wenn die letzte Sicherung länger als zwei Tage her ist", () => {
    expect(isBackupOverdue(new Date(2026, 9, 19, 11, 59).getTime())).toBe(true);
    expect(isBackupOverdue(new Date(2026, 8, 1, 8, 0).getTime())).toBe(true);
  });

  it("meldet nichts, solange es noch keine Sicherung gibt", () => {
    expect(isBackupOverdue(null)).toBe(false);
  });
});
