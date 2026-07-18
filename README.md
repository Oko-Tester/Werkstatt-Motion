# Werkstatt Manager

Desktop-App für den Werkstattalltag: eine Hauptansicht mit Fahrzeugliste,
offenen Zahlungen und direkter Bearbeitung – ohne Modale, ohne Untermenüs,
vollständig offline. Version 1.0.0.

## Anwenderhilfe (Kurzüberblick)

- **Fahrzeug hinzufügen:** „+ Fahrzeug“ in der Kopfzeile klicken. Eine neue
  Zeile erscheint oben in der Tabelle, der Cursor steht im Feld „Kunde“.
  Enter springt zum nächsten Feld; gespeichert wird automatisch beim
  Verlassen der Zeile. Leer verlassene Zeilen verschwinden ohne Rückfrage.
- **Priorität ändern:** Zeile am Griff (Punktsymbol links) nach oben oder
  unten ziehen – oder den Griff fokussieren und die Pfeiltasten nutzen.
  Die Reihenfolge wird automatisch gespeichert.
- **Status ändern:** Ein Klick auf „TÜV nötig“, „Teile bestellt“,
  „Teile angekommen“ oder „Fertig“ schaltet den Status um und speichert
  sofort. Kein Status ändert einen anderen mit.
- **Zahlung verwalten:** „+ Offener Betrag“ legt eine Zeile an (Kunde,
  Betrag, Notiz). Beim Tippen schlägt das Kundenfeld vorhandene Kunden aus
  aktiven, erledigten und archivierten Fahrzeugen vor; Maus, Pfeiltasten und
  Enter werden unterstützt, freie Eingaben bleiben möglich. Beträge wie
  „486,50“ oder „1.234,56“ werden Cent-genau gespeichert. „✓ Bezahlt“ entfernt
  die Zahlung aus der Liste; die kurze Rückgängig-Leiste unten macht das bei
  Bedarf sofort rückgängig.
- **Zahlungen verbergen:** Der Pfeil im Kopf von „Offene Zahlungen“ minimiert
  den Bereich sofort. Im minimierten Zustand sind weder Namen noch Beträge,
  Summen, Anzahlen oder Notizen sichtbar. Die Einstellung bleibt beim nächsten
  App-Start erhalten.
- **Fahrzeugspalten anordnen:** Fachliche Spalten am Tabellenkopf ziehen –
  oder mit Alt+Pfeiltaste verschieben. Zeilengriff und Archivspalte bleiben
  fest; die Reihenfolge wird automatisch gespeichert.
- **Historie öffnen:** „Historie“ in der Kopfzeile öffnet jederzeit die
  erledigten Fahrzeuge als Arbeitsansicht innerhalb des App-Fensters, ohne
  Modal. Versteckte Rechnungen werden dort erst ergänzt, nachdem das Logo drei
  Sekunden gedrückt wurde; beim Sperren verschwinden sie sofort wieder, während
  die normale Fahrzeughistorie geöffnet bleibt. „Zurück“ schließt die Ansicht.
- **Versteckten Bereich öffnen und schließen:** Das Werkstattlogo oben
  links **drei Sekunden gedrückt halten** (Maus oder Touch). Es erscheint
  bewusst keine Fortschrittsanzeige. Das sichtbare X im Bereich schließt
  ihn mit einem Klick und löscht alle entschlüsselten Daten aus dem UI-Zustand.
- **Backup erstellen:** „Backup“ in der Kopfzeile klicken und im
  Systemdialog einen Speicherort wählen (z. B. USB-Stick). Fertig.
- **Daten wiederherstellen:** „Wiederherstellen“ klicken, Backup-Datei
  wählen. Die App prüft die Datei vollständig und zeigt, was sie enthält.
  Erst der zweite Klick auf „Jetzt wiederherstellen“ ersetzt die Daten –
  vorher legt die App automatisch eine Sicherung des aktuellen Stands an.
- **Archivieren:** Das Kistensymbol rechts in der Fahrzeugzeile archiviert
  ohne Rückfrage; „Rückgängig“ in der Leiste unten stellt wieder her.
- **Suche:** Das Suchfeld filtert sofort nach Kunde, Fahrzeug und
  Kennzeichen. Strg+F (bzw. Cmd+F) springt direkt hinein.

## Technik

