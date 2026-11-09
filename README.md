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
oder ein normales Spiel (Routenjagd-/Quiz-Endstand, Training) abgeschlossen hat (`client/src/progress.ts`). Zwei
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
  „Linie zeichnen“ zählt nur die Genauigkeit (bis 1000), nicht das Tempo. „Wo liegt …?“ gibt Teilpunkte nach Entfernung (voll bis 250 m, 0 ab 3 km – wie in der Routenjagd), Mehrfachauswahl Teilpunkte
  (falsche ziehen ab). Mehrdeutige Antworten (z.B. S1/S2) werden vermieden. Nur reguläres Netz: keine
  Sonderlinien (71E, 26E) und keine Halte aus Sonderführungen.
- Host: Pause, Frage überspringen, Jetzt auflösen, Spiel beenden.

## Strecke des Tages

📅 auf der Startseite (Link: `/#daily`): für alle dieselbe Strecke, **ein Versuch am Tag** (Wiener Zeit), ohne
Zeitlimit und Hilfen, gewertet wie die Route in der Routenjagd (bis 1300). Danach: Ergebnis zum **Teilen** (Emoji-Zeile
mit Verkehrsmitteln und Punkte-Kästchen, verrät die Lösung nicht), die schnellsten Verbindungen und die **Bestenliste**
für heute bzw. die Woche (Mo–So, Summe) – alle oder nur Freunde. Bestenliste und „einmal am Tag“ gelten mit Account;
Gäste spielen auch, ihr Ergebnis bleibt im Browser.

Die Strecke wird nicht einfach zufällig gezogen (`server/daily.ts`):

1. Start und Ziel sind U- oder S-Bahn-Stationen, 3–12 km auseinander.
2. Die schnellste Verbindung hat mindestens einen Umstieg.
3. Perfekt ist nicht offensichtlich: nur mit **bekannten Linien** – U-Bahn, S-Bahn-Stammstrecke (S1–S4, S7), S45, S80;
   wenig bekannte S-Bahnen wie S40/S50/S60 zählen wie eine Bim (`isWellKnownLine`) – gibt es höchstens 800 Punkte (die beste Verbindung
   nimmt eine Bim/einen Bus oder eine geschickte Kombination).
4. Trotzdem machbar: nur mit bekannten Linien gibt es mindestens 350 Punkte.
5. Abwechslung: Stationen der letzten 7 Tage kommen nicht dran.

Erfüllt nach 60 Versuchen keine Strecke alles, gilt die nächstbeste. Die Strecke je Tag steht in
`STATE_DIR/daily.json` (bleibt nach einem Neustart gleich); die Auflösung zeigt zum Vergleich die Zeit nur mit bekannten Linien.

## Fortschritt & Motivation

- **🗺️ Mein Wien** (Leiste oben auf der Startseite): Level, **Serie** (Tage in Folge; ein **Joker** je 7 Tage überbrückt
  einen verpassten Tag), **Wochenziel** (5 Spiele/Strecken Mo–So), Medaillen und die **Sammelkarte**: alle Linien und
  Stationen, die man auf eigenen gültigen Routen benutzt hat (Routenjagd, Training, Strecke des Tages) – je Verkehrsmittel
  „x von y“. Geht ohne Account (Browser), mit Account auf allen Geräten (`oeffi-career-v1`, wird zusammengeführt).
- **Fehler wiederholen**: Linien aus falschen Quiz-Antworten und aus Runden, in denen die schnelle Verbindung eine andere
  Linie nahm, landen unter Lernen → Üben → „Fehler wiederholen“; geübt fallen sie heraus. Quiz-Endstand: Liste aller
  Fragen (✓/½/✗ mit Erklärung) und „Diese jetzt üben“.
- **Nach schwachen Runden**: konkreter Tipp („Der Trick: S1/S2 ab Handelskai – das wären 6 min weniger gewesen“, mit ☆
  zum Merken); eigene Route genauso schnell wie eine der Liste → „genauso schnell wie Nr. 3“. Jede gültige Route bringt
  mindestens 50 Routenpunkte (Ankommen zählt).
- **Endstand** (Routenjagd und Quiz gleich): Punkte mit Balken und Urteil bzw. Siegertreppchen, 🔁 **Revanche** (gleiche
  Einstellungen, sofort los), allein: Vorschlag der nächsten Stufe (≥ 70 %) bzw. einer leichteren (< 25 %).
  „Spiel beenden“ mitten im Spiel zeigt den Endstand der gespielten Runden.
