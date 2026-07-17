# Werkstatt Manager

Desktop-App für den Werkstattalltag: eine Hauptansicht mit Fahrzeugliste,
offenen Zahlungen und direkter Bearbeitung – ohne Modale, ohne Untermenüs,
vollständig offline.

## Technik

- **Desktop:** Tauri 2 (Rust)
- **Datenbank:** lokale SQLite (rusqlite, gebündelt) mit versionierten
  Migrationen; liegt im App-Datenverzeichnis des Betriebssystems
- **Frontend:** React 19, TypeScript, Vite 7
- **Monorepo:** schlanker pnpm-Workspace, keine zusätzlichen Build-Orchestratoren
- **Tests:** Vitest + Testing Library (jsdom, Tauri-IPC gemockt) und
  Rust-Tests (`cargo test`) gegen eine In-Memory-SQLite

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
        │   ├── api.ts         einzige Brücke zu den Tauri-Commands
        │   ├── money.ts       Cent-basierte Beträge, Euroformat, Parser
        │   ├── types.ts       Vehicle-, Payment- und Entwurfs-Typen
        │   ├── styles/
        │   │   ├── tokens.css Design-Tokens (Farben, Abstände, Höhen …)
        │   │   └── app.css    Komponenten-Styles
        │   ├── components/    AppShell, Header, SearchInput, PrimaryButton,
        │   │                  InlineTextField, InlineMoneyField, StatusToggle,
        │   │                  VehicleTable, VehicleRow, PaymentsPanel, UndoBar
        │   └── test/          Testing-Library-Setup + Fake-Backend (mockIPC)
        └── src-tauri/         Tauri 2 (Rust)
            └── src/
                ├── main.rs      Setup: DB öffnen, Migrationen, Commands
                ├── db.rs        Migrationen + Repository (inkl. Tests)
                ├── commands.rs  Tauri-Commands
                ├── models.rs    Vehicle, Payment, Eingabe-Typen
                └── error.rs     strukturierte Fehler fürs Frontend
```

## Skripte (aus dem Repository-Root)

| Befehl         | Wirkung                                                    |
| -------------- | ---------------------------------------------------------- |
| `pnpm install` | Abhängigkeiten installieren                                |
| `pnpm dev`     | Tauri-App im Entwicklungsmodus öffnen                      |
| `pnpm check`   | TypeScript-Prüfung (`tsc --noEmit`)                        |
| `pnpm test`    | Vitest-Tests und Rust-Tests (`cargo test`) ausführen       |
| `pnpm build`   | Tauri-Release-Build inklusive Frontend erzeugen            |

Voraussetzungen: Node 20+, pnpm 10, Rust (stable) sowie unter Linux die
üblichen Tauri-Systempakete (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`librsvg2-dev`).

## Datenhaltung

- Alle Daten liegen in einer lokalen SQLite-Datenbank (`werkstatt.db`) im
  App-Datenverzeichnis des Betriebssystems – nicht im Installationsordner.
- Das Frontend greift nie direkt auf SQLite zu; alle Zugriffe laufen über
  Tauri-Commands im Rust-Backend (`list_vehicles`, `create_vehicle`,
  `update_vehicle`, `update_vehicle_status`, `reorder_vehicles`,
  `archive_vehicle`, `restore_vehicle`, `list_open_payments`,
  `create_payment`, `update_payment`, `mark_payment_paid`, `restore_payment`).
- Migrationen sind versioniert (`PRAGMA user_version`) und laufen beim Start.
- Eingaben werden im Rust-Backend validiert; Fehler kommen strukturiert
  (Code, Meldung, betroffenes Feld) zurück und erscheinen direkt am Feld.
- Geldbeträge werden grundsätzlich als Integer in Cent gespeichert.

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

## Bedienung (Stand Schritt 2, SQLite-Daten)

- Suche filtert die Fahrzeugliste sofort nach Kunde, Fahrzeug und
  Kennzeichen; Strg+F/Cmd+F fokussiert die interne Suche
- „+ Fahrzeug“ legt eine bearbeitbare Zeile direkt in der Tabelle an, der
  Cursor springt ins Feld „Kunde“; Enter führt durch die Felder, Escape
  verwirft die lokale Änderung; gespeichert wird automatisch beim Verlassen
  der Zeile (Pflicht: Kunde und Fahrzeug oder Kennzeichen); leer verlassene
  Zeilen werden ohne Rückfrage verworfen
- Direkte Bearbeitung in jeder Zeile: Klick aktiviert das Feld, Enter oder
  Verlassen speichert still, Fehler erscheinen direkt am Feld und der alte
  Wert bleibt erhalten; Kennzeichen werden normalisiert (Großschreibung,
  Leerzeichen)
- Statusspalten (TÜV nötig, Teile bestellt, Teile angekommen, Fertig)
  schalten mit einem Klick um und speichern sofort – ohne automatische
  Folgeänderungen an anderen Status
- Priorisierung per Drag-and-drop am Griff oder mit den Pfeiltasten; die
  Reihenfolge wird nach dem Loslassen gespeichert, bei einem Speicherfehler
  wird die vorherige Reihenfolge wiederhergestellt
- Archivieren und „Bezahlt“ arbeiten ohne Bestätigungsdialog; eine kurze
  Rückgängig-Leiste stellt den vorherigen Zustand wieder her
- „+ Offener Betrag“ legt eine bearbeitbare Zahlungszeile an (Kunde, Betrag,
  Notiz) mit automatischer Euroformatierung; Beträge wie „486,50“ oder
  „1.234,56“ werden als Cent gespeichert
- Tabellenkopf bleibt beim Scrollen sichtbar; der Zahlungsbereich ist fest
  unten angeordnet; keine Aktion blockiert die Oberfläche