- **Desktop:** Tauri 2 (Rust)
- **Datenbank:** lokale SQLite (rusqlite, gebündelt) mit versionierten
  Migrationen; liegt im App-Datenverzeichnis des Betriebssystems
- **Frontend:** React 19, TypeScript, Vite 7
- **Monorepo:** schlanker pnpm-Workspace, keine zusätzlichen Build-Orchestratoren
- **Tests:** Vitest + Testing Library (jsdom, Tauri-IPC gemockt) und
  Rust-Tests (`cargo test`) gegen eine In-Memory-SQLite
- Die App funktioniert vollständig ohne Internetverbindung; es gibt keine
  Telemetrie, keine Konten und keine automatischen Updates.

## Voraussetzungen für Entwickler

- Node 20+ und pnpm 10
- Rust (stable) inkl. Cargo
- Unter Linux die üblichen Tauri-Systempakete:
  `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`
- Unter Windows: Microsoft Visual Studio Build Tools (C++) und WebView2
  (auf Windows 10/11 vorinstalliert)

## Skripte (aus dem Repository-Root)

| Befehl         | Wirkung                                                    |
| -------------- | ---------------------------------------------------------- |
| `pnpm install` | Abhängigkeiten installieren                                |
| `pnpm dev`     | Tauri-App im Entwicklungsmodus öffnen                      |
| `pnpm check`   | TypeScript-Prüfung (`tsc --noEmit`)                        |
| `pnpm test`    | Vitest-Tests und Rust-Tests (`cargo test`) ausführen       |
| `pnpm build`   | Tauri-Release-Build inklusive Frontend erzeugen            |

## Struktur

```
.
├── pnpm-workspace.yaml        pnpm-Workspace (apps/*)
├── package.json               zentrale Skripte: dev, build, check, test
└── apps/
    └── desktop/               React-Frontend + Tauri gemeinsam
        ├── index.html
        ├── vite.config.ts     Vite + Vitest-Konfiguration
        ├── public/icon.svg    Werkstattlogo (lokal, kein Netzwerkzugriff)
        ├── src/
        │   ├── main.tsx       Einstieg
        │   ├── App.tsx        Zustand und Aktionen der Hauptansicht
        │   ├── api.ts         einzige Brücke zu den Tauri-Commands
        │   ├── money.ts       Cent-basierte Beträge, Euroformat, Parser
        │   ├── types.ts       Vehicle-, Payment- und Entwurfs-Typen
        │   ├── useLongPress.ts Long-Press-Erkennung (ohne Fortschrittsanzeige)
        │   ├── styles/        tokens.css (Design-Tokens) + app.css
        │   ├── components/    AppShell, Header, SearchInput, PrimaryButton,
        │   │                  InlineTextField, InlineMoneyField, StatusToggle,
        │   │                  VehicleTable, VehicleRow, PaymentsPanel,
        │   │                  CustomerAutocomplete, HiddenPanel,
        │   │                  HistoryWorkspace, UndoBar
        │   └── test/          Testing-Library-Setup + Fake-Backend (mockIPC)
        └── src-tauri/         Tauri 2 (Rust)
            ├── tauri.conf.json          Produktkonfiguration (Fenster, Bundle)
            ├── tauri.windows.conf.json  Windows: NSIS-Installer als Ziel
            ├── icons/                   Werkstattlogo in allen Icon-Größen
            └── src/
                ├── main.rs      Setup: DB, Migrationen, Schlüssel, Commands
                ├── db.rs        Öffnen, Migrationen, Repository (inkl. Tests)
                ├── commands.rs  Tauri-Commands + App-Zustand (Db, Vault)
                ├── models.rs    Vehicle, Payment, HiddenEntry, Eingabe-Typen
                ├── error.rs     strukturierte, verständliche Fehler
                ├── crypto.rs    AEAD-Verschlüsselung (XChaCha20-Poly1305)
                ├── keys.rs      Master-Key im OS-Schlüsselspeicher (keyring)
                ├── hidden.rs    Repository der verschlüsselten Einträge
                └── backup.rs    Backup-Format, Validierung, Wiederherstellung
```

## Speicherorte

Alle Daten liegen im App-Datenverzeichnis des Betriebssystems, **nicht** im
Installationsordner. Der Ordnername entspricht dem Application-Identifier
`de.werkstattmanager.desktop`:

