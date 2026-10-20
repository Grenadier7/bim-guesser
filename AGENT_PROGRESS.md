# AGENT_PROGRESS – autonomer Analyse- und Entwicklungslauf

Gedächtnis des Agenten. Bei Kontextverlust zuerst lesen.

## Aktueller Stand

- **Phase:** 3 – Fixes (danach STOPP vor Phase 4 – Nutzer-Anweisung 2026-10-20)
- **Aktiver Branch:** `refactor/structure`

## Branches (max. ~7, alles lokal, nichts gepusht)

| Branch | Basis | Zweck |
|---|---|---|
| `backup/pre-agent-run` | `master` @ `ce66c98` | Sicherung vor dem Lauf – nie verändern |
| `refactor/structure` | `master` @ `ce66c98` | Phase 1 (Struktur) + Phase 2 (Analyse) + Phase 3 (Fixes) – Basis für alles Weitere |

Geplant (Phase 4/6): `feature/accounts` (Basis: Phase-3-Stand) und höchstens 4 Feature-Branches, die NICHT auf
`feature/accounts` aufbauen (Vorgabe des Nutzers).

## Entscheidungen

| # | Entscheidung | Begründung |
|---|---|---|
| E1 | `master` gilt als „main“ | `origin/main` enthält nur einen leeren „Initial commit“; alle Arbeit und Releases laufen über `master`. Auf `master` wird nichts committet. |
| E2 | Phase 1–3 auf einem Branch (`refactor/structure`), kein extra `fix/analysis-findings` | Branch-Limit ~7; Fixes bauen direkt auf dem Umbau auf. |
| E4 | Fehler, die die Testsuite zufällig rot machen, sofort als `fix:` beheben (auch vor Phase 3) | Regel „alle Tests grün“ gilt auf jedem Branch; Beispiel: 71E-Umstiegsfrage `e78d6d5`. |
| E5 | Keine Subagenten mehr; nach Phase 3 anhalten, Wünsche N-1…N-6 in Phase 3 | Nutzer-Anweisung 2026-10-20 (Subagenten liefen ins Sitzungslimit). |
| E3 | Accounts: SQLite über das eingebaute `node:sqlite`, Passwort-Hash mit eingebautem `crypto.argon2` (Argon2id) | Keine nativen Abhängigkeiten (Windows-Laptop + Alpine-Image), DB-Datei im vorhandenen `STATE_DIR`-Volume → persistent, Ditto-Deployment bleibt einfach. Node 24.15 bietet beides. |

## Phase 0 – Ausgangslage (Referenz)

Stand `ce66c98` („bold bug bei auswahl gefixed“), Arbeitsbaum sauber.

| Prüfung | Ergebnis |
|---|---|
| `npx tsc --noEmit` | ✅ 0 Fehler |
| `npm test` | ✅ 32/32 (Wertung, Ø-Wartezeit, 9 Kurse, 13 Quiz-Fragetypen) |
| `npm run smoke` (Klick-Durchlauf, Edge headless) | ✅ ohne Fehler |
| `docker build .` (Dockerfile führt Typecheck + Tests aus) | ✅ Image baut, Container startet, `/api/health` ok, `/` 200 |
| `docker compose up --build` | ❌ **keine `docker-compose.yml` im Repo** – nur `deploy/compose.snippet.yml` für Ditto → Befund |
| Linter | – es gibt keinen (nur Typecheck) → Befund |

Umgebung: Windows 11, Node 24.15, Docker Desktop 28.5 / Compose 2.40, Edge + Chrome, `playwright-core` (steuert den installierten Edge).

## Inventar (aus dem Code, Stand `ce66c98`)

### Spielmodi und Einstellungen

**🏁 Routenjagd** (Lobby, 1–12 Spieler) – `GameSettings` (`shared/types.ts`, Standard `shared/defaults.ts`):
- `slot`: wd12 · wd17 · sa02 · su12 · `network`: regular · current
- `difficulty`: easy · medium · hard · expert · custom (Schnellwahl für die drei Regler)
- `stations`: je Verkehrsmittel aus/Stufe – U: Ukey|U · S: Skey|S · T: Tkey|T · Bus: hub|bus|all
- `distance`: short 2–7 km · medium 3–12 km · long 6–16 km · `minTransfers`: 0 · 1 · 2
- `focus`: null | Kreis {lat, lon, radiusM ∈ 1500/2500/4000/6000, share}
- `rounds`: 3 · 5 · 7 · 10 · `roundTimeLimitSec`: 60 · 120 · 180 · 240 · 300 · 600 · null
- `locate` (Wo liegt das?) · `countWait` · `avgWait` · `goal`: best · fastest
- `xtreme`: off · noHints · noNames · noMap · `restrictions`: never · sometimes · always · `tips`: off · cheap · expensive
- Host: Pause, Fortsetzen, Runde abbrechen, Auflösen, nächste Runde, zurück zur Lobby; Tipps; Spieler können jederzeit beitreten