- **Tages-Challenges** in der Routenjagd-Lobby (eigene Überschrift „Daily Events“ über den Einstellungen) – kurze Abwechslung für etwa 5 Minuten (`shared/challenges.ts`,
  Regeln in `shared/challengeRules.ts`, Server `server/challengeRound.ts`): ein niedriges Banner unter
  „Einstellungen“, mit ‹ › blätterbar (Titel eine Zeile, Beschreibung höchstens zwei) – jeden Tag **3 aus dem Plan
  + 🏘️ Bezirk des Tages** (für alle gleich, zufällig gemischt, die erste ist der Vorschlag).
  - **Tagesplan** (`buildSchedule` in `shared/challenges.ts`): einmal für 180 Tage berechnet, dann exakt wiederholt;
    der Server legt ihn als `challenge-schedule.json` (STATE_DIR) ab und rechnet nur neu, wenn sich die Challenges
    ändern (`/api/challenges/schedule`). Jede Challenge kommt in jedem 30-Tage-Fenster fast gleich oft (Guthaben je
    Tag, danach ringförmig geglättet), zu ähnliche (`avoid` – z.B. Wasser/Bad, Drei Ziele/Drei Punkte,
    Fleckerlteppich/Innenstadt umfahren) nie am selben Tag und möglichst nicht am Tag davor, jeden Tag normale und
    besondere (`kind`), wechselnde Gruppen; funktioniert auch mit mehr Challenges.
  - **Bezirk des Tages:** 18 Gruppen (große Bezirke allein, kleine paarweise: 2+20, 4+5, 6+7, 8+9, 15+16), Start und
    Ziel in den Bezirken, alle Bim- und Bushaltestellen mit 2+ Linien, 1–6 km; am Tag des 1. Bezirks keine Ring-Runde.
  - Jede Challenge legt **alle Einstellungen selbst** fest (`CHALLENGE_BASE` + eigene Haltestellen-Arten, Entfernung,
    Umstiege) – was in der Lobby eingestellt war, spielt keine Rolle.
  - „Spielen“ setzt die Einstellungen der Challenge („Wo liegt das?“ aus), klappt „Erweitert“ zu
    und graut alles aus (am Server gesperrt) – **nur die Rundenzahl bleibt wählbar**, mit eigenen Optionen je
    Challenge (Standard ≈ 5 Minuten: leicht 2, schwer 1, Sprints 3–4). Eigener Start-Knopf, beim Start sieht jeder ein
    Fenster mit Icon, Name und Beschreibung. „✕ Beenden“ → wieder alles Standard.
  - Katalog: ⚡ Blitzrunde · ⏱️ Sekundenkrimi · 🏆 Profi-Sprint · 🚫 Ohne U-Bahn · 🚋 Bim-Tour · 🕵️ Insider (keine U-Bahn,
    keine bekannte S-Bahn) · 1️⃣ Direkt-Profi · 🔀 Umsteige-Profi (mind. 2× umsteigen) · ⛔ Hindernislauf · 🚐 Busreise (nur
    Busse, kurz) · 🚶 Fußbus (genau eine Linie, Rest zu Fuß) · ☀️ Sonnenschein (nichts Unterirdisches) · 🍩 Innenstadt
    umfahren (keine Station in 1, 4–9; Bezirke rot auf der Karte) · 🚆 S-Bahn-Fan · 🚌 Busfahrer (Strecken, auf denen der Bus
    die besten Verbindungen stellt) · ☝️ Eine U reicht · 🎨 Bunt gemischt (≥ 3 Verkehrsmittel) · 🔁 Nie zweimal dasselbe ·
    🦘 Bim-Hüpfer (erste und letzte Fahrt Bim) · 📌 Pflicht-Linie · 🎲 Eine von drei (drei lästige Linien; die beste
    erlaubte Verbindung nimmt genau eine) · 🧩 Fleckerlteppich (zufällige Bezirke gesperrt, mind. einer liegt auf der
    besten Verbindung) · 🟥 Sperrzone XXL (7–9 Bezirke gesperrt, 2 davon auf der besten Verbindung; Umweg ≤ 25 min) ·
    🗺️ Bezirkstour (2–3 grüne Bezirke abseits der besten Verbindung, die Route muss durch jeden führen – auch nur
    durchfahren zählt; Vergleichsrouten über die Knoten der Bezirke, `viaDistricts`) · 🎯 Drei Ziele (zu einem davon) · 📍 Drei Punkte (alle befahren) · 🏊 Ab ins Wasser · 🩱 Ab ins Bad
    (nur Bäder) · 🚆 Aus dem Umland (Start im Ort in Niederösterreich, den richtigen Zug selbst finden – manche Orte haben
    zwei, z.B. Absdorf-Hippersdorf: S4 oder S40; Fahrzeit bis zur Stadtgrenze ca., `UMLAND` in `server/challengeRound.ts`)
    · 🎡 Ring-Runde (Innere Stadt nur mit Bim und Bus) · 🏠 Tür zu Tür · 🌄 Stadtrand-Tour (12–25 km) · 🚧 Aktuelles Netz ·
    🍻 Dickmacks Donnerstag (01:30 unter der Woche, Schwedenplatz → Adresse, nur Nightline) · 🌙 Nachtschicht ·
    🧺 Sonntagsausflug · 🛴 E-Scooter (Wege mit 20 km/h, 30 s Treppen an U-/S-Bahn; auch „nur Scooter“ als Antwort) ·
    🚁 Hubschrauber (drei Linien H1–H3 mit fester Flugzeit, einer bringt Zeit) · 🌉 Brückenkenner (mehr Brücken als die
    schnellste Verbindung) · 🔮 Zielnetz 2040.
  - **Karte:** gesperrte Bezirke rot schraffiert mit gestricheltem Rand und „⛔ 7.“ in der Mitte; Bezirkstour grün
    mit „🎯 7.“, befahrene mit Haken.
  - **Daten:** Brückenkenner braucht `data/bridges.json`, Ab ins Wasser/Bad `data/water.json` – fehlen sie, gibt es die
    Challenges nicht (Plan) bzw. gleich eine Meldung statt langer Suche. `test/docker.test.ts` prüft, dass das
    Dockerfile alle Dateien aus `data/` ins Image kopiert.
  - **Abgeben** geht erst, wenn die Regel der ganzen Route erfüllt ist (mind. 3 Verkehrsmittel, 2 Umstiege,
    Pflicht-Linie, alle Punkte …) – nur bei Zeitablauf geht die Route trotzdem raus (zählt dann nicht).
  - **Verteilung:** Start und Ziel nach Fläche (jedes ~1,2-km-Feld mit Haltestellen gleich oft, nicht jede Station),
    selten gezogene zuerst, die letzten 300 gespielten Strecken werden gemieden. `npm run check:spread` spielt jede
    Challenge 10× und zeigt Anteile je Gegend und Wiederholungen.
  - Zeitlimit: Challenges mit fester Regel bekommen keine Extrazeit (meist 4 Minuten, lange Strecken 5) – nur der
    Hindernislauf mit wechselnden Hürden. Rundenzahl immer bis 5 wählbar.
  - **Suche je Regel:** Gesperrtes (Bezirke, unterirdische Abschnitte, Insider-Linien) meidet schon der eigene Fahrplan
    (`avoidStops`/`avoidLines`/`avoidLineStops` in `server/timetable.ts`); dazu Suchen mit weniger Verkehrsmitteln
    (`searchVariants`) – sonst fehlt z.B. Speising → Heiligenstadt mit S80 › S45 bei „mind. eine S-Bahn“.
  - **Sofort korrigiert:** Der Baukasten bietet nur an, was die Regel erlaubt – gesperrte Linien mit Begründung beim
    Eintippen („🦘 Die erste Fahrt muss mit der Bim sein – U3 ist U-Bahn“), gesperrte Ein-/Ausstiege grau mit Grund
    („☁️ unter der Erde“, „🚫 innerer Bezirk“), das Ziel erst, wenn die Route die Regel erfüllt („noch nicht: Es fehlt
    noch ein Bus“). Server und Baukasten nutzen dieselben Regeln und Meldungen.
  - Auswahl der Strecken je Challenge (z.B. Busfahrer: Bus in allen besten Verbindungen; Bunt gemischt: gemischte
    Verbindung fast so schnell wie die beste; Pflicht-Linie: liegt nicht auf der schnellsten Verbindung; Drei Ziele:
    das nächstgelegene ist nicht das schnellste). Die Auflösung zeigt nur Verbindungen, die die Regeln einhalten.
  - Unterirdische Abschnitte (grob): U3 fast ganz, U1/U2/U4 im Zentrum, U6 bei Längenfeldgasse/Niederhofstraße und
    Jägerstraße/Dresdner Straße, S-Bahn-Stammstrecke (Mitte–Rennweg–Quartier Belvedere), 18er am Hauptbahnhof und im
    Südgürtel-Tunnel (`UNDERGROUND` in `shared/challengeRules.ts`).
  - **Brückenkenner:** echte Brücken aus OpenStreetMap über Donau/Neue Donau, Donaukanal, Wienfluss und Alte Donau
    (`npm run build:bridges` → `data/bridges.json`, ODbL), je Verkehrsmittel zugeordnet: die U-Bahn zählt nur über eine
    U-Bahn-Brücke (die U1 unter dem Donaukanal nicht), parallel zum Fluss zählt nicht, die Reichsbrücke über Donau und
    Neue Donau ist eine. Auf der Karte: Abschnitte in der Farbe des Verkehrsmittels, Linien im Tooltip.
  - **Zielnetz 2040:** eigener Netzplan (`server/ziel2040.ts`, beim Start angelegt, auf der Admin-Seite unter
    „Netzpläne“ änderbar und in der Lobby unter „Netz“ wählbar) – U5 (Hernals – Karlsplatz), U2 über Neubaugasse und
    Pilgramgasse zum Wienerberg, S45 bis Praterkai (Ring mit der S80), S45 alle 5 / S80 alle 10 /
    Stammstrecke je Linie alle 15 Minuten, S70 Simmering – Stadlau (Gleise der S80) – Breitenleer Straße – Hermann-Gebauer-Straße – Süßenbrunn, Bim 15
    (Wienerberg-Tangente) und 29 neu, 12/18/25/27 verlängert. Nicht genau, sondern spielbar. Die Challenge nimmt nur
    Strecken, deren beste Verbindung wegen des neuen Netzes anders oder ≥ 2 min schneller ist (`npm run check:future`:
    30 von 30); „Zielnetz einblenden“ zeigt die Linien, die Auflösung den Vergleich mit heute.
  - **Ab ins Wasser:** Gewässer und Bäder aus OpenStreetMap (`npm run build:water` → `data/water.json`, ODbL); Start
    ≥ 1,2 km vom Wasser und mit den Öffis klar schneller als zu Fuß; gewertet bis ans Wasser inkl. Fußweg.
  - **Medaillen:** 🎪 Challenge-Sammler (verschiedene gespielt) und 🏅 Challenge-Meister (geschafft – meist eine Runde
    mit vollen Routenpunkten, bei schweren ab 900), je Bronze/Silber/Gold.
  - **Prüfen:** `npm run check:challenges` prüft mit dem echten Fahrplan, ob jede Challenge Strecken findet.
