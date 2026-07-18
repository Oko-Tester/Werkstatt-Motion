# Releases veröffentlichen

Werkstatt Motion veröffentlicht signierte Windows-Updates über GitHub Releases.
Ein Release entsteht automatisch, sobald ein passender Versions-Tag gepusht
wird.

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
3. Einen zur Version passenden Tag pushen:

```powershell
git tag v1.0.1
git push origin v1.0.1
```

Die GitHub Action baut anschließend den NSIS-Installer, die Update-Signatur und
`latest.json`. Der Tag muss exakt zur Version aus `tauri.conf.json` passen.

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
