# BimGuesser Wien

Quiz: Du bekommst zwei zufällige Wiener Haltestellen und musst die schnellste Öffi-Verbindung erraten –
Linie für Linie. Danach zeigt die Karte die tatsächlich schnellsten Verbindungen laut Wiener-Linien-Auskunft.

## Starten

```bash
npm install
```

```bash
npm run build:data
```

```bash
npm run dev
```

Danach <http://localhost:5173> öffnen. `build:data` lädt das GTFS (~90 MB) und braucht ca. 1–2 Minuten.
Wenn sich der Fahrplan ändert (spätestens zum Fahrplanwechsel im Dezember), neu ausführen (`npm run build:data -- --refresh`).

Produktion: `npm start` baut den Client, startet den Server (Port 3000) und öffnet – falls in `.env`
eingetragen – automatisch den ngrok-Tunnel. `npm run serve` startet nur den Server ohne Build und ohne Tunnel.

### Online spielen mit ngrok

1. Konto auf ngrok.com, `winget install ngrok.ngrok`, dann `ngrok update` (winget liefert eine zu alte Version)
2. `ngrok config add-authtoken <TOKEN>` (Token aus dem ngrok-Dashboard)
3. `.env.example` nach `.env` kopieren und die eigene Adresse aus dem Dashboard (Domains) eintragen:
   `NGROK_URL=https://dein-name.ngrok-free.dev`
4. `npm start` – die öffentliche Adresse wird in der Konsole angezeigt. Beenden mit Strg+C.

Optionen: `npm start -- --local` (ohne Tunnel), `npm start -- --no-build` (ohne neu zu bauen).

Optional mit Passwort (empfohlen, wenn der Link öffentlich herumgeht) – in `.env`:
`NGROK_PASSWORD=mindestens-8-zeichen` (Benutzer: `wien`, änderbar mit `NGROK_USER`).
Der Browser fragt dann beim Öffnen nach Benutzer und Passwort.

## Sicherheit

- **Spieler-Token:** Jeder Spieler bekommt beim Erstellen/Beitreten einen geheimen Token (nur im eigenen Tab
  gespeichert). Alle Aktionen, der Spielzustand und der Live-Kanal brauchen ihn; die für alle sichtbare
  Spieler-ID berechtigt zu nichts. Der Lobby-Code erlaubt nur das Beitreten, solange die Lobby offen ist.
- **Rate-Limits pro IP** (`server/security.ts`): 10 neue Lobbys / 10 min, 12 Spielstarts / 10 min,
  30 Beitritte / 10 min, 600 API-Aufrufe / min, max. 20 Live-Verbindungen pro IP und 3 pro Spieler.
  Zusätzlich max. 100 Lobbys gleichzeitig und max. 4 parallele Anfragen an die Wiener-Linien-API.
- **Eingaben:** Namen ohne HTML/Steuerzeichen (max. 20 Zeichen), Einstellungen nur aus erlaubten Werten,
  Request-Body max. 20 KB, Fehlermeldungen ohne interne Details.
- **Header:** Content-Security-Policy (nur eigene Skripte), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- Über ngrok wird nur Port 3000 (dieser Server) freigegeben – sonst nichts von deinem PC.

## Modi

Die Startseite zeigt vier Modi als Kacheln. Unten gibt es **„Mit Code beitreten“** – der Code führt automatisch
in die richtige Lobby (Routenjagd oder Quiz).

**🎓 Tutorial** (für Neue, `client/src/screens/tutorial.ts`): oben ein Hinweis, unten eine Karte – bis man es gemacht
oder 2 normale Spiele (Routenjagd-/Quiz-Endstand, Training) abgeschlossen hat (`client/src/progress.ts`). Zwei
geführte Runden mit echter Auskunft und Wertung: Praterstern → Stephansplatz (U1 eintippen, Ausstieg wählen),
Reumannplatz → Rathaus („Rathaus ist doch U2“ → U2 fährt dort nicht → U1 bis Karlsplatz, U2 bis Rathaus). Sprechblasen
zeigen den nächsten Schritt und heben das passende Feld hervor; danach die Punktevergabe.

| Modus | Spieler | Worum geht's |
|---|---|---|
| 🏁 **Routenjagd** | Lobby, 1–12 | Schnellste Öffi-Verbindung zwischen zwei Stationen finden |
| 🏋️ **Training** | allein | Echte Strecken mit Coach, Hilfen und Erklärung |
| 📚 **Lernen** | allein | Lernpfad (Kurse), Netzkarte mit Linien-Steckbriefen, gemerkte Linien üben |
| 🧠 **Quiz** | Lobby, 1–12 | Fragen zu Stationen, Linien, Umstiegen – Punkte für richtig und schnell |

### Quiz

- Fragetypen: 📍 Wo liegt …? · 🎯 Direktverbindung (welche Linie fährt ohne Umsteigen von A nach B?) ·
  🧭 Richtung (welche Linie fährt von hier nach X?) · 🔀 Umstieg (wo kann man von X in Y umsteigen?) ·
  🚇 U-Bahn-Kreuzung (an welcher U6-Station kreuzt die 43?) · 🔗 Querverbindung (welche Linie verbindet U1 und U2?) ·
  🚏 Linien an der Station (mehrere) · ↔️ Endstationen · 〰️ Linie erkennen · ✏️ Linie zeichnen (Verlauf von
  Endstation zu Endstation antippen, doppelte Zeit) · 🏘️ Bezirk · ➡️ Nächste Station · 🔢 Busnummer (in welchem
  Bezirk fährt der 76A? – nur mit Bussen).
- Standard ohne Busse (U-Bahn, S-Bahn, Bim) – mit Bussen wären drei Viertel aller Linien und Stationen Busse.
- Einstellungen: Anzahl Fragen, Zeit pro Frage, Gebiet (Bezirk, wird auf der Karte eingefärbt), Verkehrsmittel;
  unter „Fragetypen & Häufigkeit“ je Typ ein Regler mit 7 Stufen (1 = gar nicht, 4 = normal, 7 = sehr häufig)
  und „↺ Standard-Häufigkeiten“.
