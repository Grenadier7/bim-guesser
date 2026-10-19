# 01 – Strukturbewertung (Phase 1)

Branch `refactor/structure`, Ausgangsstand `ce66c98`. Grundlage: eigene Durchsicht aller Module, Import-Graph
und drei parallele Reviews (Client, Server, Algorithmen/Deploy; deren Befunde stehen in `AGENT_PROGRESS.md` und
fließen in `02-befunde.md`). Hier geht es nur um **Aufbau**: Was ist gut, was nicht, warum, und was wurde in dieser
Phase **ohne Verhaltensänderung** umgebaut.

## Überblick

```
shared/   Regeln, Typen, Quiz-Generator, Standardwerte – läuft auf Server UND im Browser (keine Imports nach außen)
server/   Express 5: app.ts (createApp) · routes/ · game/quiz/lobby/manager (Spielzustand) · routing/efa (Auskunft)
client/   Vite + Leaflet, ohne Framework: screens/ (je Bildschirm eine Funktion) · learn/ (Lernmodus, Kurse) · Karte
scripts/  build-network (Netzdaten aus OGD + EFA) · host/release · smoke (Klick-Durchlauf)
test/     node:test – Einheit/Charakterisierung, API gegen echten Server-Prozess, e2e/ mit playwright-core + Edge
```

Rund 11 500 Zeilen TypeScript, Node 24 mit nativem Type-Stripping (kein Build-Schritt für den Server).

## Was gut ist (behalten)

| Punkt | Warum gut |
|---|---|
| **`shared/` als gemeinsamer Kern** (Wertung, Einstellungen, Quiz-Fragen) | Server rechnet die Punkte, Client zeigt dieselben Regeln an → keine Abweichungen; Logik ist ohne Browser testbar. Import-Graph geprüft: `shared/` importiert nichts aus `server/` oder `client/`. |
| **Server ist die Autorität** (Lösungen, Punkte, Zeitlimits) | Schummeln über den Browser bringt nichts; Mehrspieler-Zustand an einer Stelle. |
| **Keine Laufzeit-Zyklen** im Import-Graph | Module laden in definierter Reihenfolge; Aufteilen ist gefahrlos möglich. |
| **Wenige Abhängigkeiten** (express, leaflet; dev: vite, typescript, playwright-core) | Kleine Angriffsfläche, schneller Docker-Build, nichts Natives. |
| **Strenger Typecheck** (`strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`) | Fängt viel ab, obwohl es keinen Linter gibt. |
| **Kurse als Daten + kleine Generatoren** (`learn/courses/*.ts`, je Kurs eine Datei) | Neue Kurse ohne Eingriff in die Engine; jede Datei ist überschaubar (40–200 Z.). |
| **Bildschirm = Funktion `(panel) → Screen`** mit `dispose()` | Einfaches, einheitliches Muster; kein Framework nötig. |

## Was schlecht war – und was in Phase 1 umgebaut wurde

Alle Schritte einzeln committet; nach jedem Schritt Typecheck, `npm test`, `npm run e2e`, `npm run smoke` grün.

