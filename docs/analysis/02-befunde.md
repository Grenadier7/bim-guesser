# 02 – Befunde (Phase 2)

Branch `refactor/structure`. Quellen: Testmatrix im Browser (`test/e2e/matrix.e2e.ts`, `multiplayer.e2e.ts`),
Barrierefreiheit (`test/e2e/a11y.e2e.ts`, axe-core), Sicherheit (`test/security.test.ts`), Messungen
(Spielstart mit leerem Cache), handgerechnete Wertungsfälle, Code-Durchsicht. Befunde, die als Test nachweisbar sind,
stehen dort als `todo`-Test mit derselben ID; in Phase 3 wird aus jedem todo ein normaler Regressionstest.

**Status** (Phase 3): ✅ behoben (Commit, Regressionstest) · ⏸ bewusst nicht behoben (Begründung).

Schweregrade: **kritisch** = Absturz/Datenverlust für alle · **hoch** = Spiel für Einzelne kaputt oder unfair ·
**mittel** = spürbarer Fehler mit Umweg · **niedrig** = Schönheitsfehler/Randfall.

## Testmatrix (2a) – Ergebnis

| Bereich | Zeilen | Ergebnis |
|---|---|---|
| Routenjagd | 13: Leicht/Mittel/Schwer/Profi/Eigene, alle 4 Uhrzeiten, aktuelles/reguläres Netz, Fokus 90 %, alle Busse, X-treme ×3, Zeitlimit 20 s (Minimum, läuft ab), ohne Limit, 1 und 3 Runden, Challenges immer, Tipps günstig/teuer, Ortung an/aus, Abbruch durch Host | 13/13 durchgespielt ohne JS-/Konsolen-/Serverfehler (nach Testkorrektur für X-treme-Texteingabe) |
| Training | 3: Leicht/Profi/Mittel, Coach an/aus, Schwerpunkt-Bezirk, Sa 2 Uhr | 3/3 |
| Quiz | 10: 5/20 Fragen, 10 s ablaufen lassen, 1./23. Bezirk, nur Nachtbus, nur Bus, nur S-Bahn, Zeichnen/Ortung bevorzugt | 10/10 |
| Lernen | alle 9 Kurse, Netzkarte, Steckbrief, Vergleich, Üben (Klick-Durchlauf `npm run smoke` + `learn-quiz.e2e.ts`) | grün |
| Mehrspieler/Grenzfälle | 13: gleiche Namen, Einladungslink, falscher Code, Host verlässt, Host-Tab zu, Sonderzeichen/HTML/Emoji, Doppelklick Beitreten/Starten/Weiter, Neuladen, Zurück-Taste, zweiter Tab, gleichzeitige Antworten, Gast verlässt Quiz | 11/13 – Befunde M-01, D-10 |
| Barrierefreiheit | 7 Bildschirme × Handy/Desktop | kein horizontales Scrollen; Befunde U-01…U-06 |

## Kritisch

| ID | Befund | Reproduktion | Erwartet / Tatsächlich | Dateien | Lösung | Status |
|---|---|---|---|---|---|---|
| K-01 (=D-01, A-K1, S-H1) | **Server stürzt ab**, wenn die Auskunft während einer zeitgesteuerten Auflösung ausfällt | `security.test.ts` „Auskunft fällt während der Auflösung aus“; `evidence/agentC/crash.ts` | Runde wird mit Fehlermeldung aufgelöst / Prozess endet (exit 1) – alle Lobbys weg. Die abgelehnte Promise bleibt außerdem in `revealing` gespeichert → jede weitere Abfrage scheitert | `server/game.ts` (armTimer → `void this.reveal`), `server/routing.ts` chainRoute/evaluateUserRoute | reveal() fängt Auswertungsfehler je Spieler ab (Route = nicht auswertbar, 0 Punkte + Hinweis), `revealing` bei Fehler löschen, `process.on('unhandledRejection')` als Netz loggen statt sterben | ✅ `3b04bc8` |