- Umstiegsfragen mischen falsche Antworten von beiden Linien; in der Auflösung werden beide Linien gezeichnet.
  Nach „In welchem Bezirk …?“ zeigt die Auflösung alle Linien, die dort abfahren.
- „Linie zeichnen“ wird am Server bewertet: Anteil der Stationen nahe der Zeichnung (abzüglich dessen, was eine
  gerade Linie schon träfe) und Anteil der Punkte, die auf der Linie liegen.
- Fragen werden am Server erzeugt und bewertet (`shared/quiz.ts`): richtig = 500–1000 Punkte je nach Tempo;
  „Linie zeichnen“ zählt nur die Genauigkeit (bis 1000), nicht das Tempo. „Wo liegt …?“ gibt Teilpunkte nach Entfernung (voll bis 200 m, 0 ab 3 km), Mehrfachauswahl Teilpunkte
  (falsche ziehen ab). Mehrdeutige Antworten (z.B. S1/S2) werden vermieden. Nur reguläres Netz: keine
  Sonderlinien (71E, 26E) und keine Halte aus Sonderführungen.
- Host: Pause, Frage überspringen, Jetzt auflösen, Spiel beenden.

## Accounts

Oben rechts **👤 Anmelden** – ohne Account geht alles wie bisher. Mit Account:

- **Registrieren/Anmelden** mit Benutzername (oder E-Mail) und Passwort; man bleibt 180 Tage angemeldet (Cookie,
  verlängert sich bei Benutzung). Der Name wird beim Erstellen/Beitreten automatisch eingetragen, in Lobbys steht
  👤 neben Spielern mit Account (antippen = Profil).
- **Spielstand auf allen Geräten**: Lernpfad, gemerkte Linien, Lernstand, Tutorial, Trainings-Wiederholungen und
  Einstellungen. Beim Anmelden auf einem Gerät wird der Browser-Stand mit dem Account zusammengeführt (Fortschritt
  geht nie verloren), danach gilt der Account (`client/src/account.ts`, `client/src/boot.ts`).
- **Level & XP**: Runde 5 + Punkte/20, Routenjagd 20 (+30 Sieg), Quiz 10 + Punkte/50 (+20 Sieg), Trainingsstrecke
  10–20, Kurs 40 (+60 gemeistert), Tutorial 50. Level 2 bei 100 XP, jedes weitere Level 50 XP mehr.
- **Medaillen** (14): z.B. Volltreffer (1000 Routenpunkte), Schneller als die Bestzeit, Volle 1300, Sieger, Quiz-Ass,
  Netzkenner/Netzmeister (Lernpfad), Gesellig (3 Freunde) – neue werden gemeldet.
- **Statistik & Lieblinge**: Spiele, Siege, Ø Routenpunkte, Zeit in Öffis, Kurse; Lieblingslinie je U-Bahn/S-Bahn/
  Bim/Bus und Lieblingsstation. Gezählt wird die *bewusste Wahl*: Gab es an der Einstiegsstation keine andere Linie
  (92B ab Frachtenbahnhof Lobau), zählt die Fahrt nur 0,15 – mit Alternativen (95A statt 93A am Großen Biberhaufen)
  voll. Für die Lieblingsstation zählen nur Umstiege (Start und Ziel sind vorgegeben).
- **👥 Leute** (alle Accounts, Suche) mit **Freundschaftsanfragen**; Profile zeigen Level und Medaillen, Statistik,
  Lieblinge und Online-Status nur Freunden.
- **📨 Freunde einladen** in der Lobby (einzelne oder alle): Die Eingeladenen sehen oben ein Banner mit „Beitreten“,
  sobald sie die Seite offen haben bzw. öffnen (Abfrage alle 20 s).
- **Passwort vergessen** per E-Mail (Link 1 Stunde gültig, meldet alle Geräte ab). Braucht `SMTP_URL` (+ `MAIL_FROM`)
  und die öffentliche Adresse `PUBLIC_URL` (oder `NGROK_URL`/`NGROK_DOMAIN`); Links werden nie aus dem Host-Header
  gebaut. Lokal mit `docker compose up` fängt **Mailpit** alle Mails ab: http://localhost:8025. Ohne Mailserver zum
  Testen: `MAIL_FILE=data/mails.jsonl`.
- **Rechtliches** (Fußzeile der Startseite, Links wie `/#impressum`, `/#datenschutz`, `/#regeln`, `/#quellen`):
  Impressum (§ 5 ECG, § 25 MedienG), Datenschutzerklärung (DSGVO), Nutzungsregeln, Quellen & Lizenzen. Angaben zum
  Betreiber auf der Admin-Seite (Einstellungen → Impressum & Datenschutz); fehlen sie, warnt die Admin-Übersicht.
  Kontakt-E-Mail: die dort eingetragene, sonst `CONTACT_EMAIL`, sonst die Adresse aus `MAIL_FROM`. Die kurze Fassung
  steht weiter im Account-Fenster.
- **Account löschen** (⚙️, mit Passwort bestätigt): löscht sofort alles – Spielstand, Statistik, Medaillen,
  Freundschaften, Einladungen, Sitzungen; der Name ist danach wieder frei.

Technik: `server/accounts.ts` (SQLite über `node:sqlite` in `STATE_DIR/accounts.db` – im Container im State-Volume,
also mitsichern), Passwörter mit Argon2id (`node:crypto`, braucht Node ≥ 24.7), Sitzungs- und Reset-Tokens nur als
SHA-256 gespeichert. Ändernde Account-Anfragen nur als JSON (Schutz gegen fremde Seiten), eigene Rate-Limits für
Anmelden/Registrieren/Passwort vergessen. Statistik-Fehler stören nie ein laufendes Spiel.

## Admin

Admin-Rechte gibt es **nur über die Kommandozeile** (wer Zugriff auf den Server hat, entscheidet):

