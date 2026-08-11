<p align="center">
  <img src="docs/images/logo-readme.png" alt="Werkstatt Motion" width="760">
</p>

<p align="center"><strong>Alle Fahrzeuge, Arbeiten und offenen Zahlungen auf einen Blick.</strong></p>

Werkstatt Motion ist eine einfache Anwendung für den täglichen Werkstattbetrieb.
Keine verschachtelten Menüs, kein unnötiger Papierkram – einfach öffnen und loslegen.

![Werkstatt Motion mit Fahrzeugübersicht und offenen Zahlungen](docs/images/werkstatt-motion-uebersicht.png)

## Das Wichtigste im Überblick

- Fahrzeuge und Kunden übersichtlich verwalten
- Werkstatttermine direkt am Fahrzeug planen und im Kalender überblicken
- Arbeitsstand mit einem Klick markieren
- TÜV und bestellte Teile im Blick behalten
- Offene Zahlungen direkt sehen und als bezahlt markieren
- Zusätzliche Kosten diskret in einem versteckten Bereich erfassen
- Fahrzeuge schnell nach Kunde, Kennzeichen oder Modell finden
- Erledigte Aufträge in der Historie nachschlagen
- Daten auf einem USB-Stick oder an einem anderen Ort sichern
- Neue Versionen direkt in der App suchen und sicher installieren
- Funktioniert auch ohne Internet

## So einfach geht's

### Fahrzeug anlegen

Oben rechts auf **„+ Fahrzeug“** klicken und Kunde, Fahrzeug oder Kennzeichen
eintragen. Die Angaben werden automatisch gespeichert.

### Arbeitsstand ändern

Bei **„TÜV nötig“**, **„Teile bestellen“**, **„Teile angekommen“** oder
**„Fertig“** einfach auf das passende Feld klicken.

### Notizen bearbeiten

Beim Darüberfahren zeigt eine gefüllte Notiz weiterhin ihre vollständige
Vorschau. Ein Klick öffnet diese Fläche als großen mehrzeiligen Editor. Beim
Verlassen wird automatisch gespeichert; **Strg+Enter** speichert direkt und
**Esc** verwirft die aktuelle Änderung.

### Reihenfolge festlegen

Wichtige Fahrzeuge lassen sich am Griff links nach oben ziehen. So steht der
dringendste Auftrag immer ganz oben. Auch die Tabellenspalten – einschließlich
**„Termin“** – lassen sich am Spaltenkopf verschieben; ihre Reihenfolge wird
automatisch gespeichert.

### Fahrzeugtermin planen

In der Spalte **„Termin“** auf **„Termin hinzufügen“** beziehungsweise den
vorhandenen Termin klicken. Datum und optional eine Uhrzeit auswählen und
speichern; der Wochentag wird automatisch ermittelt. Die Uhrzeit kann leer
bleiben. Mit **„Termin entfernen“** lässt sich die Planung wieder löschen.

Über den gut sichtbaren Button **„Kalender“** öffnet sich die Monatsübersicht.
Dort erscheinen dieselben Fahrzeugtermine mit Uhrzeit beziehungsweise dem
Hinweis **„Ohne Uhrzeit“**, Kunde, Fahrzeug und Kennzeichen. Änderungen aus der
Fahrzeugliste sind unmittelbar auch im Kalender sichtbar.

Über die beiden Arbeitsansichten **„Kalender“** und **„Historie“** lässt sich
jederzeit zwischen anstehenden Terminen und abgeschlossenen Vorgängen wechseln.

![Werkstatt Motion mit Monatskalender sowie den Ansichten Kalender und Historie](docs/images/werkstatt-motion-kalender.png)

### Historie öffnen

Über den Button **„Historie“** werden abgeschlossene Fahrzeuge als
unveränderliche Snapshots angezeigt. Zusätzlich sind dort bereits bezahlte
Kosten mit Fahrzeug, Kennzeichen, Betrag und Zahlungszeitpunkt zu finden. Das
Suchfeld filtert beide Bereiche gemeinsam.

### Offene Zahlung eintragen

Im Bereich **„Offene Zahlungen“** auf **„+ Offener Betrag“** klicken. Sobald
bezahlt wurde, genügt ein Klick auf **„✓ Bezahlt“**.

### Versteckte Kosten erfassen

Das Werkstattlogo oben links drei Sekunden lang gedrückt halten. Daraufhin
öffnet sich der Bereich **„Versteckte Einträge“**. Dort lassen sich über
**„+ Eintrag“** eine Bezeichnung, ein Betrag und eine Notiz erfassen.