- **Chat**: Schnell-Reaktionen 👏 😂 😮 🔥 🚋 GG als feste Zeile über dem Eingabefeld (`/ez` eintippen schickt einen
  zufälligen Spruch).
- **Tastatur**: Linie tippen, ← → (↑ ↓) wählt unter den Vorschlägen (52 → 52A → 52B), Enter nimmt sie – der Fokus steht
  beim Ausstieg (hält die Linie woanders: beim Einstieg, mit Fußweg-Hinweis). Enter öffnet die Liste, ↑ ↓ wählt den
  Halt, Enter übernimmt; bei zugeklappter Liste wechseln ↑ ↓ zwischen Ein- und Ausstieg. Entf verwirft die angefangene
  Linie, Escape = Liste zu bzw. andere Linie, **Strg + Enter** gibt die Route ab (überall auf der Seite; am Ziel steht
  der Fokus auf „Route abgeben“) – Routen ganz ohne Maus.
- **Dunkelmodus**: startet immer hell; Knopf oben (☀️ hell · 🌙 dunkel · 🌗 wie das System), Karte mit dunklen Kacheln. Die dunklen Farben
  erzeugt `npm run build:dark` aus `style.css` (`client/src/dark.css`, nach CSS-Änderungen neu ausführen).
- Bestätigungen (Spiel beenden, Spieler entfernen …) als eigener Dialog statt Browser-Popup; das Tutorial ist über
  „Tutorial wiederholen“ unten auf der Startseite jederzeit erreichbar; Datum im Spiel nur „Dienstag, 12:00“.