```bash
npm run admin -- grant <Benutzername>          # lokal (auch: list, revoke <Name>)
docker exec oeffi-guesser node server/admin-cli.ts grant <Benutzername>   # im Container
```

Danach gibt es im Account-Fenster „🛠 Admin-Bereich öffnen“ (außerhalb einer Lobby). Er muss je Sitzung mit dem
eigenen Passwort **entsperrt** werden (mind. 10 Zeichen) und sperrt sich nach 30 min ohne Aktion bzw. spätestens nach 8 h.
Admins können andere Admins nicht ändern; Namen wie „admin“ oder „spielleitung“ sind für Spieler gesperrt; nach
5 falschen Passwörtern ist ein Name 15 min gesperrt.

- **Übersicht**: Kennzahlen, Grafiken (Besucher online mit/ohne Account, Besucher je Tag, fertige Spiele, meistgewählte
  Linien, Spieler in Lobbys, Accounts je Tag; Zeitraum 1/7/30/90 Tage, Tooltips, Tabellenansicht) und alle Lobbys –
  verwalten wie vom Host: starten, pausieren/fortsetzen, Runde abbrechen, weiter, beenden, Spieler entfernen,
  Host-Rechte vergeben, als „Spielleitung“ in den Chat schreiben. Besucher werden über eine zufällige Kennung je
  Browser gezählt (`/api/ping`, kein Bezug zur Person).
- **Accounts**: suchen, alles sehen (inkl. Verlauf als Grafik), Passwort setzen, **Link zum Zurücksetzen** (1 h),
  auf allen Geräten abmelden, Statistik zurücksetzen, umbenennen, E-Mail ändern, löschen.
- **Netzpläne**: „Standard“ (gilt für Spiele, Training, Quiz und Lernen) plus beliebig viele eigene Pläne, die in der
  Lobby unter „Netz“ wählbar sein können (mit eigener Karte). Dazu die Kachel **LIVE Aktuell**: welche echten Tage
  gespielt werden, je Linie wie sie anders fährt (Endstellen, ausgelassene/zusätzliche Halte – aus den Fahrplandaten)
  und wie lange (Betriebsmeldungen der Wiener Linien, live, 10 min zwischengespeichert), Name, Erklärung, an/aus. Je Plan:
  - **Fahrplan** – alle Linien (U, S, Regionalzüge mit Halt in Wien, Bim, Bus, Nachtbus) mit Halten, Fahrzeiten,
    Abfahrten je Tagestyp und Takt; direkt änderbar (Fahrzeit, Halt auslassen/einfügen, Abfahrten streichen/dazu,
    Takt je Zeitraum – vorbelegt mit dem Takt, der jetzt fährt). Änderungen stehen direkt im Fahrplan (neu grün, weggefallen durchgestrichen, Fahrzeit mit
    „vorher“, je Linie Liste mit „↺ rückgängig“); „Original anzeigen“ zeigt den Fahrplan ohne Änderungen.
  - **Änderungen** – verlängern, kürzen, Fahrzeit, Stationen anlegen/umbenennen/verschieben/entfernen, Linien
    anlegen/entfernen, Takt, Zusatzfahrten auf Teilstrecken (z.B. jede 2. S1 nach Hütteldorf), Halt einfügen/auslassen.
  - **Karte** – das Netz des Plans; **Probe** – Route mit Details berechnen; **Plan** – Name, Erklärung, Parameter
    (Umsteigezeit, Fußwege, …), Versionen zum Zurückholen.
- **Einstellungen**: Hinweis für alle, **Impressum & Datenschutz** (Name, Anschrift, E-Mail, Zweck, Hosting – stehen
  öffentlich im Impressum), Uhrzeiten (1–8, hinzufügen/entfernen/sortieren), Netz-Auswahl, Was zählt? (je Wertung
  Name, Symbol, Erklärung, Kurztext; „Umstiege vermeiden“ mit Aufschlag, an/aus), Joker und ihr Abzug,
  Schwierigkeit und Punkte-Faktoren, Standard-Einstellungen aller Lobbys, Haltestellen-Auswahl (welche Stationen
  „wichtig“/„alle“ sind – per Klick), Adressen (alle auf der Karte: anklicken = ausnehmen/aufnehmen, leere Stelle =
  neue Adresse), Chat-Moderation (Wortliste in Deutsch, Englisch, Türkisch, Serbisch/Kroatisch/Bosnisch).
- **Protokoll**: jede Admin-Aktion mit Zeit, Admin und Ziel.

Netzpläne und Einstellungen liegen in `STATE_DIR/config/` (jede Änderung als Version in `config/history/`).
**Sicherung**: `deploy/backup.sh` läuft auf dem Host und legt Kopien in einem Ordner ab, den der Container nie sieht –
siehe `BEFEHLE.md`.

## Eigener Referenzfahrplan (GTFS)

Für „Regulär“ sucht der Server Verbindungen selbst (`server/timetable.ts`, RAPTOR) auf einem Auszug der offiziellen
Fahrplandaten (`data/timetable.json`). Vorteile gegenüber der Wiener-Linien-Auskunft: auch **Regionalzüge** (R, REX,
CJX – sie zählen auf S-Bahn-Abschnitten wie eine S-Bahn, z.B. S80/R81/REX8 zwischen Simmering und Stadlau, das halbiert
dort die Wartezeit), keine Abfragen (Spielstart in Sekundenbruchteilen) und kein Referenztag, der aus der Auskunft
verschwindet. Railjets/IC/WESTbahn zählen nicht. Für „Aktuell“ fragt der Server weiter die Auskunft.