**🧠 Quiz** (Lobby) – `QuizSettings` (`shared/quiz.ts`):
- `questions`: 5 · 10 · 15 · 20 · `timeSec`: 10 · 15 · 20 · 30 · 45 · `area`: 0 (ganz Wien) | 1–23
- `modes`: U · S · T · B · N (Standard U, S, T)
- `weights` je Fragetyp 1–7: locate, direct, towards, transfer, uCross, uLink, stopLines, termini, lineShape, draw, district, nextStop, busArea
- Host: Pause, Überspringen, Auflösen, nächste Frage, zurück zur Lobby

**🏋️ Training** (allein, `DEFAULT_TRAINING`): slot · preset easy/medium/hard/expert · area 0|1–23 · coach an/aus;
Wiederholung nicht gelöster Strecken (localStorage `oeffi-training-*`)

**📚 Lernen** (allein): Startseite (Lernpfad, Netzkarte, Üben) · Netzkarte/Atlas (Suche, Steckbrief, Von hier,
⭐ merken, Vergleich bis 6 Linien) · Üben (gemerkte oder 5 zufällige Linien: ansehen → nachzeichnen → vergleichen)

### Kurse (Lernpfad-Reihenfolge, `client/src/learn/courses/list.ts`)
ubahn · sbahn · radial · ring · tangential · danube · south · busnr · night

### Screens (`client/src/screens`)
home · lobby (Routenjagd) · round · reveal · final · quiz (Lobby, Frage, Auflösung, Endstand) · training · learn
(+ learn/atlas, learn/study, learn/courses/index) · host (Host-Leiste)

### API (`server/index.ts`)
- `GET /api/health` · `GET /api/network`
- `POST /api/games` (erstellen) · `POST /api/games/:code/join` · `GET /api/games/:code` · `GET /api/games/:code/events` (SSE)
- `PUT …/settings` · `POST …/start|next|lobby|leave|pause|resume|cancel`
- Routenjagd: `POST|GET …/rounds/:round/tips` · `POST …/rounds/:round/submit` · `POST|GET …/rounds/:round/reveal`
- Quiz: `POST …/quiz/answer` · `POST …/quiz/reveal`
- Training: `POST /api/training/round` · `POST /api/training/:id/evaluate`

### Lokaler Speicher (Browser)
`oeffi-guesser-session`, `oeffi-guesser-prefs-v2`, `oeffi-training-config-v1`, `oeffi-training-memory-v1`,
`oeffi-learn-progress-v1`, `oeffi-my-lines-v1`, `oeffi-courses-v1`

## Rohbefunde (noch zu verifizieren → 02-befunde.md)

Aus eigener Prüfung:
- R-1 keine docker-compose.yml im Repo · R-2 kein Linter · R-3 `lineHtml(compare)` ignoriert Parameter → toter „Vergleichen“-Knopf im Kurs-Steckbrief (atlas.ts)
- R-4 cleanName `.slice(0,20)` kann Emoji (Surrogatpaar) zerschneiden (server/security.ts) – unverifiziert

Client-Review (Agent):
- C-H1 round.ts submit(): Fehler → Spieler sitzt fest („Abgegeben“, Builder gesperrt)
- C-H2 quiz.ts submit(): gleicher Fehler
- C-H3 lobby.ts/quiz.ts rendern bei jedem SSE-Event komplett neu → Range-Drag/Fokus verloren
- C-H4 send() verwirft Einstellungs-Patches während pending (lobby.ts, quiz.ts)
- C-M1 home.ts Enter → doppelter Join · C-M2 training Doppelklick nächste Strecke · C-M3 training Auswertungsfehler wirft Strecke weg
- C-M4 reveal.ts getReveal-Fehler → Spinner für immer · C-M5 expandable <li> nicht per Tastatur · C-M6 ⓘ-Tooltips nicht für Screenreader
- C-M7 Toasts ohne aria-live, überlappen · C-M8 seg()/Toggles ohne aria-pressed · C-M9 Kontrast .pchip/.muted < 4.5:1
- C-M10 Browser-Zurück/Neuladen in Lernen/Training → Startseite, Builder-Entwurf verloren · C-M11 ungelabelte Inputs
- C-N1..N15: Start-Button-Text nach Fehler, Doppelklick Host-Buttons, Quiz-Zeitablauf Karte bleibt groß, roundScreen räumt Karte nicht,
  SSE-Parse ohne try, localStorage-Struktur ungeprüft, Bezirksmittel NaN (unverif.), pickLine leere boardOptions (unverif.),
  Prefetch-Race training, Karte springt bei Tipp, lange Namen ohne Umbruch, Icon-Buttons ohne aria-label, Schrift < 12px, stopPropagation global unwirksam