## Accounts

Oben rechts **👤 Anmelden** – ohne Account geht alles wie bisher. Mit Account:

- **Registrieren/Anmelden** mit Benutzername (oder E-Mail) und Passwort; man bleibt 180 Tage angemeldet (Cookie,
  verlängert sich bei Benutzung). Der Name wird beim Erstellen/Beitreten automatisch eingetragen, in Lobbys steht
  👤 neben Spielern mit Account (antippen = Profil).
- **Spielstand auf allen Geräten**: Lernpfad, gemerkte Linien, Lernstand, Tutorial, Trainings-Wiederholungen und
  Einstellungen. Beim Anmelden auf einem Gerät wird der Browser-Stand mit dem Account zusammengeführt (Fortschritt
  geht nie verloren), danach gilt der Account (`client/src/account.ts`, `client/src/boot.ts`).
- **Level & XP** (auch ohne Account, siehe „Mein Wien“): Runde 5 + Punkte/20, Routenjagd 20 (+30 Sieg), Quiz 10 +
  Punkte/50 (+20 Sieg), Trainingsstrecke 10–20, Strecke des Tages 3 × (15 + Punkte/20), Tages-Challenge: das erste Spiel einer Challenge am Tag ×2, Kurs 40 (+60 gemeistert), Tutorial 50.
  Level 2 bei 100 XP, jedes weitere Level 50 XP mehr (`shared/career.ts`). Als Gast gesammelte XP zählen nach dem
  Anmelden mit.