- Daten: data.mobilitaetsverbuende.at (Registrierung nötig) – „Timetable Data PTA Eastern Region (GTFS)“ nach
  `data/raw/timetables/`, „Railway Timetable Data (GTFS) – Reference Data for Timetable Changeover“ nach
  `data/raw/timetables-trains/` entpacken (beides nicht im Repo), dann `npm run build:timetable`. Das baut den Auszug
  für die drei Referenztage aus `data/network.json` (nur Wien, nur Linien des Spiels + Nahverkehrszüge, Nachtfahrten
  vom Vortag). Regionalzüge sind **keine eigenen Linien** im Routen-Baukasten: in Wien fahren sie nur auf
  S-Bahn-Abschnitten mit (jeder Abschnitt hat auch eine S-Bahn) – wer dort die S-Bahn wählt, bekommt ihre Abfahrten
  automatisch mitgezählt, die Top-Verbindungen zeigen sie als „S80/R81/REX8“. Ergänzungen zum normalen Netz:
  S40 wieder ab Franz-Josefs-Bahnhof (Fahrzeiten 2024), 18 bis Stadion, 43 bis Neuwaldegg und 46 bis Parlament
  (am Referenztag Baustellen, siehe `scripts/build-timetable.ts`).
- Suche: Fußwege zwischen Halten bis 500 m, von/zu Adressen bis 1,5 km (Luftlinie × 1,3, 80 m/min), Umsteigen 2 min,
  bis 4 Umstiege. Abgeglichen mit der Auskunft: bei gleicher Abfahrt gleiche Ankunft; die eigene Suche findet nie eine
  langsamere Verbindung (sie geht manchmal lieber 400 m zu Fuß, wo die Auskunft auf einen Bus wartet).
- Abschalten: `TIMETABLE=off` (dann alles über die Auskunft, wie früher).
- **Lizenz** (Datenlizenz Mobilitätsverbünde Österreich): Namensnennung „Datenquelle: Mobilitätsverbünde Österreich
  OG – data.mobilitaetsverbuende.at“ (steht in der Kartenzeile). Die Daten gelten bis zum Fahrplanwechsel
  (`validUntil` in `data/timetable.json`); danach dürfen sie laut Abschnitt 6a/7d nicht mehr in öffentlich
  zugänglichen Auskunftssystemen verwendet werden (Vertragsstrafe!). Ohne schriftliche Zustimmung also jedes Jahr nach
  dem Fahrplanwechsel neue Daten laden und neu bauen – der Server warnt beim Start und unter `/api/health`, sobald der
  Auszug abgelaufen ist.

## Routenjagd

