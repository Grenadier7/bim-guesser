# AGENT_PROGRESS – autonomer Analyse- und Entwicklungslauf

Gedächtnis des Agenten. Bei Kontextverlust zuerst lesen.

## Aktueller Stand

- **Phase:** 1 – Strukturbewertung
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

## Erledigt

- [x] Phase 0.1 Branches `backup/pre-agent-run`, `refactor/structure`
- [x] Phase 0.2 Referenzläufe (siehe Tabelle)
- [x] Phase 0.3 Inventar
- [x] Phase 1: Charakterisierungstests (API 17, E2E 6), Refactor Helfer→shared (2f3d5f2), NetGraph abgetrennt + Tests (c03cbcf)
- [x] Phase 0.4 E2E-Gerüst `test/e2e/harness.ts` + `npm run e2e` (Node-Testrunner + playwright-core/Edge, Screenshots in `test/e2e/artifacts`, Auskunfts-Cache in `test/e2e/.state`); erster Test: Startseite auf 3 Bildschirmgrößen ✅

## Offen / Nächste Schritte

1. Phase 1: Strukturbewertung → `docs/analysis/01-struktur.md`
