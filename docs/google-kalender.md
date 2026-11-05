# Google Kalender einrichten

Werkstatt Motion kann die Termine in einen Google Kalender schreiben, nur in diese
Richtung: Die App legt im Google-Konto einen eigenen Kalender **„Werkstatt Motion“**
an und trägt dort die Termine ein. So lassen sie sich zum Beispiel auf dem Handy
ansehen. Eingetragen wird weiter nur in der App.

Damit das geht, braucht die App eine eigene **Zugangs-ID bei Google** (OAuth-Client
vom Typ „Desktop-App“). Diese Anleitung ist für den, der die App baut und
veröffentlicht – nicht für die Werkstatt. Ohne Zugangs-ID zeigt die App unter
**„Einstellungen“ › „Kalender“** nur „In dieser Version nicht verfügbar“.

## 1. Google-Cloud-Projekt anlegen

1. In der [Google Cloud Console](https://console.cloud.google.com/) ein neues
   Projekt anlegen, etwa „Werkstatt Motion“.
2. Unter **APIs & Dienste › Bibliothek** die **Google Calendar API** aktivieren.
   Fehlt dieser Schritt, meldet die App: „Die Kalender-Schnittstelle ist im
   Google-Projekt dieser App nicht eingeschaltet.“

## 2. Zustimmungsbildschirm einrichten

Unter **Google Auth Platform** (früher „OAuth-Zustimmungsbildschirm“):

1. Zielgruppe **Extern**.
2. App-Name „Werkstatt Motion“, Support- und Kontakt-E-Mail.
3. Link zur Startseite und zur Datenschutzerklärung der App. Google verlangt beides,
   sobald die App veröffentlicht oder geprüft werden soll.
4. Datenzugriff (Berechtigungen) eintragen:
   - `openid`
   - `.../auth/userinfo.email` (zeigt in der App, welches Konto verbunden ist)
   - `https://www.googleapis.com/auth/calendar.app.created` (eigene Kalender anlegen
     und darin Termine verwalten; andere Kalender kann die App damit weder lesen noch
     ändern)
5. Solange die App im Status **„Testen“** ist: unter **Zielgruppe › Testnutzer** die
   Google-Adressen eintragen, die sich verbinden dürfen.

Wichtig zum Status:

- Im Status **„Testen“** laufen Anmeldungen nach **7 Tagen** ab. Die App meldet dann
  „Die Verbindung zu Google ist abgelaufen … Bitte neu verbinden“ (einmal am Tag als
  Hinweis, dauerhaft in den Einstellungen).
- Für den Dauerbetrieb die App auf **„In Produktion“** stellen. Solange Google eine App
  mit sensiblen Berechtigungen nicht geprüft hat, sehen Nutzer bei der Anmeldung einen
  Hinweis auf eine nicht überprüfte App, und es sind höchstens **100 neue Nutzer**
  möglich. Ob eine Berechtigung als sensibel gilt, zeigt die Console beim Eintragen.
- Für viele Werkstätten: die Prüfung bei Google beantragen.

## 3. Zugangs-ID anlegen

Unter **Clients › Client erstellen** (früher „Anmeldedaten › OAuth-Client-ID“) den
Typ **Desktop-App** wählen. Google zeigt danach Client-ID und Client-Secret.

Bei Desktop-Apps gelten beide laut Google nicht als Geheimnis, weil sie im Programm
stecken. Trotzdem gehören sie nicht ins Repository, sondern in die Umgebung des Builds.

## 4. In die App bauen

Die App liest die Werte **beim Bauen** aus zwei Umgebungsvariablen:

- `WERKSTATT_GOOGLE_CLIENT_ID`
- `WERKSTATT_GOOGLE_CLIENT_SECRET`

Lokal in PowerShell:

```powershell
$env:WERKSTATT_GOOGLE_CLIENT_ID = "1234-abcd.apps.googleusercontent.com"
$env:WERKSTATT_GOOGLE_CLIENT_SECRET = "GOCSPX-…"
pnpm --filter @werkstatt/desktop tauri dev
```

Für Releases im GitHub-Repository unter **Settings → Secrets and variables →
Actions** zwei Repository-Secrets mit genau diesen Namen anlegen. Der Release-Workflow
reicht sie an den Build weiter (siehe [RELEASES.md](RELEASES.md)).

## Was die App bei Google tut

- **Anmeldung:** im Standardbrowser, mit Rückleitung an `http://127.0.0.1:<Port>/` auf
  dem eigenen Rechner und PKCE. Die App sieht das Passwort nie. Öffnet sich kein
  Browser, lässt sich die Adresse in den Einstellungen kopieren.
- **Ablage:** Das Anmelde-Token liegt im Schlüsselspeicher des Betriebssystems
  (Eintrag `google-refresh-token`), Konto, Kalender und Stand in `google.json` neben
  der Datenbank. Beides gehört nicht zur Datensicherung und bleibt bei einer
  Wiederherstellung erhalten.
- **Kalender:** ein eigener Kalender „Werkstatt Motion“ (Zeitzone Europe/Berlin). Die
  App schreibt nur dort und fasst Termine, die jemand von Hand hineinlegt, nicht an.
- **Termine:** dieselben wie im Kalender der App. Mit Uhrzeit eine Stunde lang, ohne
  Uhrzeit ganztägig. Standardmäßig steht nur das Fahrzeug darin; Kunde und Kennzeichen
  nur mit der Wahl „Mit Kunde und Kennzeichen“, Notizen nie.
- **Abgleich:** wenige Sekunden nach jeder Änderung an einem Termin (mehrere Änderungen
  kurz hintereinander ergeben einen Lauf), beim Start der App, stündlich und mit „Jetzt
  abgleichen“, immer der vollständige Stand und nie zwei Läufe gleichzeitig. Ohne Internet
  passiert nichts; der nächste Lauf holt alles nach.
  Wird der Kalender bei Google gelöscht, legt die App ihn beim nächsten Abgleich neu an.
- **Trennen:** löscht den Kalender bei Google und widerruft den Zugang. Ist Google nicht
  erreichbar, bleibt die Verbindung bestehen; „Nur hier trennen“ räumt dann nur in der
  App auf.

## Datenschutz

Mit der Verbindung gehen Termindaten an Google: immer Datum, Uhrzeit und Fahrzeug, mit
der entsprechenden Wahl auch Kundenname und Kennzeichen. Die Verbindung ist freiwillig
und standardmäßig aus. Wer sie in einer Werkstatt nutzt, sollte das in deren
Datenschutzerklärung erwähnen; das ist keine Rechtsberatung.