1. Auf der Startseite **🏁 Routenjagd** wählen (erstellt eine Lobby, auch alleine) oder **mit Code beitreten** – der Einladungslink `?code=XXXXX` füllt den Code automatisch aus.
2. In der Lobby stellt der Host alles ein. Sichtbar sind nur Schwierigkeit, Runden, Zeitlimit und „Wo liegt das?“;
   Erklärungen stecken hinter einem **ⓘ** (Maus drüber / antippen). „⚙️ Erweitert“ hat drei Reiter –
   **🎯 Schwierigkeit** (Haltestellen, Entfernung, Min. Umstiege), **📏 Regeln** („Was zählt?“, Tipps,
   🏆 Challenges, **⚡ X-treme**-Kachel), **🕒 Zeit & Netz** (Uhrzeit, Netz, Fokus-Gebiet). ↺ in der Überschrift setzt alles zurück.
   Mit X-treme heißt der Knopf „⚡ X-TREME starten“.
   Im Einzelnen:
   - **Uhrzeit** (unter „Erweitert“): Mo–Fr 12 Uhr, Mo–Fr 17 Uhr, Sa 2 Uhr (Nacht), So 12 Uhr
   - **Netz**: *Regulär* = Referenztag ohne Baustellen, aus dem **eigenen Referenzfahrplan** (siehe unten) – mit
     Regionalzügen (R, REX, CJX), ganz ohne Abfrage bei der Auskunft · *Aktuell* = nächster echter Tag inkl. Sperren
     (Wiener-Linien-Auskunft).
     Referenztage derzeit **Di 30.6., Sa 27.6., So 28.6.2026** (`PREFERRED_DAYS` in `scripts/build-network.ts`):
     nur Ende Juni fährt die S-Bahn-Stammstrecke (ab ca. 8.7. bis mindestens Dezember gesperrt) und Bim/Bus sind
     fast im Normalbetrieb. Ohne passende Wunschtage sucht das Build-Skript selbst (Tag ohne Ersatzverkehr, mit
     funktionierenden S-Bahn-Testverbindungen, ohne Ferien/Feiertage). Achtung: Die Auskunft hält nur einige
     Monate Vergangenheit vor – laufen die Referenztage aus, neue wählen und `npm run build:data` ausführen.
   - **Schwierigkeit**: Schnellwahl Leicht / Mittel / Schwer / Profi – oder selbst mit drei Reglern:
     *Haltestellen*: vier Kästchen (🚇 U-Bahn · 🚆 S-Bahn · 🚋 Bim · 🚌 Bus) zum An-/Ausschalten, darunter je ein
     kleiner senkrechter Regler für die Stufe: U/S/Bim *Wichtige* (Endstellen, Umstiege, Stammstrecke, bekannte
     Stationen – U 60/99, S 31/49, Bim 264/411) oder *Alle*; Bus *Knoten* (3+ Linien) · *Viele* (2+) · *Alle*.
     Leicht = wichtige U + S, Mittel = alle U + S, Schwer = + alle Bim, Profi = + alle Bus-Haltestellen;
     der Multiplikator richtet sich nach der schwierigsten Art,
     *Entfernung* (2–7 / 3–12 / 6–16 km) und *Min. Umstiege* (Regler 0–2: so viele Umstiege hat die beste Verbindung
     mindestens; Leicht 0, Mittel 1, Schwer/Profi 2). Der Punkte-Multiplikator (×0,85–1,69) ergibt sich daraus.
   - **Fokus-Gebiet**: Kreis auf der Karte (antippen oder Bezirk als Mittelpunkt wählen), Radius 1,5–6 km.
     10–90 % der Stationen werden aus dem Kreis gezogen, der Rest aus ganz Wien. Standardmäßig aus.
   - **Runden**: 3 / 5 / 7 / 10
   - **Zeitlimit** 1–10 min oder „∞ Ohne“ in einer Leiste (Standard 4:00) – nach Ablauf wird abgegeben, was eingegeben ist
   - **Wo liegt das?** – Start und Ziel vorher auf der leeren Karte tippen
   - **⚖️ Was zählt?** (unter „Erweitert → Regeln“) – Punkte, Ranking und die Top-Verbindungen richten sich danach:
     *🧭 Realistisch* (Standard) – Tür zu Tür mit Ø-Wartezeiten (siehe unten), dazu wahlweise **Umstiege vermeiden**
     (+2 min je Umstieg, Standard aus) · *🕐 Wie die Auskunft* – Tür zu Tür ab der Abfragezeit mit echten Abfahrten
     (6 Zeitpunkte, Median; ein knapper Anschluss ist Glück) · *🚇 Nur Fahrzeit* – ab dem Einsteigen, echte Abfahrten,
     Warten am Start egal. Intern sind das drei Werte (`countWait`, `avgWait`, `goal`); andere Kombinationen aus
     älteren Links zeigt die Lobby als „eigene Kombination“, bis man einen Modus wählt.
   - **⚡ X-treme** (unter „Erweitert“, doppelte Zeit, im Spiel mit Banner): *Ohne Vorschläge* – Ein- und Ausstieg
     selbst eintippen (Auto-Vervollständigung über alle Stationen), keine Route auf der Karte, nur Start und Ziel ·
     *Ohne Namen* – zusätzlich Start/Ziel nur als Punkte · *Ohne Karte* – zusätzlich nichts auf der Karte, nur die
     Namen. Bei „ohne Namen“/„ohne Karte“ ist „Wo liegt das?“ aus.
   - **Ø-Wartezeiten** (bei *Realistisch*) – jede Linie zählt mit ihrer mittleren Fahrzeit, jeder
     Umstieg mit Umsteigeweg + der erwarteten Wartezeit auf die nächste Linie (für jede Ankunftsminute der folgenden
     Stunde die Zeit bis zur nächsten echten Abfahrt, gemittelt – stimmt auch bei unregelmäßigem Takt; gleichwertige
     Linien wie S1–S4 auf der Stammstrecke zählen zusammen). Ein zufällig perfekter Anschluss bringt so keinen
     Vorteil; eine S7 alle 30 min kostet im Schnitt 15 min. Bei der allerersten Linie zählen nur 70 % der Ø-Wartezeit
     (35 % des Takts) – zur ersten Abfahrt kann man sich die Zeit meist einteilen. Das gilt nur, wenn sie direkt
     an der Start-Station abfährt; muss man erst zu einer anderen Haltestelle gehen, zählt die volle Ø-Wartezeit. Die Routendetails zeigen die Wartezeit je Umstieg.
   - **🏆 Challenges** (früher Einschränkungs-Runden) – Nie / Manchmal (ca. 30 %, mindestens eine pro Spiel) / Immer: ohne U-Bahn,
     ohne Bus, max. 1 Umstieg oder **Linie gesperrt** (eine Linie der schnellsten Verbindung, z.B. „Ohne Linie U6“).
     Diese Runden haben doppelte Zeit, höchstens +2:30 – „Ohne U-Bahn“ bekommt fix +4:00.
   - **💡 Tipps** – Keine / Günstig / Teuer (günstig 5 Prozentpunkte billiger, teuer 20 teurer; bei X-treme immer teuer):
     Linien am Start / am Ziel, Verkehrsmittel-Kette, Umstiegsorte. Bei X-treme „ohne Namen“ zeigen die Tipps keine
     Stationsnamen, beim Umstiegs-Tipp nur „U6 ⇄ S1“; „ohne Karte“ zeichnet nichts ein. Keine Fußweg-Entfernungen.
   - **Route eingeben**: Linie wählen → Einstieg (nächstgelegene Haltestelle, ggf. mit Fußweg) → Ausstieg. Die
     Ausstiegs-Liste zeigt die ganze Linie von der nördlicheren Endstation nach unten zur anderen (z.B. U1 Leopoldau …
     Oberlaa), die Einstiegs-Station steht markiert und nicht wählbar mittendrin.
     Hält die Linie an der Station nur in eine Richtung (Schleifen/Einbahnen, z.B. 40 bei Schöffelgasse), wird die
     Gegenrichtung ab der nächsten Haltestelle (bis 700 m) angeboten – inkl. Fußweg dorthin.
   - **📍 Start & Ziel** (Erweitert → Schwierigkeit): *Haltestellen* oder *Adressen* – zufällige echte Adressen
     (Stadt Wien, OGD), gleichmäßig über die bebaute Fläche verteilt (400-m-Raster, höchstens 3 je Zelle, nur bis
     1,5 km von einer Haltestelle; `node scripts/build-addresses.ts` → `data/addresses.json`). Die Auskunft rechnet
     ab der Koordinate, also inkl. Fußweg zur ersten Haltestelle. Punkte ×1,5 (mehr als mit allen Haltestellen), die
     Haltestellen-Auswahl ist dann ausgeblendet und die Schwierigkeit steht auf „Eigene“ – eine Schnellwahl (Leicht …
     Profi) stellt wieder auf Haltestellen.
   - **⇅ Einstellungen teilen** (neben ↺): Link öffnet eine neue Lobby mit genau diesen Einstellungen; JSON zum
     Kopieren und Einfügen.
   - **Abwechslung**: Innerhalb eines Spiels liegen neue Start/Ziele mindestens 1,2 km von allen bisherigen entfernt,
     und keine Strecke mit beiden Enden in derselben Gegend wie eine frühere. Über alle Spiele hinweg werden Stationen,
     die schon oft dran waren, seltener gezogen (Zähler in `data/usage.json`).
   - **Beitreten** geht jederzeit, auch während des Spiels (Einladungslink öffnet oben eine Einladungs-Karte).