## Hoch

| ID | Befund | Reproduktion | Erwartet / Tatsächlich | Dateien | Lösung | Status |
|---|---|---|---|---|---|---|
| H-01 (=N-6) | **Spielstart dauert 6–21 s** (Nutzer-Meldung „dauert oft ziemlich lang“) | Messskript: Start mit leerem Cache, je 3×: Mittel 6–21 s / 36–72 Abfragen, Schwer 10–13 s / 44–107, Profi 9–10 s / 59–73 | wenige Sekunden / jedes verworfene Stationspaar kostet die volle Rechnung (6 Stichproben + ~30 Fahrplan-Abfragen), die Mindest-Umstiege werden erst danach geprüft; „Linie gesperrt“ rechnet zweimal voll; höchstens 4 parallele Abfragen | `server/game.ts` prepare, `server/routing.ts` topRoutes, `server/efa.ts` MAX_PARALLEL | Paar schon nach den Stichproben verwerfen, wenn keine Kandidaten-Route genug Umstiege hat; für „Linie gesperrt“ nur Stichproben; 6 parallele Abfragen | ✅ `1b49cfa` – gemessen (leerer Cache): Mittel 6–21 s → 3–8 s, Schwer 10–13 s → 4–6 s, Profi 9–10 s → 4–7 s |
| H-02 (=A-H3) | Scheitert die Vorbereitung einer **späteren** Runde, fliegen alle zurück in die Lobby, Punkte weg (Nutzer: „manchmal stürzt ein Spiel ab“) | Auskunft fällt bei Runde 3 aus / „Keine passende Strecke“ | Runde neu versuchen, sonst Spiel mit den gespielten Runden beenden / `openRound` setzt `phase='lobby'`, `rounds=[]` | `server/game.ts` openRound | Vorbereitung erneut anstoßen; wenn endgültig: Spiel als beendet werten (Endstand bleibt) | ✅ `1e8c456` |
| H-03 (=A-H1) | Ø-Wartezeit hängt davon ab, welche Fahrplan-Abschnitte zufällig geladen sind | `evidence/agentC/synth2.ts`: U1 im 60-min-Abschnitt + U3 alle 3 min → Umstieg 13 statt ≤ 2 min | lückenlose Abfahrten im Fenster / `firstAfter` lädt ab `max(t, coveredUntil)`, `departures(t < coveredFrom)` lädt nicht nach → Lücken | `server/routing.ts` LegTimetable | Abdeckung als Intervall führen und Lücken gezielt nachladen | ✅ `1b49cfa` (Umstieg 13 → ≤ 2 min, `test/routing.test.ts`) |
| H-04 (=S-H2, A-H2) | Speicher-Cache der Auskunft kann ~530 MB erreichen (5000 × ~106 KB rohes JSON) > `mem_limit 384m` | Rechnung + Messung im Review | begrenzt / Container wird bei viel Betrieb vom OOM-Killer beendet | `server/efa.ts` memCache | nur geparste Fahrten cachen, LRU 500 Einträge | ✅ `4b17e22` |
| H-05 (=C-H1, C-H2) | Abgabe schlägt fehl (Netzfehler, 5xx) → Spieler hängt auf „Abgegeben“, Eingabe gesperrt | Code: `round.ts` submit() setzt `view='waiting'`, `b.lock()` vor dem Request, im catch nur Toast; Quiz gleich | Eingabe wieder frei + Meldung / steckt bis Rundenende (ohne Zeitlimit für immer) | `client/src/screens/round.ts`, `client/src/screens/quiz/question.ts` | im Fehlerfall zurücksetzen (außer bei Zeitablauf) | ✅ `0942ae2` (`test/e2e/errors.e2e.ts`) |
| H-06 (=D-03, S-M3) | **Lösung im öffentlichen Zustand** (Quiz) | `security.test.ts` D-03 | Antwort erst nach Auflösung / „Linie erkennen“: `drawLineId === correct`; „Querverbindung“: `drawLines[2] === correct` (mit DevTools ablesbar) | `shared/quiz.ts`, `server/quiz.ts` | Zeichenlinie ohne ID senden (nur Geometrie) bzw. Antwortlinie erst in der Auflösung | ✅ Querverbindung `3e0a618` · ⏸ „Linie erkennen“: die Linie muss gezeichnet werden, der Client kennt das ganze Netz – die Form verrät sie auch ohne ID |
| H-07 (=D-04) | Start/Ziel-Namen und Koordinaten im Zustand, obwohl X-treme „ohne Namen“ bzw. „Wo liegt das?“ sie verstecken soll | `security.test.ts` D-04 | erst nach Ortung bzw. nie Namen / immer enthalten | `server/game.ts` state() | Felder je nach Einstellung und Phase weglassen | ⏸ bewusst: der Routen-Baukasten läuft im Browser und braucht die Start-Station (ID → Name/Lage aus den öffentlichen Netzdaten). Echte Abhilfe = Baukasten auf dem Server, unverhältnismäßig für ein Freundesspiel |

