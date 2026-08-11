# Releases veröffentlichen

Werkstatt Motion veröffentlicht signierte Windows- und Linux-Updates über
GitHub Releases.
Ein vollständiger Release-Entwurf entsteht automatisch, sobald ein passender
Versions-Tag gepusht wird. Der Entwurf wird erst nach der Kontrolle seiner
Dateien manuell veröffentlicht, damit unveränderliche Releases vollständig
bleiben.

## Einmalige Einrichtung

Im GitHub-Repository unter **Settings → Secrets and variables → Actions** ein
Repository-Secret mit dem Namen `TAURI_SIGNING_PRIVATE_KEY` anlegen. Als Wert
den vollständigen Inhalt dieser lokalen Datei eintragen:

```text
C:\Users\Alexander\.tauri\werkstatt-motion.key
```

Der private Schlüssel darf weder ins Repository eingecheckt noch weitergegeben
werden. Zusätzlich sollte er sicher außerhalb des Rechners gesichert werden.
Ohne diesen Schlüssel können bereits installierte Apps keine zukünftigen
Updates mehr verifizieren.

## Neues Release

1. Die Version in diesen Dateien identisch erhöhen:
   - `package.json`
   - `apps/desktop/package.json`
   - `apps/desktop/src-tauri/Cargo.toml`
   - `apps/desktop/src-tauri/tauri.conf.json`
2. Änderungen committen und nach `main` pushen.
3. Einen zur Version passenden, bisher unbenutzten Tag pushen:

```powershell
git tag v1.1.2
git push origin v1.1.2
```

Die GitHub Action baut anschließend parallel den Windows-Installer sowie die
Linux-Pakete, erzeugt die Update-Signaturen und führt alle Plattformen in
`latest.json` zusammen. Sämtliche Dateien werden gemeinsam in einen
Release-Entwurf geladen. Der Tag muss exakt zur Version aus `tauri.conf.json`
passen.

4. Nach erfolgreicher Action unter **Releases → Drafts** kontrollieren, dass
   mindestens diese Dateien enthalten sind:
   - `Werkstatt Motion_<Version>_x64-setup.exe`
   - `Werkstatt Motion_<Version>_x64-setup.exe.sig`
   - `Werkstatt Motion_<Version>_amd64.deb`
   - `Werkstatt Motion_<Version>_amd64.deb.sig`
   - `Werkstatt Motion_<Version>_amd64.AppImage`
   - `Werkstatt Motion_<Version>_amd64.AppImage.sig`
   - `latest.json`
5. Erst danach **Publish release** auswählen. Mit aktivierter Release-
   Unveränderlichkeit können Dateien nach diesem Schritt nicht mehr ergänzt,
   ersetzt oder gelöscht werden.

Bereits veröffentlichte unveränderliche Tags dürfen nicht für einen neuen
Release wiederverwendet werden. Nach einem fehlgeschlagenen veröffentlichten
`v1.1.0` wird deshalb beispielsweise mit `v1.1.1` fortgefahren.

## Lokaler signierter Build

Vor einem lokalen Release-Build den privaten Schlüssel für die laufende
PowerShell setzen:

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:TAURI_SIGNING_PRIVATE_KEY=Get-Content -Raw "$env:USERPROFILE\.tauri\werkstatt-motion.key"
pnpm --filter @werkstatt/desktop tauri build --ci
```

Das normale Programm bleibt ohne Internet vollständig nutzbar. Nur die manuell
ausgelöste Update-Suche benötigt eine Verbindung zu GitHub.