3. Eine Runde wird aufgelöst, sobald alle (verbundenen) Spieler abgegeben haben, das Zeitlimit abläuft
   oder der Host „Jetzt auflösen“ drückt. Der Host schaltet zur nächsten Runde und kann am Ende
   mit denselben Spielern zurück in die Lobby.
4. **Auflösung**: Auf der Karte ist nur die beste und die eigene Route kräftig, alle anderen sind blass ohne
   Beschriftung – antippen (oder drüberfahren) hebt eine hervor. Sofort sichtbar sind die 3 besten Verbindungen,
   weitere auf Wunsch. Die Mitspieler-Liste lässt sich aufklappen (Route im Detail + Punkte). Mit Ø-Wartezeiten zeigt
   jede Route den **berechneten Zeitplan** (Gehen, Ø-Warten, Fahrt, Umsteigen) – genau die Minuten, die gewertet werden.
   **Fußwege**: Luftlinie × 1,3 bei 80 m/min (≈ 4,8 km/h), Umsteigen an derselben Station 2 min.
5. **Host-Steuerung** während der Runde: ⏸ Pause (Zeit steht, alle sehen eine Pause-Anzeige, Pausenzeit zählt
   nicht zur benötigten Zeit), ✖ Runde abbrechen (Lösung wird gezeigt, keine Punkte), ⏹ Spiel beenden.
   Unter „👥 Spieler“ (Lobby und laufendes Spiel): ✕ kicken, 👑 zum Host machen – es kann mehrere Hosts geben.
   **💬 Lobby-Chat** unten rechts – `/ez` schickt statt der Nachricht einen zufälligen Spruch (`server/ez.ts`).
6. **Inaktive Lobby**: nach 9 min ohne Aktion fragt ein Fenster die Hosts „Lobby behalten?“ (30 s). Keine Antwort →
   der nächste verbundene Spieler wird Host und gefragt; antwortet niemand oder „Lobby löschen“ → Lobby wird
   geschlossen (`LOBBY_IDLE_MS`, `LOBBY_IDLE_ANSWER_MS`).

**Training** (Startseite, ohne Lobby): echte Strecken ohne Zeitdruck und Punkte – zum praxisnahen Lernen.
- *Coach*: nach jeder Teilstrecke Rückmeldung – „genau wie die schnellste Verbindung“, „richtige Linie, aber falsche
  Richtung – fahr Richtung …“, „richtige Linie, aber steig bei … aus“, „damit entfernst du dich vom Ziel“. Beim Wählen
  einer Linie erklärt er, wohin sie von hier fährt.
- *🚏 Was fährt hier ab?* an der aktuellen Station: alle Linien mit Richtungen (antippen = Linie übernehmen).
- *Gestufte Hilfen*: Richtung → Verkehrsmittel → erste Linie → Umstiege → Lösung.
- *Auswertung*: Vergleich mit der schnellsten Verbindung und **warum** sie schneller ist (Umstiege, Fußwege,
  Wartezeit, Fahrzeit), Merksatz zum Merken (📌 Merkliste).
- *Wiederholung*: nicht gelöste Strecken (oder mit 3+ Hilfen) kommen 3 Strecken später nochmal.
- Gleichwertige Linien (S1/S2/S3 auf der Stammstrecke, 30/31 zwischen Brünner Straße und Floridsdorf) zählen
  beim Coach und in der Wertung gleich.
- Einstellungen: Uhrzeit, Schwierigkeit, Gebiet (Ganz Wien oder Schwerpunkt-Bezirk, wird eingefärbt), Coach an/aus. Endpunkte: `POST /api/training/round`,
  `POST /api/training/:id/evaluate`.

**Lernmodus** (Startseite, ohne Lobby) – drei Einstiege, keine Einstellungen vorab:
- *🎓 Lernpfad*: die geführten Kurse in fester Reihenfolge („Weiter mit …“): U-Bahn-Kreuzungen → S-Bahn
  (Stammstrecke, Äste S1/S2/S3+S4, S7, S40/S45/S50, S60/S80) → Radiallinien → die Ringe → Querverbindungen →
  über die Donau & Transdanubien (Brücken; U6/U1/U2 als „Finger“, Bims 25/26/27 quer, Busse von der U1 zur U2,
  Zubringer je U-Bahn-Knoten) → der Süden (Meidling, Liesing, Favoriten, Simmering: U6/U1/U3, S-Bahn, Knoten,
  Bims 6/11/71/62/BB/1, 60er/70er-Busse) → Busnummern (Zehnerstelle läuft gegen den Uhrzeigersinn um die Stadt)
  → Nachts in Transdanubien. Inhalte und Fragen werden aus den Netzdaten berechnet (`client/src/learn/courses/`),
  jede Frage hat genau eine richtige Antwort. Alle Schritte zeigen dieselbe Netzkarte und blenden nur hervor
  oder aus; bei Fragen bleibt die Karte leer. Liniennummern im Kurstext sind antippbar (Steckbrief, „← zurück zum
  Kurs“); am Kursende lassen sich die Linien des Kurses mit einem Tipp zum Üben merken (bis 25 Linien).
- *🗺 Netzkarte* (`client/src/learn/atlas.ts`): Linie oder Station suchen bzw. auf der Karte antippen. Linie →
  **Steckbrief** (Merksatz mit den wichtigsten Umstiegen, Bezirke, U-/S-Bahn-Umstiege, alle Stationen); Station →
  **„Von hier fährst du mit …“** inkl. Richtungen. Alles darin ist wieder antippbar, „← zurück“ springt zur
  vorigen Auswahl. Ab Zoom 14 sind alle Haltestellen antippbar. **⭐ Merken** im Steckbrief, oder an einer Station
  alle Linien auf einmal; Chips „Bim“ und „⭐ Meine Linien“ (alles andere blass); „✕ Übersicht“ führt direkt
  zurück. **⇄ Vergleichen**: zwei Linien nebeneinander (Strecke, Stationen, Bezirke, Umstiege, gemeinsame
  Stationen bzw. wo sie sich am nächsten kommen); mit dem kleinen **+** bis zu sechs Linien – dann knapp
  (Strecke, Stationen, Bezirke) mit den Treffpunkten, an denen sich mindestens zwei der Linien treffen. Einbahn-Abschnitte (Schleifen, getrennte Gassen) mit
  Richtungspfeilen. Sonderlinien (z.B. 71E, 26E) und Halte nur aus Sonderführungen werden ausgeblendet.
  Die Karte der Lernen-Startseite ist gleich antippbar.