- XSS: nichts ausnutzbar; Defense-in-depth: Lobby-Code/IDs/Farben ohne esc, Einladungslink ohne encodeURIComponent
- Struktur: große Funktionen (lobby render 270 Z., quiz.ts 4 Screens, training 350-Z.-Closure, NetMapLayer.render 200 Z.), seg/infoTip in lobby.ts,
  Duplikate (norm, linesAt, chip-Helfer, colorOf/lineColor, CENTER 3×, Bezirksmittel 2×, Storage-Helfer 4×, Spielerliste/Podium/Link-Kopieren/Verlassen mehrfach,
  ALL_MODES-Scope-Hack 2×), toter Code (store.mode, lobby toggle, map.showLocateAnswer, model.resetBoxes), ~300 Zeilen totes CSS
- Inkonsistenzen: Gebietsauswahl 3× verschieden, Zurücksetzen 3× verschieden (Training ohne confirm), Start-Button-Text

Server-Review (Agent):
- S-H1 Auswertung: EFA-Fehler in evaluateUserRoute → reveal() rejected, Promise in `revealing` gespeichert; via Timer/maybeReveal unhandled rejection → Prozess stirbt; sonst Runde hängt für immer (game.ts reveal, routing.ts chainRoute)
- S-H2 efa.ts memCache bis 5000 rohe JSON (~100 KB/Eintrag) → ~500 MB > mem_limit 384m
- S-M1 cancelRound/backToLobby während laufender Auswertung → Punkte trotzdem/ins neue Spiel · S-M2 Abgaben während Auswertung angenommen aber 0 Punkte; pause in Auswertung
- S-M3 Lösung im öffentlichen Zustand: uLink drawLines enthält Antwort; lineShape drawLineId = Antwort; state() schickt Start/Ziel-Namen+Koordinaten auch bei noNames/vor Wo-liegt
- S-M4 Lobby-Kapazität (100 global) leicht erschöpfbar · S-M5 cleanup schließt SSE-Streams nicht, Lobbys mit Spielern nach 3 h weg
- S-M6 Top-Routen mischen Fahrzeit/Tür-zu-Tür ohne avgWait · S-M7 fehlgeschlagener Start: generation nicht erhöht, Hintergrundkette läuft weiter
- S-M8 Disk-Cache nie aufgeräumt (lokal 1,2 GB)
- S-N1 `{"token":{"toString":1}}` → 500 + Stack · S-N2 training evaluate/randomPair Fehler als 500 · S-N3 Emoji-Surrogat & ZWJ in Namen (verifiziert)
- S-N4 verwaiste Spieler nie entfernt · S-N5 SSE nach leave weiter · S-N6 maxRoundPoints ignoriert Beat-Bonus (1300)
- S-N7 Ukey-Faktor 0.85 wirkungslos (Math.max(...,0.9)) · S-N8 Wo-liegt voll 200 m (Quiz) vs 250 m (Route); Mehrfachauswahl alles anklicken → Teilpunkte
- S-N9 pause/resume Quiz still no-op vs Routenjagd Fehler · S-N10 revealing-Map nie geleert, Lobby-Codes Math.random, 404/403 verrät Code
- S-N11 nextTypicalDay mischt lokal/UTC; Schulferien nur bis 2027-09
- Struktur: sanitizeSettings/cleanLegs in game.ts (training importiert), index.ts startet beim Import (kein createApp), setInterval bei Modul-Load,
  Magic Numbers, cleanName 2× mit anderer Bedeutung (efa vs security), toter Code nextSlotDate, MIN_TRANSFER_MAX, unnötige Exporte; Logging uneinheitlich

