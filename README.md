# Öffi-Guesser Wien

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

| Modus | Spieler | Worum geht's |
|---|---|---|
| 🏁 **Routenjagd** | Lobby, 1–12 | Schnellste Öffi-Verbindung zwischen zwei Stationen finden |
| 🧠 **Quiz** | Lobby, 1–12 | Fragen zu Stationen, Linien, Umstiegen – Punkte für richtig und schnell |
| 🏋️ **Training** | allein | Echte Strecken mit Coach, Hilfen und Erklärung |
| 📚 **Lernen** | allein | Netzplan, Linien-Steckbriefe, Linien nachzeichnen |

### Quiz

- Fragetypen: 📍 Wo liegt …? · 🎯 Direktverbindung (welche Linie fährt ohne Umsteigen von A nach B?) ·
  🔀 Umstieg (wo kann man von X in Y umsteigen?) · 🚏 Linien an der Station (mehrere) · ↔️ Endstationen ·
  〰️ Linie erkennen · ✏️ Linie zeichnen (Verlauf von Endstation zu Endstation antippen, doppelte Zeit) ·
  🏘️ Bezirk · ➡️ Nächste Station.
- Einstellungen: Anzahl Fragen, Zeit pro Frage, Gebiet (Bezirk, wird auf der Karte eingefärbt), Verkehrsmittel;
  unter „Fragetypen & Häufigkeit“ je Typ ein Regler mit 7 Stufen (1 = gar nicht, 4 = normal, 7 = sehr häufig)
  und „↺ Standard-Häufigkeiten“.
- Umstiegsfragen mischen falsche Antworten von beiden Linien; in der Auflösung werden beide Linien gezeichnet.
  Nach „In welchem Bezirk …?“ zeigt die Auflösung alle Linien, die dort abfahren.
- „Linie zeichnen“ wird am Server bewertet: Anteil der Stationen nahe der Zeichnung (abzüglich dessen, was eine
  gerade Linie schon träfe) und Anteil der Punkte, die auf der Linie liegen.
- Fragen werden am Server erzeugt und bewertet (`shared/quiz.ts`): richtig = 500–1000 Punkte je nach Tempo;
  „Linie zeichnen“ zählt nur die Genauigkeit (bis 1000), nicht das Tempo. „Wo liegt …?“ gibt Teilpunkte nach Entfernung (voll bis 200 m, 0 ab 3 km), Mehrfachauswahl Teilpunkte
  (falsche ziehen ab). Mehrdeutige Antworten (z.B. S1/S2) werden vermieden.
- Host: Pause, Frage überspringen, Jetzt auflösen, Spiel beenden.

## Routenjagd

