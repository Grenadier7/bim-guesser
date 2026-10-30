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

3. Seite neu laden → Account-Fenster → **🛠 Admin-Bereich öffnen** → mit dem eigenen Passwort entsperren
   (mindestens 10 Zeichen, sonst erst unter „Passwort ändern“ ein längeres setzen). Nach 30 min ohne Klick sperrt er sich wieder.

| Befehl | Was es macht |
|---|---|
| `npm run admin -- list` | alle Admins anzeigen |
| `npm run admin -- grant <Name>` | zum Admin machen |
| `npm run admin -- revoke <Name>` | Admin-Rechte nehmen |

Was es im Admin-Bereich gibt:

| Reiter | Inhalt |
|---|---|
| Übersicht | Besucher (mit/ohne Account), Spiele, meistgewählte Linien, offene Lobbys steuern |
| Accounts | suchen, sperren, Passwort-Link, umbenennen, Statistik je Account |
| Netzpläne | **Fahrplan** (jede Linie: Halte, Fahrzeiten, Abfahrten, Takt – direkt ändern; „wie gebaut“ zeigt das Original), **Änderungen** (Liste, einzeln löschen), **Karte**, **Probe** (Route testen), **Plan** (Name, in der Lobby wählbar, Versionen) |
| Einstellungen | Uhrzeiten, Netz-Auswahl, Was zählt?, Joker, Schwierigkeit, Standard-Einstellungen, Haltestellen-Auswahl, Adressen, Chat-Moderation, Hinweis für alle |
| Protokoll | wer hat wann was geändert |

Jede Änderung an Netzplänen und Einstellungen wird als Version gespeichert und lässt sich zurückholen.

### Lokale Daten zurücksetzen

Accounts, Netzpläne, Einstellungen und Statistik liegen lokal in `data/` (nicht in Git):

```powershell
Remove-Item -Recurse data/accounts.db*, data/config, data/usage.json -ErrorAction SilentlyContinue
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

### Sicherung (Backup)

`backup.sh` sichert Accounts, Netzpläne und Einstellungen nach `~/backups/bimguesser/` – ein Ordner, den der Container
**nie** sieht. Auch ein Admin (oder jemand, der eine Lücke im Server findet) kommt so nicht an die Sicherungen.
Behalten werden die letzten 14 Tage und je Woche eine für 12 Wochen.

Einmal einrichten (Skript neben `update.sh` legen, dann in `crontab -e` diese Zeile dazu):

```bash
30 4 * * * bash ~/docker/services/bimguesser/backup.sh >> ~/docker/services/bimguesser/backup.log 2>&1
```

| Befehl | Was es macht |
|---|---|
| `bash ~/docker/services/bimguesser/backup.sh` | jetzt sofort sichern |
| `ls ~/backups/bimguesser` | vorhandene Sicherungen |
| `tail -5 ~/docker/services/bimguesser/backup.log` | was die letzte Sicherung gemacht hat |

**Den Ordner `~/backups` nie in `compose.yml` als Volume eintragen.**

Zurückspielen (Beispiel: Sicherung vom 2026-10-30 04:30):

```bash
docker stop oeffi-guesser
cd ~/docker/services/bimguesser/state
mv accounts.db accounts.db.kaputt; rm -f accounts.db-wal accounts.db-shm
cp ~/backups/bimguesser/2026-10-30_0430/accounts.db . && chmod 600 accounts.db
tar -xzf ~/backups/bimguesser/2026-10-30_0430/config.tar.gz   # nur wenn auch Netzpläne/Einstellungen zurück sollen
docker start oeffi-guesser
```

## 5. Daten neu bauen (selten)

| Befehl | Wann |
|---|---|
| `npm run build:data` | Liniennetz und Stationen neu laden (`data/network.json`) |
| `npm run build:timetable` | neuer Fahrplan aus den GTFS-Dateien (`data/timetable.json`) – spätestens bis **12.12.2026** (Lizenz) |