- **Medaillen** (17, davon 2 geheim) in Stufen Bronze/Silber/Gold, z.B. Stammgast (1/10/50 Routenjagden), Volltreffer,
  Schlauer als die Auskunft, Sieger, Quiz-Ass, Trainingsfleißig, Netzkenner (Kurse geschafft + gemeistert), Dranbleiber
  (Serie 3/7/30 Tage), Strecke des Tages, Entdecker (Stationen), Bim-Fan (Gold = alle Bim-Linien), Nachteule,
  Gesellig, Aufsteiger; geheim: Blindflug, Geisterstunde. Profil zeigt Fortschritt zur nächsten Stufe; neue Stufen
  werden gemeldet – auch ohne Account.
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

- **Übersicht**: Kennzahlen (Besucher online/heute, laufende Spiele, Accounts, mit E-Mail), Grafiken (Besucher online
  mit/ohne Account, Besucher je Tag, Accounts je Tag – neu angelegt bzw. schon länger dabei und gespielt –, Gespielt je
  Tag nach Routenjagd/Tages-Challenge/Quiz/Strecke des Tages/Training mit Mehrspieler-Anteil, Lobbys und Spieler,
  meistgewählte Linien, Lernpfad je Kurs; Zeitraum 24 h/7/30/90 Kalendertage, Tooltips, Tabellenansicht) und alle
  Lobbys – verwalten wie vom Host: starten, pausieren/fortsetzen, Runde abbrechen, weiter, beenden, Spieler entfernen,
  Host-Rechte vergeben, als „Spielleitung“ in den Chat schreiben. Besucher werden über eine zufällige Kennung je
  Browser gezählt (`/api/ping`, kein Bezug zur Person).
- **Accounts**: suchen, alles sehen (Gespieltes, Routen, Lernpfad, Medaillen; Grafiken: Gespielt je Tag, Ø Routenpunkte,
  meistgenutzte Linien – 30/90/365 Tage), Passwort setzen, **Link zum Zurücksetzen** (1 h), auf allen Geräten abmelden,
  Statistik zurücksetzen, umbenennen, E-Mail ändern, löschen. **Ohne Account**: Besucher ohne Account – gerade online,
  wer gerade in einer Lobby ist (Spielername), Browser der letzten 90 Tage (Kurzkennung, erster/letzter Besuch, Tage
  da), wie viele wiederkommen und wie viele inzwischen einen Account haben.
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