1. Auf der Startseite **🏁 Routenjagd** wählen (erstellt eine Lobby, auch alleine) oder **mit Code beitreten** – der Einladungslink `?code=XXXXX` füllt den Code automatisch aus.
2. In der Lobby stellt der Host alles ein:
   - **Uhrzeit** (unter „Erweitert“): Mo–Fr 12 Uhr, Mo–Fr 17 Uhr, Sa 2 Uhr (Nacht), So 12 Uhr
   - **Netz**: *Regulär* = Referenztag ohne Baustellen (das Build-Skript sucht den nächstgelegenen Tag ohne
     Ersatzverkehr und mit funktionierenden S-Bahn-Testverbindungen, ohne Ferien/Feiertage) ·
     *Aktuell* = nächster echter Tag inkl. Sperren
   - **Schwierigkeit**: Schnellwahl Leicht / Mittel / Schwer / Profi – oder selbst mit drei Reglern:
     *Haltestellen*: Schiene frei kombinierbar (🚇 U · 🚆 S · 🚋 Bim, z.B. nur S-Bahn) plus eine Bus-Stufe
     (Kein Bus · 🔀 Knoten = 3+ Linien · 🚌 2+ Linien · ★ alle Bus-Haltestellen); Schwer = U + S + Bim + Bus-Knoten,
     Profi = alles; der Multiplikator richtet sich nach der schwierigsten Art,
     *Entfernung* (2–7 / 3–12 / 6–16 km) und *Immer mit Umstieg*. Der Punkte-Multiplikator (0,81–1,62) ergibt sich daraus.
   - **Fokus-Gebiet**: Kreis auf der Karte (antippen oder Bezirk als Mittelpunkt wählen), Radius 1,5–6 km.
     10–90 % der Stationen werden aus dem Kreis gezogen, der Rest aus ganz Wien. Standardmäßig aus.
   - **Runden**: 3 / 5 / 7 / 10
   - **Zeitlimit** (Standard: an, 3:00) – nach Ablauf wird automatisch abgegeben, was eingegeben ist
   - **Wo liegt das?** – Start und Ziel vorher auf der leeren Karte tippen
   - **Wertung** (unter „Erweitert“, Standard: *Beste Route*): Reisezeit + Aufschlag je Umstieg – Punkte, Ranking
     und die Liste der Top-Verbindungen richten sich danach. Aufschlag: 2 min mit Ø-Wartezeiten (Warten ist dort
     schon eingerechnet), 4 min mit echtem Fahrplan.
     *Schnellste Route*: nur die Reisezeit zählt.
   - **Wartezeit mitzählen** – Tür-zu-Tür ab Abfragezeit statt nur Fahrzeit
   - **Ø-Wartezeiten statt Fahrplan-Glück** (Standard: an) – jede Linie zählt mit ihrer mittleren Fahrzeit, jeder
     Umstieg mit Umsteigeweg + halbem Takt der nächsten Linie (Takt = Abfahrten der folgenden Stunde; gleichwertige
     Linien wie S1–S4 auf der Stammstrecke zählen zusammen). Ein zufällig perfekter Anschluss bringt so keinen
     Vorteil; eine S7 alle 30 min kostet im Schnitt 15 min. Die Routendetails zeigen die Wartezeit je Umstieg.
   - **Einschränkungs-Runden** – Nie / Manchmal (ca. 30 %, mindestens eine pro Spiel) / Immer: ohne U-Bahn,
     ohne Bus, max. 1 Umstieg oder **Linie gesperrt** (eine Linie der schnellsten Verbindung, z.B. „Ohne Linie U6“).
     Diese Runden haben doppelte Zeit, höchstens +2:30 – „Ohne U-Bahn“ bekommt fix +4:00.
   - **Tipps** – Linien am Start / am Ziel, Verkehrsmittel-Kette, Umstiegsorte auf der Karte
   - **Route eingeben**: Linie wählen → Einstieg (nächstgelegene Haltestelle, ggf. mit Fußweg) → Ausstieg. Die
     Ausstiegs-Liste zeigt die ganze Linie von der nördlicheren Endstation nach unten zur anderen (z.B. U1 Leopoldau …
     Oberlaa), die Einstiegs-Station steht markiert und nicht wählbar mittendrin.
     Hält die Linie an der Station nur in eine Richtung (Schleifen/Einbahnen, z.B. 40 bei Schöffelgasse), wird die
     Gegenrichtung ab der nächsten Haltestelle (bis 700 m) angeboten – inkl. Fußweg dorthin.
3. Eine Runde wird aufgelöst, sobald alle (verbundenen) Spieler abgegeben haben, das Zeitlimit abläuft
   oder der Host „Jetzt auflösen“ drückt. Der Host schaltet zur nächsten Runde und kann am Ende
   mit denselben Spielern zurück in die Lobby.
4. **Host-Steuerung** während der Runde: ⏸ Pause (Zeit steht, alle sehen eine Pause-Anzeige, Pausenzeit zählt
   nicht zur benötigten Zeit), ✖ Runde abbrechen (Lösung wird gezeigt, keine Punkte), ⏹ Spiel beenden.

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

**Lernmodus** (Startseite, ohne Lobby) – erst lernen, dann optional testen:
- *Bereich*: **Gebiet** (Bezirk oder Kreis auf der Karte, mit Verkehrsmittel-Filter), **Linien** (einzelne oder
  „alle U-Bahn/S-Bahn/Bim“) oder **ganz Wien**.
- *📖 Lernen → Netzplan*: alle Linien des Bereichs in unterscheidbaren Farben. Linie antippen zeigt einen
  **Steckbrief** mit automatisch erzeugtem Merksatz („Die Linie 12 fährt von Hillerstraße über Vorgartenstraße,
  Traisengasse, Friedensbrücke und Lange Gasse nach Josefstädter Straße“ – Zwischenpunkte sind die wichtigsten
  Umstiege, bevorzugt U-/S-Bahn), Bezirke und alle U-/S-Bahn-Umstiege. Haltestelle antippen zeigt
  „Von hier fährst du mit …“ inkl. Richtungen.
- *📖 Lernen → Linie für Linie*: Steckbrief ansehen → Linie aus dem Gedächtnis auf der leeren Karte nachzeichnen →
  Vergleich mit dem echten Verlauf (Prozent getroffen, verfehlte Stationen) → selbst einschätzen („sitzt“/„nochmal“).
  Unbekannte Linien kommen zuerst.
- *🧪 Wissen testen* (aufklappbar): Wo liegt …?, Welche Linien halten hier?, Welche Linie ist das?, Nächste Station –
  mit Lernstand pro Aufgabe; mehrdeutige Antworten (z.B. S1/S2 auf der Stammstrecke) werden vermieden.
- Fortschritt wird im Browser gespeichert und ist je Bereich zurücksetzbar.

