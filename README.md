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
        │   ├── useLongPress.ts Long-Press-Erkennung (ohne Fortschrittsanzeige)
        │   ├── styles/
        │   │   ├── tokens.css Design-Tokens (Farben, Abstände, Höhen …)
        │   │   └── app.css    Komponenten-Styles
        │   ├── components/    AppShell, Header, SearchInput, PrimaryButton,
        │   │                  InlineTextField, InlineMoneyField, StatusToggle,
        │   │                  VehicleTable, VehicleRow, PaymentsPanel,
        │   │                  HiddenPanel, UndoBar
        │   └── test/          Testing-Library-Setup + Fake-Backend (mockIPC)
        └── src-tauri/         Tauri 2 (Rust)
            └── src/
                ├── main.rs      Setup: DB, Migrationen, Schlüssel, Commands
                ├── db.rs        Migrationen + Repository (inkl. Tests)
                ├── commands.rs  Tauri-Commands + App-Zustand (Db, Vault)
                ├── models.rs    Vehicle, Payment, HiddenEntry, Eingabe-Typen
                ├── error.rs     strukturierte Fehler fürs Frontend
                ├── crypto.rs    AEAD-Verschlüsselung (XChaCha20-Poly1305)
                ├── keys.rs      Master-Key im OS-Schlüsselspeicher (keyring)
                ├── hidden.rs    Repository der verschlüsselten Einträge
                └── backup.rs    Backup-Format, Validierung, Wiederherstellung
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

## Versteckter Bereich

Das Werkstattlogo in der Kopfzeile öffnet nach **drei Sekunden
ununterbrochenem Gedrückthalten** (Maus oder Touch) einen versteckten
Bereich rechts neben den offenen Zahlungen. Während des Haltens erscheint
bewusst keinerlei Fortschrittsanzeige (kein Ring, kein Balken, kein
Countdown); Loslassen, `pointercancel` oder Verlassen des Logos bricht ab,
normales Anklicken hat keine Wirkung. Ein sichtbares X schließt den Bereich
mit einem Klick – ohne Bestätigungsdialog, ohne Modal, ohne eigene Seite.

Der Bereich bedient sich wie die offenen Zahlungen: „+ Eintrag“ erzeugt
direkt eine bearbeitbare Zeile (Bezeichnung, Betrag in Cent, Notiz),
Änderungen speichern automatisch, Archivieren zeigt eine Rückgängig-Leiste.

**Sicherheitshinweis:** Das Gedrückthalten ist versteckte Bedienung, kein
Zugriffsschutz. Wer die laufende, entsperrte App bedienen kann, kann den
Bereich öffnen. Die Verschlüsselung schützt kopierte Datenbank- und
Backup-Dateien.

### Verschlüsselungsformat (Version 1)

- Verfahren: **XChaCha20-Poly1305** (authentifizierte Verschlüsselung, AEAD),
  implementiert ausschließlich im Rust-Backend (`crypto.rs`).
- Die fachlichen Inhalte eines Eintrags (Bezeichnung, Betrag, Notiz) werden
  gemeinsam als JSON-Payload serialisiert und als Ganzes verschlüsselt.
  Es gibt keine Klartextspalten für diese Felder.
- Pro Verschlüsselung wird eine frische 24-Byte-Zufallsnonce erzeugt.
- Die Assoziierten Daten (AAD) binden Eintrags-ID und Formatversion
  (`werkstatt-hidden:<id>:<version>`); vertauschte oder manipulierte
  Ciphertexte werden dadurch erkannt und abgelehnt.
- Die Tabelle `hidden_entries` speichert nur `id`, `encrypted_payload`,
  `nonce`, `encryption_version`, `created_at`, `updated_at`, `archived_at`.
- `encryption_version` ist pro Zeile gespeichert, damit spätere
  Formatwechsel migrierbar sind; unbekannte Versionen werden abgelehnt.
- Fehlermeldungen und Logs enthalten weder Klartext noch Schlüsselmaterial;
  entschlüsselte Zwischenpuffer und Schlüssel werden nach Gebrauch
  überschrieben (`zeroize`).

### Schlüsselverwaltung