**Jede Linie nur auf ihrer Route** (`mainPatterns` in `server/timetable.ts`, `keepMainRoutes` in `server/network.ts`):
die Route ist die Haltefolge mit den meisten Werktagsfahrten – verlängert auf eine längere, die sie ganz enthält und
regelmäßig fährt (≥ 20 % der Fahrten; S7 bis Leopoldau) – und ihr Gegenstück in der Gegenrichtung. Erlaubt sind nur
Fahrten auf einem durchgehenden Stück davon (U1 nur bis Alaudagasse); Werks- und Sonderfahrten fallen aus Fahrplan und
Netz (18er nicht mehr Stadion → Winckelmannstraße, 92B werktags nur ab Donaustadtbrücke). Was ein Netzplan ausdrücklich
als Zusatzfahrt anlegt, bleibt.

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
     (Wiener-Linien-Auskunft). Bei *Regulär*: **Nur fahrende Linien** – beim Eintippen nur Linien vorschlagen, die in
     der Stunde ab der gewählten Uhrzeit unterwegs sind (`runningLines` in `server/timetable.ts`; Nachtschicht und Dickmacks Donnerstag haben es immer an). Standard: an
     (alte gespeicherte Einstellungen „aus“ werden einmalig verworfen, `runningDefault` in `client/src/store.ts`).
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
     Diese Runden haben doppelte Zeit, höchstens +2:30 – „Ohne U-Bahn“ bekommt fix +4:00. Zu Beginn jeder solchen Runde
     zeigt ein Fenster die Einschränkung.
   - **🏳️ Aufgeben:** jede Person kann eine Runde aufgeben (0 Punkte) – im Mehrspieler spielen die anderen weiter.
   - **Logo** oben links → Startseite (in einer Lobby oder im Spiel mit Rückfrage).
   - **💡 Tipps** – Keine / Günstig / Teuer (günstig 5 Prozentpunkte billiger, teuer 20 teurer; bei X-treme immer teuer):
     Linien am Start / am Ziel, Verkehrsmittel-Kette, Umstiegsorte. Bei X-treme „ohne Namen“ zeigen die Tipps keine
     Stationsnamen, beim Umstiegs-Tipp nur „U6 ⇄ S1“; „ohne Karte“ zeichnet nichts ein. Keine Fußweg-Entfernungen.
   - **Route eingeben**: Linie wählen → Einstieg (nächstgelegene Haltestelle, ggf. mit Fußweg) → Ausstieg. Die
     Ausstiegs-Liste zeigt die ganze Linie von der nördlicheren Endstation nach unten zur anderen (z.B. U1 Leopoldau …
     Oberlaa), die Einstiegs-Station steht markiert und nicht wählbar mittendrin.
     Hält die Linie an der Station nur in eine Richtung (Schleifen/Einbahnen, z.B. 40 bei Schöffelgasse), wird die
     Gegenrichtung ab der nächsten Haltestelle (bis 700 m) angeboten – inkl. Fußweg dorthin.
     Jeder Fußweg zeigt seine Dauer in Klammern („560 m zu Fuß (≈ 9 min)“). **Über die Donau** (Donau, Neue Donau)
     geht man nur über eine Brücke: schneidet der gerade Weg den Fluss, zählt der Umweg über die nächste Donaubrücke
     („· über die Reichsbrücke“, auf der Karte mit Knick) – in Auswertung, Referenzroute und Baukasten gleich
     (`shared/barrier.ts`, Daten aus `data/water.json` und `data/bridges.json`, `/api/barrier`; ohne Daten Luftlinie). Jede Fahrt lässt sich mit ✕ entfernen,
     auch mittendrin (dazwischen wird dann gegangen). Ein Fußweg **mitten in der Route oder am Anfang** (dort bleibt er
     eine leise Zeile) lässt sich mit „➕ Linie einfügen“ füllen: ein reiner Einfügemodus ohne Vorschläge – die nächste eingegebene Linie
     kommt an die Stelle des Fußwegs statt ans Ende (Fahrt danach steigt am neuen Ausstieg ein); „Beenden“ verlässt
     den Modus. Fährt dieselbe Linie davor oder danach weiter, wird daraus eine Fahrt – ebenso, wenn man nach einer Fahrt
     dieselbe Linie ab dem Ausstieg weiter eingibt (U1 bis Kagran, dann U1 ab Kagran → eine U1-Fahrt).
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
7. **Lobby weg** (z.B. Seite nach Stunden wieder geöffnet): Der Server antwortet mit `code: 'not-member'`; der Browser
   geht dann sofort zur Startseite und erklärt es in einem Fenster – auch schon beim Zurückkehren in den Tab, nicht
   erst bei der nächsten Aktion (`apiHooks.notMember`, `visibilitychange` in `client/src/store.ts`).

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

