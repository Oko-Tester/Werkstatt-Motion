# Werkstatt Manager

Desktop-App für den Werkstattalltag: eine Hauptansicht mit Fahrzeugliste,
offenen Zahlungen und direkter Bearbeitung – ohne Modale, ohne Untermenüs,
vollständig offline.

## Technik

- **Desktop:** Tauri 2 (Rust)
- **Frontend:** React 19, TypeScript, Vite 7
- **Monorepo:** schlanker pnpm-Workspace, keine zusätzlichen Build-Orchestratoren
- **Tests:** Vitest + Testing Library (jsdom)

## Struktur

```
.
├── pnpm-workspace.yaml        pnpm-Workspace (apps/*)
├── package.json               zentrale Skripte: dev, build, check, test
└── apps/
    └── desktop/               React-Frontend + Tauri gemeinsam
        ├── index.html
        ├── vite.config.ts     Vite + Vitest-Konfiguration
        ├── public/icon.svg    lokales Favicon (kein Netzwerkzugriff)
        ├── src/
        │   ├── main.tsx       Einstieg
        │   ├── App.tsx        Zustand und Aktionen der Hauptansicht
        │   ├── types.ts       Vehicle- und Payment-Typen
        │   ├── data/mock.ts   Mockdaten (Schritt 1, ersetzt später SQLite)
        │   ├── styles/
        │   │   ├── tokens.css Design-Tokens (Farben, Abstände, Höhen …)
        │   │   └── app.css    Komponenten-Styles
        │   ├── components/    AppShell, Header, SearchInput, PrimaryButton,
        │   │                  InlineTextField, StatusToggle, VehicleTable,
        │   │                  VehicleRow, PaymentsPanel, UndoBar
        │   └── test/setup.ts  Testing-Library-Setup
        └── src-tauri/         Tauri 2 (Rust), Konfiguration, Icons
```

## Skripte (aus dem Repository-Root)

| Befehl         | Wirkung                                          |
| -------------- | ------------------------------------------------ |
| `pnpm install` | Abhängigkeiten installieren                      |
| `pnpm dev`     | Tauri-App im Entwicklungsmodus öffnen            |
| `pnpm check`   | TypeScript-Prüfung (`tsc --noEmit`)              |
| `pnpm test`    | Vitest-Tests ausführen                           |
| `pnpm build`   | Tauri-Release-Build inklusive Frontend erzeugen  |

Voraussetzungen: Node 20+, pnpm 10, Rust (stable) sowie unter Linux die
üblichen Tauri-Systempakete (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`librsvg2-dev`).

## Design

Alle Gestaltungswerte liegen als CSS-Variablen in
`apps/desktop/src/styles/tokens.css`:

- heller, leicht grauer Hintergrund, weiße Arbeitsflächen, dezente Rahmen
- ruhiges Blau als Hauptfarbe, Orange nur für Priorität/Aufmerksamkeit,
  Grün für abgeschlossene Zustände, Rot nur für Fehler/destruktive Aktionen
- Systemschrift, Grundschriftgröße 14 px
- 8-Pixel-Abstandssystem, Rundungen 8–10 px
- interaktive Elemente mindestens 40 px hoch, Tabellenzeilen 52 px
- sichtbare Fokuszustände, Status immer mit Symbol (nie nur Farbe)

## Bedienung (Stand Schritt 1, Mockdaten)

- Suche filtert die Fahrzeugliste sofort
- „+ Fahrzeug“ legt eine Zeile direkt in der Tabelle an, der Cursor springt
  ins erste Feld; Enter springt zum nächsten Feld, Escape verwirft die
  lokale Änderung, Verlassen des Feldes speichert automatisch
- Statusspalten (TÜV nötig, Teile bestellt, Teile angekommen, Fertig)
  schalten mit einem Klick um
- Priorisierung per Drag-and-drop am Griff oder mit den Pfeiltasten
- Archivieren und „Bezahlt“ zeigen kurz eine Rückgängig-Leiste statt eines
  Bestätigungsdialogs
- Tabellenkopf bleibt beim Scrollen sichtbar; der Zahlungsbereich ist fest
  unten angeordnet