| # | Problem | Warum schlecht | Umbau (Commit) |
|---|---|---|---|
| S1 | **Kaum Tests für Server-API und Oberfläche** (32 Tests nur für Regeln/Kurse/Quiz) | Umbau ohne Sicherheitsnetz; Regressionen erst im Spiel bemerkt | Charakterisierungstests: API (17, echter Server-Prozess), Netzgraph (6), E2E-Gerüst (6 Tests, 3 Bildschirmgrößen) – `883ba3e`, `1a35228` |
| S2 | **Doppelte Helfer**: `distM` 4×, `normName` 2×, `shuffle`/`pick` 3×, „reguläre Haltefolgen“ 4×, Sonderlinien-Regex 2× | Änderungen müssen mehrfach passieren; Abweichungen schleichen sich ein | `shared/geo.ts`, `shared/random.ts`, `regularPatterns`/`isSpecialLine` in `shared/rules.ts` – `2f3d5f2` |
| S3 | **`netmap.ts` mischte Graph-Berechnung und Leaflet-Darstellung** (600 Z.) | Graph (Kurven, Fahrtrichtungen, Endstationen) nicht ohne Browser testbar | `client/src/netgraph.ts` (rein, testbar) + `netmap.ts` (Darstellung) – `c03cbcf` |
| S4 | **`screens/quiz.ts` = 4 Bildschirme in einer Datei**, Einstellungs-Bausteine (`seg`, `infoTip`, `toggleInfo`) lagen in der Routenjagd-Lobby und wurden vom Quiz von dort importiert | Falsche Abhängigkeitsrichtung (Quiz → Routenjagd-Lobby), schwer zu navigieren | `screens/quiz/{common,lobby,question,reveal,final}.ts`, `client/src/widgets.ts` – `686233e` |
| S5 | **Toter Code**: `showLocateAnswer`, `resetBoxes`, `nextSlotDate`, `MIN_TRANSFER_MAX`, `store.mode`, Lobby-`toggle()`; ~260 Zeilen CSS für 24 nicht mehr verwendete Klassen | Verwirrt beim Lesen, CSS-Last | entfernt; `noUnusedLocals` dauerhaft an – `2e57910`, `d338f31` |
| S6 | **Eingabeprüfung in `game.ts`** (`sanitizeSettings`, `cleanLegs`), Training importierte sie aus dem Spielmodul | Training hängt an der Routenjagd-Klasse; Prüfungen nicht isoliert getestet | `server/settings.ts` + 8 Charakterisierungstests (inkl. alter Formate) – `1928353` |
| S7 | **`server/index.ts` startete beim Import** (Netz laden, Express, `listen`) | Nicht in-process testbar; für Accounts (DB, Mail) braucht es eine zusammensetzbare App | `server/app.ts` (`createApp`), `routes/games.ts`, `routes/training.ts`, `http.ts`; `index.ts` = 12 Zeilen – `2327084` |
| S8 | **localStorage-Helfer 4× mit leicht unterschiedlicher Semantik** | Fehlerquelle; für Fortschritts-Sync (Accounts) braucht es eine Stelle | `client/src/storage.ts` (`loadJson`, `loadMerged`, `saveJson`) + Tests – `ed90e10` |
| S9 | **Stadtmitte 2× definiert** | | `CENTER` in `shared/geo.ts` – `6baa6ed` |
| S10 | **Keine `docker-compose.yml`** im Repo (nur Snippet für den Server) | `docker compose up --build` aus der Aufgabe nicht möglich | `docker-compose.yml` (Build, Volume, `init`, `mem_limit`) – `3cfd552`; geprüft: startet, `/api/health` ok, `docker compose stop` < 1 s |

Nebenbei gefunden und **als Fix** (nicht als Umbau) behoben, weil der Fehler die Testsuite zufällig rot machte:
Quiz-Umstiegsfrage konnte Sonderlinien (71E) als Ziellinie nehmen – `e78d6d5`, mit deterministischem Regressionstest.

## Was bewusst (noch) nicht umgebaut wurde

| Punkt | Begründung |
|---|---|
| Große Render-Funktionen (`screens/lobby.ts` render ~270 Z., `screens/training.ts` ~350-Z.-Closure, `NetMapLayer.render` ~200 Z.) | Ohne Verhaltensänderung nur mechanisch zerlegbar; die Client-Befunde C-H3/C-H4 (komplettes Neu-Rendern bei jedem SSE-Event, verworfene Einstellungs-Patches) verlangen ohnehin ein anderes Update-Modell → in Phase 3 zusammen mit dem Fix. |
| `colorOf` (Lernen) vs. `lineColor` (Spiel) | Kein echtes Duplikat: Netzkarte zeigt ruhige Farben je Verkehrsmittel, das Spiel Linienfarben. Bewusst getrennt, jetzt dokumentiert. |
| `server/game.ts` (506 Z.) | Nach Abtrennung der Eingabeprüfung zusammenhängend (Rundenablauf + Wertung); weitere Aufteilung erst mit den Fixes S-H1/S-M1/S-M2 (Auswertung, Abbruch, Pause), sonst doppelte Arbeit. |
| Wiederholte UI-Bausteine (Spielerliste, Podium, Link kopieren, Verlassen) in Routenjagd und Quiz | Unterscheiden sich in Details (Punkte vs. Prozent, Host-Steuerung); Vereinheitlichung ändert sichtbares Verhalten → Phase 3/5. |
| Linter (ESLint) | `tsc` mit `strict` + `noUnusedLocals` deckt das Wichtigste ab. Ein Linter hätte hunderte Stil-Meldungen ohne Nutzen für das Verhalten → als Vorschlag in Phase 5. `noUnusedParameters` erst nach dem Fix von R-3 (ein ignorierter Parameter ist dort der Fehler). |
| `efa.ts` / `routing.ts` | Die Algorithmus-Befunde (A-H1 Abdeckungslücken, A-H2 Speicher) betreffen genau diese Struktur – Umbau zusammen mit den Fixes und Regressionstests mit gemockter Auskunft. |

## Ergebnis

| Prüfung | vorher (`ce66c98`) | nachher (`6baa6ed`) |
|---|---|---|
| Typecheck | 0 Fehler | 0 Fehler, zusätzlich `noUnusedLocals` |
| Tests | 32 | 67 Einheit/API + 6 E2E + Klick-Durchlauf |
| `docker compose up --build` | nicht möglich | ✅ |
| größte Datei | `netmap.ts` ~600 Z. | `shared/quiz.ts` 678 Z. (Fragetypen; zusammenhängend) |
