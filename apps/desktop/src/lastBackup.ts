function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const OVERDUE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Die App sichert täglich. Liegt die letzte Sicherung länger als zwei Tage zurück,
 * stimmt etwas nicht (z. B. der Stick steckt seit Tagen nicht) – das soll man
 * der Zeile ansehen, auch wenn keine Fehlermeldung mehr dasteht.
 */
export function isBackupOverdue(millis: number | null): boolean {
  return millis !== null && Date.now() - millis > OVERDUE_AFTER_MS;
}

/** „heute 08:12“, „gestern 17:30“ oder „19.10.2026 08:12“ – Zeitpunkte in Millisekunden seit 1970. */
export function formatLastBackup(millis: number | null): string {
  if (millis === null) return "noch keine Sicherung";
  const date = new Date(millis);
  const now = new Date();
  const time = date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, now)) return `heute ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, yesterday)) return `gestern ${time}`;
  const day = date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return `${day} ${time}`;
}
