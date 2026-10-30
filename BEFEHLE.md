# Befehle – Spickzettel

Alle Befehle im Projektordner ausführen. **Lokal** = PowerShell auf deinem PC, **Ditto** = per SSH auf dem Server.

## 1. Lokal testen (ohne Docker)

Einmalig nach dem Klonen bzw. wenn sich `package.json` geändert hat:

```powershell
npm install
```

### Entwickeln – mit automatischem Neuladen

```powershell
npm run dev
```

Öffnen: **http://localhost:5173**. Server und Seite starten neu, sobald du eine Datei speicherst. Beenden mit **Strg+C**.

### Wie im Betrieb – gebaute Seite, ein Server

```powershell
npm start -- --local
```

Öffnen: **http://localhost:3000**. Baut die Seite und startet den Server (ohne ngrok). Mit `--no-build` geht es
schneller, wenn sich an der Seite nichts geändert hat.

### „Passwort vergessen“ lokal ausprobieren

Lokal gibt es keinen Mailserver. Mit `MAIL_FILE` landen die Mails in einer Datei:

```powershell
$env:MAIL_FILE = 'data/mails.jsonl'; npm run dev
```

Danach „Passwort vergessen“ drücken. Der Link steht in der letzten Zeile von `data/mails.jsonl`:

```powershell
Get-Content data/mails.jsonl -Tail 1
```

### Admin lokal

1. Im Browser (http://localhost:5173) einen Account anlegen.
2. Im zweiten Terminal (der Server darf weiterlaufen):

```powershell
npm run admin -- grant <Benutzername>
```

3. Seite neu laden → Account-Fenster → **🛠 Admin-Bereich öffnen**.

| Befehl | Was es macht |
|---|---|
| `npm run admin -- list` | alle Admins anzeigen |
| `npm run admin -- grant <Name>` | zum Admin machen |
| `npm run admin -- revoke <Name>` | Admin-Rechte nehmen |

### Lokale Daten zurücksetzen

Accounts, Admin-Einstellungen der Routenberechnung und Statistik liegen lokal in `data/` (nicht in Git):

```powershell
Remove-Item data/accounts.db*, data/routing-overrides.json, data/usage.json -ErrorAction SilentlyContinue
```

Vorher den Server beenden (Strg+C), sonst ist die Datenbank gesperrt.

## 2. Prüfen

| Befehl | Dauer | Was es prüft |
|---|---|---|
| `npm run typecheck` | ~10 s | Typfehler im ganzen Projekt |
| `npm test` | ~20 s | alle Unit-Tests (Server, Regeln, Accounts, Admin) |
| `npm run smoke` | ~1 min | klickt die wichtigsten Seiten im Browser durch |
| `npm run e2e` | ~10–15 min | alle Browser-Tests (braucht Edge oder Chrome) |

Einzelne Testdatei:

```powershell
node --test test/admin.test.ts
node --test test/e2e/accounts.e2e.ts
```

Screenshots der Browser-Tests liegen danach in `test/e2e/artifacts/`.

## 3. Veröffentlichen

```powershell
npm run release patch    # 1.0.1 → 1.0.2  (Fehlerbehebungen)
npm run release minor    # 1.0.2 → 1.1.0  (neue Funktionen)
npm run release major    # 1.1.0 → 2.0.0  (große Umstellung)
```

Geht nur auf `master` und ohne offene Änderungen. Prüft Typecheck, Tests und Smoke-Test, setzt den Versions-Tag und
pusht. GitHub baut daraus das Image, Ditto holt es sich innerhalb von ~2 Minuten.

## 4. Auf Ditto (Server)

```bash
cd ~/docker/services
```

| Befehl | Was es macht |
|---|---|
| `docker exec oeffi-guesser printenv APP_VERSION` | welche Version läuft |
| `docker logs oeffi-guesser --tail 50` | letzte Meldungen des Servers |
| `docker logs oeffi-guesser 2>&1 \| grep -i mail` | läuft der Mailversand? |
| `bash ~/docker/services/bimguesser/update.sh --now` | neue Version sofort holen (ohne auf Spielende zu warten) |
| `tail -20 ~/docker/services/bimguesser/update.log` | was das automatische Update zuletzt gemacht hat |
| `docker compose up -d oeffi-guesser` | neu starten, z.B. nach Änderungen an `compose.yml` oder `.env` |
| `docker exec oeffi-guesser node server/admin-cli.ts grant <Name>` | Admin machen (auch `list`, `revoke <Name>`) |

Ist ein Update als kaputt markiert und soll trotzdem nochmal versucht werden:

```bash
rm -f ~/.oeffi-update/bad
bash ~/docker/services/bimguesser/update.sh --now
```

### Backup der Accounts

```bash
docker exec oeffi-guesser sh -c "rm -f /app/state/backup-accounts.db && node -e \"new (require('node:sqlite').DatabaseSync)('/app/state/accounts.db').exec(\\\"VACUUM INTO '/app/state/backup-accounts.db'\\\")\""
```

Die Kopie liegt dann in `~/docker/services/bimguesser/state/backup-accounts.db`.

## 5. Daten neu bauen (selten)

| Befehl | Wann |
|---|---|
| `npm run build:data` | Liniennetz und Stationen neu laden (`data/network.json`) |
| `npm run build:timetable` | neuer Fahrplan aus den GTFS-Dateien (`data/timetable.json`) – spätestens bis **12.12.2026** (Lizenz) |