## Mittel

| ID | Befund | Reproduktion | Erwartet / Tatsächlich | Dateien | Lösung | Status |
|---|---|---|---|---|---|---|
| M-01 | Host schließt den Tab → bleibt Host, Gäste können nicht starten | `multiplayer.e2e.ts` „Host schließt den Tab“ | Host geht nach Abmeldung (15 s) an verbundenen Spieler / bleibt beim getrennten | `server/lobby.ts` | bei Disconnect (und in der Lobby) Host an ersten verbundenen Spieler übergeben | ✅ kein App-Fehler: Host-Übergabe gab es schon (15,5 s nach Abbruch), der Test prüfte zu früh – Test korrigiert `10a9f6f` |
| M-02 (=D-02, S-M4) | 100 Lobbys global – wenige Clients sperren den Server für alle (503) | `security.test.ts` D-02 | Limit pro IP / 10 IPs × 10 Lobbys reichen | `server/manager.ts` | Limit je IP (z.B. 5 offene Lobbys), leere Lobbys schneller aufräumen | ✅ `da653d3` (20 je IP, 500 gesamt, Räumen nie verbundener/verlassener Lobbys) |
| M-03 (=A-M1) | Leerer Stationspool → TypeError statt verständlicher Meldung; „Wichtige S + Nacht + kurz + 10 Runden“ bricht ~1/20 ab | Code `network.ts` randomPair | Meldung „zu wenige Stationen“ / 500 bzw. Spiel zurück in Lobby | `server/network.ts` | GameError; Pool vorher prüfen | ✅ `1e8c456` |
| M-04 (=S-M1, S-M2) | Abbruch/„Zurück zur Lobby“ während einer laufenden Auswertung → Punkte landen trotzdem/im neuen Spiel; Abgaben während der Auswertung angenommen aber mit 0 Punkten | Code `game.ts` | Generation prüfen; Abgaben nach Zeitende ablehnen | `server/game.ts` | Generationsprüfung nach jedem await in reveal | ✅ `3b04bc8` |
| M-05 (=A-M4, S-M8) | Disk-Cache wird nie aufgeräumt (lokal 1,15 GB, 95 % abgelaufen), Fehlerantworten werden 3 Tage gecacht | `dir state/cache` | Aufräumen / wächst unbegrenzt | `server/efa.ts` | beim Start + täglich abgelaufene Dateien löschen; nur erfolgreiche Antworten mit Fahrten cachen | ✅ Aufräumen `4b17e22` · ⏸ „Fehlerantworten gecacht“: Format der Fehlerantworten der Auskunft unbekannt (nur echte HTTP-Fehler werden schon nicht gecacht) |
| M-06 (=A-M5) | Training wertet anders als die Routenjagd (beste = schnellste, ohne Umstiegsstrafe), festes Paar wird nicht geprüft | Code `training.ts` | gleiche Logik / abweichend | `server/training.ts` | sortRoutes wie im Spiel, Paar validieren | ✅ Fehlerfälle `1e8c456` · ⏸ Training vergleicht bewusst mit der *schnellsten* Verbindung (so im Trainings-Bildschirm erklärt) |
| M-07 (=A-M6) | Referenztage Juni 2026: nach dem Fahrplanwechsel (Dez.) bzw. außerhalb des Auskunfts-Horizonts liefert „Reguläres Netz“ nichts mehr | `scripts/build-network.ts` PREFERRED_DAYS | Warnung beim Start / still kaputt | `server/index.ts`, `server/network.ts` | Startprüfung: Referenztag > ~5 Monate alt → Warnung im Log + Health | ✅ `69736d9` |
| M-08 (=D-06, S-N1) | `{"token":{"toString":1}}` u.ä. → 500 + Stacktrace im Log | `security.test.ts` D-06 | 400 / 500 | `server/http.ts` token(), Spiel-Handler | Request-Felder typprüfen (nur string/number) | ✅ `cb7ef5e` |
| M-09 (=C-M1) | Enter im Code-Feld + Klick → zwei Join-Anfragen | Code `home.ts` | eine / zwei (im Test nur 1 Spieler, weil die zweite nach Wechsel ins Leere läuft – Race bleibt) | `client/src/screens/home.ts` | Sperre während Join | ✅ `10a9f6f` |
| M-10 (=C-H3, C-H4) | Lobby rendert bei jedem SSE-Event komplett neu → Regler-Ziehen/Fokus geht verloren; Einstellungs-Änderungen während eines laufenden Requests werden verworfen | Code `lobby.ts`, `quiz/lobby.ts` | Eingabe bleibt / springt | `client/src/screens/lobby.ts`, `quiz/lobby.ts` | Patches sammeln und nachsenden; während Drag kein Re-Render | ✅ `844e0c7` |
| M-11 (=C-M4) | Auflösung lädt nicht (Netzfehler) → Spinner für immer | Code `reveal.ts` | Fehlermeldung + Nochmal | `client/src/screens/reveal.ts` | catch mit Retry-Knopf | ✅ `657dafa` |
| M-12 (=A-M3) | EFA-Last: `departures` lädt immer 180 min, gesperrte Linien werden erst nachträglich gefiltert | Code | | `server/routing.ts` | mit H-01 | ✅ mit H-01 `1b49cfa` |
| U-01 | Bezirksauswahl im Quiz ohne Beschriftung (axe „critical“) | `a11y.e2e.ts` quiz-lobby | Label / keins | `client/src/screens/quiz/lobby.ts` | `aria-label` | ✅ `9fd6343` |
| U-02 | Kontrast grauer Text `#6b7280` auf `#eef0f3` = 4,23:1 (Startseite, Lobby, Training) | `a11y.e2e.ts` | ≥ 4,5:1 | `client/src/style.css` (--muted) | dunkleres Grau `#5b6170` | ✅ `9fd6343` |