| Was                          | Windows                                                        | Linux                                        |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| Datenbank `werkstatt.db`     | `%APPDATA%\de.werkstattmanager.desktop\werkstatt.db`           | `~/.local/share/de.werkstattmanager.desktop` |
| Automatische Sicherungen     | `%APPDATA%\de.werkstattmanager.desktop\backups\`               | `…/de.werkstattmanager.desktop/backups/`     |
| Master-Key                   | Windows-Anmeldeinformationsverwaltung (Credential Manager)      | Secret Service (z. B. GNOME-Schlüsselbund)   |

Manuell erstellte Backups (`.werkstattbackup`) liegen dort, wo sie im
Speichern-Dialog abgelegt wurden (empfohlen: externer Datenträger).

## Backup und Wiederherstellung

**Backup:** „Backup“ erstellt über den nativen Speichern-Dialog eine einzelne
JSON-Datei (`werkstatt-backup-JJJJ-MM-TT.werkstattbackup`) mit:

- Manifest (Formatname, Formatversion, App-Version, Schemaversion,
  Verschlüsselungsversion, Erstellungszeitpunkt)
- der vollständigen SQLite-Datenbank als konsistentem Schnappschuss
  (SQLite-Online-Backup-API, Base64) samt SHA-256-Prüfsumme – versteckte
  Einträge bleiben darin **verschlüsselt**
- den Schlüsselwiederherstellungsdaten: der Master-Key, verschlüsselt mit
  einem aus dem Wiederherstellungscode abgeleiteten Schlüssel (HKDF-SHA256,
  zufälliges Salt pro Backup)

Die Backup-Datei allein genügt also nicht, um versteckte Daten zu lesen.

**Wiederherstellung** läuft zweistufig inline, ohne Modal: Klick 1 wählt die
Datei und validiert sie vollständig (Manifest, Prüfsumme, Schemaversion mit
Migration auf einer Kopie, Integrität aller verschlüsselten Einträge). Klick 2
(„Jetzt wiederherstellen“) sichert zuerst den aktuellen Zustand automatisch
nach `backups/` und tauscht die Datenbankdatei dann atomar aus. Jeder Fehler
vor oder während des Austauschs lässt die bestehende Datenbank unverändert.

**Reparaturweg:** Die Wiederherstellung funktioniert auch dann, wenn die
aktuelle Datenbank nicht mehr lesbar ist oder der Schlüssel fehlt – die App
startet trotzdem, zeigt einen klaren Fehlerzustand und „Wiederherstellen“
bleibt nutzbar. Eine defekte Datenbankdatei wird vorher als Kopie nach
`backups/` gelegt; ein im Backup enthaltener Schlüssel wird nach der
Wiederherstellung wieder in den Schlüsselspeicher übernommen.

## Verschlüsselungskonzept

- Versteckte Einträge werden ausschließlich im Rust-Backend mit
  **XChaCha20-Poly1305** (authentifizierte Verschlüsselung, AEAD)
  verschlüsselt; React sieht nur entschlüsselte Werte zur Anzeige.
- Klartext-Commands akzeptieren ausschließlich ein zufälliges, flüchtiges
  Sitzungstoken aus dem Rust-Arbeitsspeicher. React hält dieses Token nur im
  laufenden State; weder Token noch Secret-Status werden in SQLite oder
  `localStorage` gespeichert und jeder App-Neustart startet gesperrt.
- Archivierte Secret-Einträge erhalten einen eigenen, unveränderlichen und
  erneut verschlüsselten History-Snapshot mit frischer Nonce und eigener
  AAD-Domäne. Bezeichnung, Betrag, Notiz und Archivierungszeitpunkt besitzen
  auch dort keine Klartextspalten.
- Bezeichnung, Betrag und Notiz werden gemeinsam als JSON-Payload
  verschlüsselt – es gibt **keine Klartextspalten** für diese Felder.
- Pro Verschlüsselung entsteht eine frische 24-Byte-Zufallsnonce; die AAD
  bindet Eintrags-ID und Formatversion, vertauschte oder manipulierte
  Ciphertexte werden erkannt und abgelehnt.
- Der 32-Byte-Master-Key entsteht beim ersten Start und liegt im sicheren
  Schlüsselspeicher des Betriebssystems (Windows Credential Manager,
  macOS Keychain, Linux Secret Service) – nie im Quellcode, nie in SQLite,
  nie im Frontend.
- Kann der Schlüssel nicht geladen werden, startet die App trotzdem; es wird
  **niemals** automatisch ein neuer Schlüssel erzeugt, solange verschlüsselte
  Einträge existieren (das würde sie endgültig unlesbar machen).
- Fehlermeldungen und Logs enthalten weder Klartext noch Schlüsselmaterial;
  Schlüssel und Zwischenpuffer werden nach Gebrauch überschrieben (`zeroize`).
- Das Gedrückthalten des Logos ist **versteckte Bedienung, kein
  Zugriffsschutz**: Wer die laufende App bedienen kann, kann den Bereich
  öffnen. Die Verschlüsselung schützt kopierte Datenbank- und Backup-Dateien.

## Release-Erstellung (Windows, NSIS)

Der produktive Windows-Build wird **auf einem Windows-Rechner** erstellt
(Tauri unterstützt Cross-Builds von Linux aus nur experimentell):

```powershell
# einmalig: Rust (stable, MSVC), Node 20+, pnpm 10 installieren
pnpm install
pnpm check
pnpm test
pnpm build          # erzeugt Release-Build + NSIS-Installer
```

`tauri.windows.conf.json` setzt das Bundle-Ziel auf NSIS. Ergebnis:

```
apps/desktop/src-tauri/target/release/bundle/nsis/Werkstatt Manager_1.0.0_x64-setup.exe
```

Der Installer ist deutschsprachig, installiert ohne Adminrechte ins
Benutzerprofil (`currentUser`) und legt Startmenü-Verknüpfung samt
Werkstattlogo an. Die installierte App benötigt **kein** Node.js, pnpm oder
Rust – nur Windows 10/11 mit WebView2 (vorinstalliert).

Unter Linux erzeugt `pnpm build` ein `.deb`-Paket sowie das ausführbare
Release-Binary (`apps/desktop/src-tauri/target/release/werkstatt-manager`).

## Installation auf dem Werkstatt-PC

1. `Werkstatt Manager_1.0.0_x64-setup.exe` auf den PC kopieren (USB-Stick).
2. Doppelklick, Installation bestätigen – keine Adminrechte nötig.
3. „Werkstatt Manager“ über das Startmenü öffnen. Beim ersten Start werden
   Datenbank und Schlüssel automatisch angelegt.

## Manueller Updateprozess

Es gibt bewusst **keine** automatische Update-Infrastruktur (kein sicherer
Update-Server vorhanden). Updates laufen manuell:

1. Am Werkstatt-PC ein **Backup erstellen** (Kopfzeile → „Backup“).
2. Neue `…_x64-setup.exe` auf den PC kopieren und ausführen – sie ersetzt
   die installierte Version, Daten und Schlüssel bleiben unangetastet
   (sie liegen im App-Datenverzeichnis bzw. Schlüsselspeicher).
3. App starten; Datenbank-Migrationen laufen automatisch.
4. Kurz prüfen, dass Fahrzeuge und Zahlungen vollständig da sind. Falls
   etwas nicht stimmt: „Wiederherstellen“ mit dem Backup aus Schritt 1.

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
- keine Farbverläufe, kein Glassmorphism, keine dekorativen Animationen

## Fehlerzustände

Alle Fehler erscheinen verständlich, knapp und am relevanten Ort – nie als
blockierender Dialog, nie als rohe Rust-/SQLite-Meldung:

- **Datenbank nicht verfügbar / Migration fehlgeschlagen:** Die App startet
  trotzdem; die Fahrzeugliste zeigt die Meldung mit „Erneut laden“, und die
  Wiederherstellung aus einem Backup bleibt als Reparaturweg nutzbar.
- **Speichern fehlgeschlagen:** Meldung direkt am betroffenen Feld bzw. als
  kurzer Hinweis; der vorherige Wert bleibt erhalten.
- **Backup/Wiederherstellung fehlgeschlagen:** Meldung in der Kopfzeile;
  die bestehende Datenbank bleibt unverändert.
- **Schlüssel nicht verfügbar / verschlüsselte Daten beschädigt:** Der
  versteckte Bereich zeigt einen klaren Fehlerzustand; es wird nie
  automatisch ein neuer Schlüssel erzeugt, nichts wird überschrieben.