- *🏋 Üben*: die gemerkten Linien Linie für Linie – Steckbrief ansehen → aus dem Gedächtnis nachzeichnen (zur
  Orientierung nur leise U-/S-Bahn, nie die gesuchte Linie) → Vergleich (Prozent, verfehlte Stationen) → „sitzt“/
  „nochmal“. Unbekannte Linien kommen zuerst. Oder **🎲 5 zufällige Linien** aus U-Bahn, S-Bahn und Bim. Beim
  Ansehen lassen sich Stationen antippen (erscheinen mit „Von hier …“), der exakte Verlauf ist als Stationsliste
  aufklappbar, beim Zeichnen markieren Ⓐ/Ⓑ Start und Ende. ☆ hinter Liniennummern in den Routen-Details von
  Routenjagd und Training merkt Linien ebenfalls zum Üben. Wissen gegen andere testen geht im **🧠 Quiz**-Modus.
- *🚌 Welcher Bus fährt hier?* (`client/src/learn/busquiz.ts`): Busse lernt man am besten von der Haltestelle aus.
  10 Stationen (ganz Wien oder ein Bezirk), auf der Karte nur U/S/Bim zur Orientierung; aus 6–9 Bussen antippen,
  welche hier halten – die falschen halten ganz in der Nähe (bis 1,5 km). Auflösung: Richtungen je Bus, falsche mit
  nächster Haltestelle und Entfernung, alles auf der Karte. Stationen mit Fehlern kommen am Ende nochmal;
  übersehene Busse lassen sich ⭐ merken.
- **Netzkarte** (`client/src/netmap.ts`): alle U-, S-Bahn- und Bim-Linien plus die Kurs-Busse 13A/10A/48A. Jede
  Strecke zwischen zwei Stationen ist eine weiche Kurve, die exakt durch die Stationspunkte läuft – Linien
  treffen sich genau in den Umsteigepunkten. Punkte bei jeder Kreuzung außer Bim–Bim, große Knoten mit Namen;
  auf Stadt-Zoom werden Bim-Nummern und dichte Innenstadt-Namen ausgeblendet. Andere Busse und Nachtlinien werden
  nur gezeichnet, wenn eine Ansicht sie braucht. Bänder für Ring, Gürtel und Vorortelinie. Farben: U-Bahn in
  Linienfarben, S-Bahn blau, Bim dunkelrot (dünner und dunkler als die U1), Badner Bahn dunkelblau, Busse schiefergrau.
  Auch das Quiz zeichnet Linien damit (bei „Welche Linie ist das?“ nur die Linie, grau und ohne Namen), und in
  den Auflösungen von Routenjagd und Training liegt sie blass unter den Routen. Während des Ratens bleibt die
  Karte leer.

**Handy**: Auf Start, Lobby und der Lernen-Startseite keine Karte. Im Spiel bleibt
die Karte oben fix, nur das Panel scrollt; ⤢ vergrößert sie, beim „Wo liegt das?“ und Nachzeichnen wird sie automatisch groß.

## Betrieb auf Ditto (Heimserver) – automatische Updates

Live läuft der BimGuesser als Container auf **Ditto** (Ubuntu-VM, Docker, Caddy), öffentlich über **ngrok**,
intern unter **http://bimguesser.ditto**.

**Neue Version veröffentlichen** (am Laptop, alles committet):

```bash
npm run release          # v1.2.3 → v1.2.4   (oder: npm run release minor / major)
```

Das prüft zuerst (Typecheck, `npm test`, Klick-Durchlauf `npm run smoke` – bei Fehlern kein Release; ohne
Edge/Chrome: `npm run release -- --skip-smoke`), setzt dann einen Tag `v…` und pusht ihn. Danach passiert alles
automatisch:

1. **GitHub Actions** (`.github/workflows/release.yml`): Typecheck + Tests + Build → Image `ghcr.io/grenadier7/bim-guesser:v…` und `:latest`.
2. **Ditto** (`deploy/update.sh`, per cron alle 2 min): neues `:latest` gefunden → wartet, bis kein Spiel läuft
   (Lobbys leben nur im Arbeitsspeicher, max. 15 min) → startet den Container neu → prüft `/api/health` →
   bei Fehler zurück auf die vorige Version. Log: `~/docker/services/bimguesser/update.log`.
   Sofort aktualisieren (ohne auf Spielpause zu warten): `~/docker/services/bimguesser/update.sh --now`.

Normale Commits und Pushes deployen nichts – nur Tags `v*`.

**Einrichtung auf Ditto** (einmalig):

- `deploy/compose.snippet.yml` in `~/docker/compose.yml` unter `services:` einfügen, in `~/docker/.env`
  `NGROK_AUTHTOKEN` und `NGROK_DOMAIN` setzen.
- `deploy/Caddyfile.snippet` ins Caddyfile übernehmen, Caddy neu laden.
- `deploy/update.sh` nach `~/docker/services/bimguesser/` kopieren, ausführbar machen, cron-Eintrag:
  `*/2 * * * * ~/docker/services/bimguesser/update.sh >> ~/docker/services/bimguesser/update.log 2>&1`
- `deploy/backup.sh` ebenso, cron-Eintrag (täglich 04:30):
  `30 4 * * * bash ~/docker/services/bimguesser/backup.sh >> ~/docker/services/bimguesser/backup.log 2>&1`
- Das Paket `bim-guesser` auf GitHub (Packages) auf **public** stellen – sonst braucht Ditto ein `docker login ghcr.io`.