**Kurs-Tipp** nach der Routenjagd (`client/src/coach.ts`, Fenster in `screens/coachTip.ts`): Jedes Spiel wird
gemerkt (letzte 8, mit Account synchronisiert) – Ø Routenpunkte und in schwachen Runden (< 700) die Linien der
schnellsten Verbindung, die man nicht nahm, je Kurs (U-Bahn, S-Bahn, Busse, Bims ins Zentrum/rundherum, Donau, Süden,
Nacht). Frühestens nach 2 Spielen, dann höchstens alle 3 Spiele und einmal in 20 h: Wer insgesamt schwach ist (Ø unter
45 %) und noch keinen Kurs gemacht hat, wird gefragt, ob er mit dem Lernpfad anfangen will; sonst kommt der Kurs, dessen
Linien zuletzt am öftesten fehlten (gemachte Kurse erst bei deutlich mehr Fehlern, gemeisterte nie). „Kurs starten“
verlässt das Spiel und öffnet den Kurs, „Später“ legt ihn eine Woche weg. Nicht bei Tages-Challenges.

**Lernmodus** (Startseite, ohne Lobby) – drei Einstiege, keine Einstellungen vorab:
- *🎓 Lernpfad*: die geführten Kurse in fester Reihenfolge („Weiter mit …“): U-Bahn-Kreuzungen → S-Bahn
  (Stammstrecke, Äste S1/S2/S3+S4, S7, S40/S50/S60 als Pendlerzüge ins Umland, S45 und S80 einzeln mit Umstiegen; Aufgabe „Welche S-Bahn ist welche?“: farbige Strecken mit Buchstaben, Linien
  per Ziehen oder Antippen zuordnen) → Radiallinien → die Ringe →
  über die Donau & Transdanubien (Brücken; U6/U1/U2 als „Finger“, Bims 25/26/27 quer, Busse von der U1 zur U2,
  Zubringer je U-Bahn-Knoten) → der Süden (Meidling, Liesing, Favoriten, Simmering: U6/U1/U3, S-Bahn, Knoten,
  Bims 6/11/71/62/BB/1, 60er/70er-Busse) → Busnummern (Zehnerstelle läuft gegen den Uhrzeigersinn um die Stadt)
  → Nachts in Transdanubien. Inhalte und Fragen werden aus den Netzdaten berechnet (`client/src/learn/courses/`),
  jede Frage hat genau eine richtige Antwort. Alle Schritte zeigen dieselbe Netzkarte und blenden nur hervor
  oder aus, mit knappem Rand eingepasst; bei Fragen bleibt die Karte leer, in der Auflösung erscheinen die Linien der
  Frage (`quizLines`), bei Aufgaben nie das ganze Netz (sonst die Linien aus Frage/Erklärung oder nur die Station).
  „Wohin fährt …“ zeigt die bekannte Endstation als A, „In welcher Reihenfolge …“ A und einen Richtungspfeil.
  „Zeichne die X von A nach B“ zeigt A und B mit Namen; eigene Tipps und Zeichnungen
  verschwinden beim nächsten Schritt. Kurse mit eigenen, machbaren Aufgaben (Kreuzungen mit der U-Bahn) – sonst
  kämen zufällige Aufgaben aus den Kurslinien (z.B. „Wohin fährt der 84A?“). Ein entfernter Kurs (Querverbindungen)
  zählt nicht mehr für Level und Medaille (`COURSE_IDS` in `shared/career.ts`). Liniennummern im Kurstext sind antippbar (Steckbrief, „← zurück zum
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
| Route | 50–1000 (+300) | 1000 nur für die beste Zeit; in der Toleranz max(1 min, 4 %) sanft bis 980 (44 statt 43 min = 988), danach fallend; ab +70 % Reisezeit 50 fürs Ankommen (z.B. 40 → 60 min ≈ 195). Besser als die beste gefundene Route: je 1 % besser +2 %, max. 1300 (z.B. 27 statt 30 min = 1200) |
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