## Niedrig

| ID | Befund | Erwartet / Tatsächlich | Dateien | Lösung | Status |
|---|---|---|---|---|---|
| L-01 (=A-N, S-N7) | Ukey-Faktor 0,85 wirkungslos: `Math.max(…, 0.9)` | „nur wichtige U, kurz, 0 Umstiege“ ×0,77 / ×0,81 | `shared/rules.ts` difficultyMultiplier | Untergrenze 0,85 | ✅ `dacbaf5` |
| L-02 (=S-N6) | „Max. Punkte pro Runde“ ignoriert den Bonus für bessere Routen | Profi + Ortung: angezeigt 2113, erreichbar 2670 (Hand: (1300 + 130 + 150) × 1,69) | `shared/rules.ts` maxRoundPoints | 1300 statt 1000 rechnen | ✅ `dacbaf5` (Lobby zeigt „bis 2.670 mit einer besseren Route“) |
| L-03 | Ø-Wartezeit diskret: 10-min-Takt → 4,5 statt 5 min, 15-min-Takt → 7 („alle 14 min“) | `server/routing.ts` expectedWait | stetig: Σ Lücke²/2 ÷ Fenster | ✅ `dacbaf5` |
| L-04 | Zeitbonus bei negativer verstrichener Zeit > 10 % | `shared/rules.ts` timeBonus | auf [0,1] klemmen | ✅ `dacbaf5` |
| L-05 | scoreRoute(NaN, x) = NaN | `shared/rules.ts` | NaN → 0 | ✅ `dacbaf5` |
| L-06 (=D-10, S-N3) | Namen: Familien-Emoji (ZWJ) wird zerlegt, 20-Zeichen-Schnitt kann ein Emoji halbieren, unsichtbare Namen (U+3164) möglich | `server/security.ts` cleanName | nach Graphemen kürzen (Intl.Segmenter), ZWJ erlauben, unsichtbare Zeichen entfernen | ✅ `cb7ef5e` |
| L-07 (=D-09) | Lobby-Code-Existenz über 404/403 erkennbar | `routes/games.ts` | gleiche Antwort | ✅ `aa58185` |
| L-08 (=S-N8) | „Wo liegt?“ voll bis 200 m (Quiz) vs. 250 m (Routenjagd) | `shared/quiz.ts` | angleichen | ✅ `dacbaf5` |
| L-09 | Schulferien: Pfingsten 2027 fehlt, Liste endet 2027-09 | `server/timeslots.ts` | ergänzen | ✅ `69736d9` |
| L-10 (=A-M7) | `release.ts` taggt jeden Branch | `scripts/release.ts` | nur auf `master` | ✅ `22a7fe9` |
| L-11 | kein SIGTERM-Handler → Statistik geht bei `docker stop` verloren | `server/index.ts` | Handler schreibt usage | ✅ `69736d9` (Docker-Stopp geprüft, siehe unten) |
| L-12 (=R-3) | Kurs-Steckbrief: Knopf „Vergleichen“ ohne Funktion (`lineHtml(compare)` ignoriert Parameter) | `client/src/learn/atlas.ts` | Parameter auswerten | ✅ `262a516` |
| U-03 | Liniennummern auf der Netzkarte (role=button) ohne zugänglichen Namen | `client/src/netmap.ts` | `aria-label` | ✅ `9fd6343` |
| U-04 | Stationen-Stufen (`.vtick small`) Kontrast 2,3:1, Quiz-Verkehrsmittel aus 3,8:1 | `client/src/style.css` | dunkler | ✅ `9fd6343` |
| U-05 | Touch-Ziele < 24 px: ⓘ (18 px), Checkbox 13 px, „Lobby verlassen“ 19 px hoch | `style.css` | min. 24/44 px | ✅ `9fd6343` |
| U-06 | U-Bahn-Chip U4 (weiß auf #319f49) 3,4:1 | Linienfarbe ist vorgegeben | ⏸ Originalfarbe der Wiener Linien – fett/größer ok (3:1 für fette Schrift) | ⏸ |

## Wünsche des Nutzers (in Phase 3 umgesetzt)

| ID | Wunsch | Status |
|---|---|---|
| N-1 | Linien/Busse lernen, die eine bestimmte Umgebung abdecken | ✅ `262a516` – Lernen → Üben → „📍 Linien einer Gegend“ (Bezirk oder Kreis, Verkehrsmittel wählbar) |
| N-2 | beim Linien-Lernen das durchschnittliche Intervall der Linie zeigen | ✅ `262a516` – Ø-Takt Mo–Fr früh/mittags/abends, Sa, So (gemessen an den Referenztagen, `scripts/build-headways.ts`) |
| N-3 | U-Bahnen im Lernen und überall in ihren echten Farben | ✅ `262a516` – die Abweichung war der Linienvergleich (Vergleichsfarben auch für U-Bahnen); überall sonst schon Linienfarben |
| N-4 | Auflösung: „Zeit übrig x / max“ statt „gemacht in x“ | ✅ `657dafa` – Auflösung, Warten, Endstand, Quiz; ohne Zeitlimit weiter „in 0:50“ |
| N-5 | im Linien-Joker (Tipp) Linien direkt anklicken → als Teilstrecke übernehmen | ✅ `e9b62ea` (dazu L-13: Tipp zeigte tagsüber Nachtlinien) |
| N-6 | Laden der Routen am Anfang dauert lange, manchmal stürzt ein Spiel ab | ✅ H-01, H-02, K-01 |

### Nachträglich gefunden (Phase 3)

| ID | Befund | Status |
|---|---|---|
| L-13 | Tipp „Linien am Start/Ziel“ listete tagsüber Nachtlinien (N25 …) | ✅ `e9b62ea` |
| R-5 | Quiz-Umstiegsfrage nahm Sonderlinien (71E) als Ziellinie – Testsuite wurde zufällig rot | ✅ `e78d6d5` (Phase 1) |

### Weitere Hinweise aus dem Code-Review, nicht einzeln umgesetzt

| Hinweis | Status |
|---|---|
| Browser-Zurück in Lernen/Training führt zur Startseite, Entwurf im Baukasten geht verloren (C-M10) | ⏸ braucht Routing mit Verlauf (URL je Bildschirm) – als Vorschlag für Phase 5 |
| Klein-Befunde C-N1…C-N15 (Start-Knopf-Text nach Fehler, Karte springt bei Tipp, Schrift < 12 px in Listen, Icon-Knöpfe ohne Label …) | ⏸ teils durch die a11y-Korrekturen erledigt (Labels, Touch-Ziele, Kontrast); Rest niedrig, ohne Auswirkung auf den Spielablauf |
| Defense-in-depth: Lobby-Code/IDs/Farben ohne `esc` in Templates | ⏸ alle Werte kommen vom Server aus festen Zeichensätzen (Code `[A-Z2-9]`, IDs aus Netzdaten) – kein Angriffsweg gefunden |

## Geprüft und in Ordnung

- Wertung `scoreRoute` (von Hand nachgerechnet): (30,30)=1000, (31,2;30)=1000, (32,30)=943, (38,30)=556, (51,30)=14,
  (52,30)=1, (29,30)=1067, (27,30)=1200, (24,30)=1300, (4,5)=1200, (10,0)=0 – stimmt mit dem Code überein.
- `computeScore`: 556 Routenpunkte, Tipp „Start“ günstig (−40 %) → 334, Zeitbonus 90/180 s → 17, Ortung 250 m + 1625 m → 75 + 38,
  ×1,05 → 487 ✔.
- Prototype Pollution, Pfad-Traversal, JSON-Limit, fremde Tokens, SSE-Limit pro Spieler, keine Stacktraces an Clients,
  HTML in Namen (kein XSS) – siehe `security.test.ts`.
- Neuladen, Zurück-Taste, zweiter Tab, gleichzeitige Antworten, Host verlässt (normal), gleiche Namen – keine Fehler.
- kein horizontales Scrollen auf 390 px.

## Nicht geprüft

- echter Screenreader (nur axe-Regeln), echte Mobilgeräte (nur emulierte Größen).
- Last mit vielen gleichzeitigen echten Spielen gegen die Auskunft (bewusst nicht – öffentliche API).
- Routing gegen eine unabhängige Referenz: Die Auskunft selbst ist die Referenz; geprüft wurde die Verarbeitung (H-03, L-03).