Algorithmus-/Deploy-Review (Agent, Repro-Skripte in docs/analysis/evidence/agentC):
- A-K1 = S-H1 (verifiziert: Prozess exit 1, crash.ts)
- A-H1 Ø-Wartezeit: LegTimetable-Abdeckung lückenhaft (firstAfter lädt ab max(t,coveredUntil); departures(t<coveredFrom) lädt nicht nach) → U1 60-min + U3 3-min: Umstieg 13 statt ≤2 min (synth2.ts)
- A-H2 = S-H2 (gemessen ~106 KB/Eintrag) · A-H3 prepare späterer Runde wirft → Spiel zurück in Lobby, Ergebnisse weg; randomPair Error→500
- A-M1 leerer Pool → TypeError; Skey+Nacht+short+10 Runden 1/20 Abbruch · A-M2 Modelle gemischt (averagedRoute null / sample ohne Wartezeit)
- A-M3 EFA-Last (minTransfers erst nach vollem topRoutes, departures lädt 180 min, banLines nur nachträglich) · A-M4 Disk-Cache 1,15 GB, Fehlerantworten 3 Tage gecacht
- A-M5 Training ohne sortRoutes/routeCost (beste=schnellste), fixes Paar ungeprüft; Ortung 200 vs 250 m · A-M6 Referenztage Juni → nach Fahrplanwechsel/EFA-Horizont kein „Regulär“
- A-M7 release.ts taggt beliebigen Branch, latest bei jedem Tag
- A-N: expectedWait diskret (H−1)/2 statt H/2 („alle 14 min“ bei 15er-Takt); Startwartefaktor springt bei 1 min Fußweg; Ukey 0.85 wirkungslos (0.81 statt 0.77);
  maxRoundPoints 2113 statt 2670 (>100 % möglich); timeBonus elapsed<0; withSlot-Race/Retry bei 4xx; via-Suche fällt auf null; Pfingstferien 2027 fehlen, Ferienliste endet 2027-09;
  nextTypicalDay lokal/UTC; Fokus share 0.9 → real 48 %; usage ohne Zerfall, RNG nicht injizierbar; kein SIGTERM-Handler/init; update.sh Rollback holt latest wieder; keine compose im Repo
- Testvorschläge (Werte gerechnet): scoreRoute-Tabelle, tipShareOf, computeScore total 487, difficultyMultiplier, maxRoundPoints 2670, expectedWait-Fälle, Routing-Regressionstest synth2

## Erledigt

- [x] Phase 0.1 Branches `backup/pre-agent-run`, `refactor/structure`
- [x] Phase 0.2 Referenzläufe (siehe Tabelle)
- [x] Phase 0.3 Inventar
- [x] Phase 1: Charakterisierungstests (API 17, E2E 6), Refactor Helfer→shared (2f3d5f2), NetGraph abgetrennt + Tests (c03cbcf)
- [x] Phase 0.4 E2E-Gerüst `test/e2e/harness.ts` + `npm run e2e` (Node-Testrunner + playwright-core/Edge, Screenshots in `test/e2e/artifacts`, Auskunfts-Cache in `test/e2e/.state`); erster Test: Startseite auf 3 Bildschirmgrößen ✅

- [x] Phase 1 abgeschlossen: `docs/analysis/01-struktur.md` (S1–S10), toter Code + CSS, server/settings.ts, createApp, storage.ts,
      CENTER, docker-compose.yml (geprüft: startet, health ok). 67 Tests + 6 E2E + Smoke grün. Fix 71E-Umstiegsfrage (E4).
- R-5 (gefunden, behoben `e78d6d5`): Quiz-Umstiegsfrage nahm Sonderlinie als Ziellinie

- [x] Phase 2: `02-befunde.md` (K-01, H-01…H-07, M-01…M-12, U-01…U-06, L-01…L-12, N-1…N-6), `03-ideen.md`;
      Tests: matrix.e2e (26 Zeilen), multiplayer.e2e (13), a11y.e2e (14), security.test (18, davon 9 todo)

## Offen / Nächste Schritte

1. Phase 3: kritisch/hoch zuerst (K-01, H-01/N-6, H-02, H-05, H-03, H-04, H-06, H-07), dann N-1…N-5, dann mittel/niedrig.
   Jeder Fix: Regressionstest (todo → normal), Commit in 02-befunde.md eintragen.
2. Matrix erneut laufen lassen, compose prüfen.
3. STOPP – Nutzer fragt vor Phase 4.