- Beim ersten Start erzeugt das Backend einen zufälligen 32-Byte-Master-Key
  und einen Wiederherstellungscode (128 Bit Zufall) und legt beide im
  sicheren Schlüsselspeicher des Betriebssystems ab (`keyring`-Crate:
  Windows Credential Manager, macOS Keychain, Linux Secret Service).
- Der Schlüssel wird niemals an React übertragen, steht nicht im Quellcode
  und wird nicht in SQLite gespeichert.
- Kann der Schlüssel nicht geladen werden, startet die App trotzdem; der
  versteckte Bereich zeigt einen klaren Fehlerzustand. Existieren bereits
  verschlüsselte Einträge, wird **niemals** automatisch ein neuer Schlüssel
  erzeugt – das würde die Daten endgültig unlesbar machen.

### Backupformat

„Backup“ in der Kopfzeile erstellt über den **nativen Speichern-Dialog**
eine einzelne Datei (`.werkstattbackup`, JSON) mit:

- Manifest: Formatname, Formatversion, App-Version, Datenbank-Schemaversion,
  Verschlüsselungsversion, Erstellungszeitpunkt
- der vollständigen SQLite-Datenbank (konsistenter Schnappschuss über die
  SQLite-Online-Backup-API, Base64) samt SHA-256-Prüfsumme – versteckte
  Einträge bleiben darin verschlüsselt
- Schlüsselwiederherstellungsdaten: der Master-Key, verschlüsselt
  (XChaCha20-Poly1305) mit einem per HKDF-SHA256 aus dem
  Wiederherstellungscode abgeleiteten Schlüssel (zufälliges Salt pro Backup)

Ein Backup enthält versteckte Daten also niemals im Klartext, und die Datei
allein genügt nicht, um sie zu lesen.

„Wiederherstellen“ läuft zweistufig inline und braucht zwei Klicks:
Klick 1 wählt die Datei im nativen Dialog; das Backend validiert Manifest,
Prüfsumme, Schemaversion (Migration auf einer Kopie) und die Integrität
aller verschlüsselten Einträge. Klick 2 („Jetzt wiederherstellen“) legt
zuerst eine automatische Sicherung des aktuellen Zustands im
App-Datenverzeichnis (`backups/`) an und tauscht die Datenbankdatei dann
atomar aus. Jeder Fehler vor oder während des Austauschs lässt die
bestehende Datenbank unverändert.

### Getestete Fehlerfälle

Rust (`cargo test`) und Frontend (Vitest) decken u. a. ab:

- Long-Press unter drei Sekunden öffnet nichts; ab drei Sekunden öffnet
  genau einmal; `pointercancel`/`pointerleave` brechen ab; keinerlei
  Fortschrittsanzeige während des Haltens; Schließen über X
- Ver-/Entschlüsselung inklusive: unterschiedliche Nonces für gleiche
  Inhalte, manipulierte Ciphertexte/Nonces/AAD werden abgelehnt,
  vertauschte Payloads zwischen Zeilen werden abgelehnt
- Klartext erscheint weder in der Datenbankdatei noch in Fehlermeldungen
- fehlender Schlüssel bei bestehenden Daten erzeugt einen sicheren Fehler
  (kein neuer Schlüssel); nicht erreichbarer oder korrupter
  Schlüsselspeicher wird gemeldet, ohne etwas zu überschreiben
- Backups enthalten keine versteckten Klartextdaten; gültige Backups lassen
  sich wiederherstellen (auch nur mit Wiederherstellungscode); abgeschnittene,
  prüfsummen-falsche, inhaltlich manipulierte, format-fremde und zu neue
  Backups werden abgelehnt, ohne die aktuelle Datenbank zu verändern

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

## Bedienung (Stand Schritt 3)

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
- „Backup“ und „Wiederherstellen“ sind direkt in der Kopfzeile sichtbar und
  nutzen ausschließlich die nativen Dateidialoge des Betriebssystems; die
  Wiederherstellung wird über eine zweistufige Inline-Aktion bestätigt
  (siehe „Versteckter Bereich“ und „Backupformat“)
- Tabellenkopf bleibt beim Scrollen sichtbar; der Zahlungsbereich ist fest
  unten angeordnet und nutzt die volle Breite, solange der versteckte
  Bereich geschlossen ist; keine Aktion blockiert die Oberfläche