**Container-Details:** `Dockerfile` (Node 24, läuft als Benutzer `node`), Laufzeitdaten (Auskunfts-Cache,
Statistik) im Volume `/app/state` (`STATE_DIR`), Proxy-Vertrauen über `TRUST_PROXY` (im Image
`loopback, uniquelocal`, damit die Rate-Limits hinter ngrok/Caddy die echte IP sehen), `GET /api/health` liefert
Version, Laufzeit und laufende Spiele. Speicherbedarf ca. 40–100 MB (`mem_limit: 384m`).

Wichtig: Die kostenlose ngrok-Domain kann nur an **einer** Stelle laufen – am Laptop daher `npm run serve`
statt `npm start`, solange Ditto online ist.

### Standard-Einstellungen (`shared/defaults.ts`)

Alle Standardwerte stehen in **einer Datei**: Routenjagd, Quiz, Training und Lernen (mit Kommentaren, welche Werte
erlaubt sind). `NOT_REMEMBERED` legt fest, was nicht für die nächste Lobby gemerkt wird (Netz „Aktuell“ und
Fokus-Kreis starten immer mit dem Standard). In Routenjagd- und Quiz-Lobby setzt „↺ Alle Einstellungen
zurücksetzen“ alles auf diese Werte zurück, im Training „↺ Einstellungen zurücksetzen“.

### Wertung (`shared/rules.ts`)

| Teil | Punkte | Regel |
|---|---|---|
| Route | 0–1000 (+300) | Toleranz max(1 min, 4 %), danach fallend, 0 bei +70 % Reisezeit (z.B. 40 → 60 min ≈ 200). Besser als die beste gefundene Route: je 1 % besser +2 %, max. 1300 (z.B. 27 statt 30 min = 1200) |
| Tipps | günstig −40 / −40 / −40 / −50 % · teuer −65 / −65 / −65 / −75 % | Anteil der Routenpunkte, mehrere Tipps multiplikativ, mind. 10 % bleiben. |
| Zeitbonus | bis +10 % | der Routenpunkte (nach Tipps), linear mit Restzeit; ohne Limit gemessen an 1:30 |
| Wo liegt das? | bis +150 | 75 je Station: voll bis 250 m, 0 ab 3 km |
| Schwierigkeit | ×0,95 / 1,05 / 1,32 / 1,69 | auf die ganze Runde |

Für jede Runde wird die Auskunft für 6 Abfahrtszeiten (Slot +0 … +50 min) abgefragt und nach
*Verbindungsart* gruppiert (Linien + Umstiegsstationen; auf demselben Abschnitt gelten S-Bahnen, Bims bzw. Busse
als gleichwertig, U-Bahn-Linien nicht). Gewertet wird der Median – mit „Wartezeit mitzählen“ als Tür-zu-Tür-Zeit ab
jeder Stichproben-Zeit. Die Top-5 und eigene Routen werden dafür Teilstrecke für Teilstrecke nachgerechnet
(Anschluss je Stichprobe). Liefert die Auskunft für eine U-Bahn-Teilstrecke nur eine schnellere Linie (Karlsplatz → Praterstern
immer U1), wird über einen Zwischenhalt der gewählten Linie gefragt (über Schottentor → U2). In den Routendetails steht, wie viel davon Wartezeit ist („Ø 4 min Warten + 33 min
unterwegs“). Ist die Wiener-Linien-Auskunft nicht erreichbar, kommt eine freundliche Meldung statt eines Fehlers.
Ist deine Route nicht unter den gefundenen, wird jede Teilstrecke mit genau dieser Linie abgefragt
(`maxChanges=0`) und für jede Stichprobe verkettet (Umstieg gleiche Station 2 min, Fußwege Luftlinie × 1,3 bei 80 m/min).

## Tests

```bash
npm test         # Wertung, Ø-Wartezeit, alle Kurse und alle Quiz-Fragetypen (mit Zufallsfragen gebaut, jede Frage gültig)
npm run smoke    # Klick-Durchlauf in Edge/Chrome (unsichtbar; --headed zum Zuschauen): Lernen, Netzkarte,
                 # Vergleich, alle Kurse, Üben, Routenjagd- und Quiz-Lobby – jeder JavaScript-Fehler = Abbruch
```

Tests liegen in `test/` (Node-Testrunner, ohne Browser), der Klick-Durchlauf in `scripts/smoke.ts`
(`playwright-core` steuert den installierten Browser, lädt keinen eigenen herunter).

## Aufbau

```
shared/    Typen, Spielregeln/Punkte, Quiz-Fragen (Server & Client)
server/    Express-API + SSE, EFA-Client, Routing/Sampling
           lobby.ts (Spieler/Host/Live), game.ts (Routenjagd), quiz.ts (Quiz), training.ts, manager.ts
scripts/   build-network.ts: GTFS + API -> data/network.json · release.ts · smoke.ts (Klick-Durchlauf)
client/    Vite + TypeScript + Leaflet (screens/: home, lobby, round, reveal, final, quiz, training, learn)
           netmap.ts: die Netzkarte (für Lernen, Kurse, Quiz und als Hintergrund der Auflösung)
           learn/: atlas.ts (Netzkarte mit Steckbrief), study.ts (Üben), courses/ (ein Kurs je Datei)
test/      Unit-Tests (node --test)
```

- **Datenquellen**: [Wiener Linien Open Data](https://www.wienerlinien.at/open-data) – Routing-API (EFA, `ogd_routing`)
  und GTFS. API-Antworten werden 3 Tage in `data/cache/` zwischengespeichert.
- **Karte**: Esri „Light Gray Base“. Kacheln werden nur bis Zoomstufe 14 geladen (ab 15 enthalten sie Straßennamen) und darüber vergrößert.
- **Multiplayer**: Spielzustand liegt im Speicher des Servers (eine Instanz), Live-Updates per Server-Sent Events
  (`GET /api/games/:code/events?playerId=…`). Ein Server-Neustart beendet alle laufenden Lobbys.