Mit **„×“** wird der Bereich wieder geschlossen. Die Einträge sind damit in der
normalen Ansicht nicht sichtbar. Das Verstecken ist jedoch kein Passwortschutz.

### Fahrzeug suchen

Oben den Namen, das Kennzeichen oder das Fahrzeug eingeben. Die passende Zeile
erscheint sofort.

## Installation

### Windows

1. Die Installationsdatei auf den Werkstatt-PC kopieren.
2. Die Datei doppelt anklicken und die Installation bestätigen.
3. **Werkstatt Motion** über das Startmenü öffnen.

Es werden keine zusätzlichen Programme und keine Anmeldung benötigt.

### Linux

Für Ubuntu, Debian, Linux Mint und verwandte Distributionen im neuesten
[GitHub Release](https://github.com/Oko-Tester/Werkstatt-Motion/releases/latest)
die Datei mit der Endung `.deb` herunterladen. Anschließend die Datei über die
Softwareverwaltung öffnen oder im Download-Ordner installieren:

```bash
sudo apt install ./*.deb
```

Danach lässt sich **Werkstatt Motion** wie andere Anwendungen über das
Anwendungsmenü starten.

Alternativ steht im Release ein `.AppImage` für weitere Linux-Distributionen
bereit. Nach dem Download muss es einmal ausführbar gemacht werden:

```bash
chmod +x ./*.AppImage
./*.AppImage
```

Die bereitgestellten Linux-Pakete sind für 64-Bit-PCs (`x86_64`) vorgesehen.

## Updates

Im Drei-Punkte-Menü oben rechts auf **„Nach Updates suchen“** klicken. Ist eine
neue Version verfügbar, zeigt Werkstatt Motion die Versionsnummer an. Das
Update startet erst nach einem Klick auf **„Update installieren“**.

Vor der Installation erstellt die App automatisch ein vollständiges
Sicherheits-Backup. Kann dieses Backup nicht gespeichert werden, wird das
Update nicht durchgeführt. Für die Update-Suche wird kurzzeitig eine
Internetverbindung benötigt; ansonsten bleibt Werkstatt Motion vollständig
offline nutzbar.

## Datensicherung

Werkstatt Motion erstellt automatisch höchstens ein vollständiges Backup pro
Kalendertag. Beim App-Start wird sofort geprüft, ob die heutige Sicherung fehlt;
bei länger geöffneter App läuft diese Prüfung stündlich weiter. Tägliche Backups
werden für 14 Tage aufbewahrt, ältere tägliche Sicherungen löscht die App
automatisch. Dazu muss die App an dem jeweiligen Tag geöffnet sein.

Die täglichen Sicherungen liegen im Anwendungsdatenverzeichnis:

```text
Windows: %APPDATA%\de.werkstattmotion.desktop\backups
Linux:   ~/.local/share/de.werkstattmotion.desktop/backups
```

Über **„Backup“** lässt sich jederzeit eine Sicherung erstellen – zum Beispiel
auf einem USB-Stick. Mit **„Wiederherstellen“** kann eine Sicherung später
wieder eingespielt werden.

**Empfehlung:** Regelmäßig ein Backup erstellen und getrennt vom Werkstatt-PC
aufbewahren.

### Automatische Sicherung wiederherstellen

Tägliche Sicherungen und Sicherungen vor einer Wiederherstellung liegen in den
oben genannten App-Datenpfaden. Unter Linux kann `$XDG_DATA_HOME` den Ordner
`~/.local/share` ersetzen. Die verpflichtende Sicherung vor einem Update liegt
dagegen im Unterordner `Backups` neben der installierten Programmdatei.

So lässt sich die Sicherung öffnen und wieder einspielen:

1. Den oben genannten Ordner im Dateimanager öffnen.
2. Die gewünschte Datei auswählen. Tägliche Sicherungen beginnen mit
   `taeglich-`, Update-Sicherungen mit `vor-update-`; beide enden auf
   `.werkstattbackup`.
3. Werkstatt Motion öffnen und im Drei-Punkte-Menü auf
   **„Wiederherstellen“** klicken.
4. Die Backup-Datei aus dem Ordner auswählen und
   **„Jetzt wiederherstellen“** bestätigen.

## Lizenz

Werkstatt Motion ist unter der [MIT-Lizenz](LICENSE) veröffentlicht. Die App
und ihr Quellcode dürfen damit verwendet, verändert und weitergegeben werden,
sofern der Lizenz- und Urheberrechtshinweis erhalten bleibt.

---

Werkstatt Motion wurde für den Werkstattalltag gemacht: schnell verständlich,
direkt bedienbar und ohne technisches Drumherum.