**Handy**: Auf Start, Lobby und Lern-Einstellungen keine Karte (außer zum Setzen eines Kreises). Im Spiel bleibt
die Karte oben fix, nur das Panel scrollt; ⤢ vergrößert sie, beim „Wo liegt das?“ und Nachzeichnen wird sie automatisch groß.

### Standard-Einstellungen (`shared/defaults.ts`)

Alle Standardwerte stehen in **einer Datei**: Routenjagd, Quiz, Training und Lernen (mit Kommentaren, welche Werte
erlaubt sind). `NOT_REMEMBERED` legt fest, was nicht für die nächste Lobby gemerkt wird (Netz „Aktuell“ und
Fokus-Kreis starten immer mit dem Standard). In Routenjagd- und Quiz-Lobby setzt „↺ Alle Einstellungen
zurücksetzen“ alles auf diese Werte zurück, im Training „↺ Einstellungen zurücksetzen“.

### Wertung (`shared/rules.ts`)

| Teil | Punkte | Regel |
|---|---|---|
| Route | 0–1000 (+300) | Toleranz max(1 min, 4 %), danach fallend, 0 bei +70 % Reisezeit (z.B. 40 → 60 min ≈ 200). Besser als die beste gefundene Route: je 1 % besser +2 %, max. 1300 (z.B. 27 statt 30 min = 1200) |
| Tipps | −45 / −45 / −45 / −55 % | Anteil der Routenpunkte, mehrere Tipps multiplikativ, mind. 10 % bleiben. Bei 30 min optimal ≈ Start: 38 min ohne Tipp · Start+Ziel: 43 · Umstiegsorte: 40 · Start+Ziel+Verkehrsmittel: 46 · alle: 10 % |
| Zeitbonus | bis +10 % | der Routenpunkte (nach Tipps), linear mit Restzeit; ohne Limit gemessen an 1:30 |
| Wo liegt das? | bis +150 | 75 je Station: voll bis 250 m, 0 ab 3 km |
| Schwierigkeit | ×1,0 / 1,15 / 1,3 / 1,62 | auf die ganze Runde |

Für jede Runde wird die Auskunft für 6 Abfahrtszeiten (Slot +0 … +50 min) abgefragt und nach
*Verbindungsart* gruppiert (Linien + Umstiegsstationen; auf demselben Abschnitt gelten S-Bahnen, Bims bzw. Busse
als gleichwertig, U-Bahn-Linien nicht). Gewertet wird der Median – mit „Wartezeit mitzählen“ als Tür-zu-Tür-Zeit ab
jeder Stichproben-Zeit. Die Top-5 und eigene Routen werden dafür Teilstrecke für Teilstrecke nachgerechnet
(Anschluss je Stichprobe). Liefert die Auskunft für eine U-Bahn-Teilstrecke nur eine schnellere Linie (Karlsplatz → Praterstern
immer U1), wird über einen Zwischenhalt der gewählten Linie gefragt (über Schottentor → U2). In den Routendetails steht, wie viel davon Wartezeit ist („Ø 4 min Warten + 33 min
unterwegs“). Ist die Wiener-Linien-Auskunft nicht erreichbar, kommt eine freundliche Meldung statt eines Fehlers.
Ist deine Route nicht unter den gefundenen, wird jede Teilstrecke mit genau dieser Linie abgefragt
(`maxChanges=0`) und für jede Stichprobe verkettet (Umstieg gleiche Station 2 min, Fußwege Luftlinie × 1,3 bei 80 m/min).

## Aufbau

```
shared/    Typen, Spielregeln/Punkte, Quiz-Fragen (Server & Client)
server/    Express-API + SSE, EFA-Client, Routing/Sampling
           lobby.ts (Spieler/Host/Live), game.ts (Routenjagd), quiz.ts (Quiz), training.ts, manager.ts
scripts/   build-network.ts: GTFS + API -> data/network.json
client/    Vite + TypeScript + Leaflet (screens/: home, lobby, round, reveal, final, quiz, training, learn)
```

- **Datenquellen**: [Wiener Linien Open Data](https://www.wienerlinien.at/open-data) – Routing-API (EFA, `ogd_routing`)
  und GTFS. API-Antworten werden 3 Tage in `data/cache/` zwischengespeichert.
- **Karte**: Esri „Light Gray Base“. Kacheln werden nur bis Zoomstufe 14 geladen (ab 15 enthalten sie Straßennamen) und darüber vergrößert.
- **Multiplayer**: Spielzustand liegt im Speicher des Servers (eine Instanz), Live-Updates per Server-Sent Events
  (`GET /api/games/:code/events?playerId=…`). Ein Server-Neustart beendet alle laufenden Lobbys.
