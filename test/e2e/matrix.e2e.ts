// Testmatrix (Phase 2a): jeder Modus × relevante Einstellungen inkl. Grenzwerte, im echten Browser durchgespielt.
// Einstellungen werden über die API gesetzt (wie der Host-Client es tut), gespielt wird über die Oberfläche.
// Jede Zeile: keine JavaScript-/Konsolenfehler, keine Serverfehler, Endstand erreicht.
// Ergebnisse je Zeile landen in test/e2e/artifacts/matrix.json (für docs/analysis/02-befunde.md).
//
// Routenjagd-Runden fragen die Wiener-Linien-Auskunft ab (Cache: test/e2e/.state) – der erste Lauf dauert länger.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Page } from 'playwright-core';
import type { GameSettings, GameState, NetworkPublic, QuizState } from '../../shared/types.ts';
import type { QuizSettings } from '../../shared/quiz.ts';
import { ARTIFACTS, setName, startApp, type App } from './harness.ts';

let app: App;
let net: NetworkPublic;
const results: { row: string; ok: boolean; ms: number; note: string }[] = [];

before(async () => {
  app = await startApp({ RATE_LIMIT_SCALE: '1000' });
  net = (await (await fetch(`${app.base}/api/network`)).json()) as NetworkPublic;
});
after(async () => {
  writeFileSync(path.join(ARTIFACTS, 'matrix.json'), JSON.stringify(results, null, 2));
  await app?.close();
});

interface Sess {
  code: string;
  playerId: string;
  token: string;
}
const session = (p: Page) => p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session') ?? 'null')) as Promise<Sess>;

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(app.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function routeState(s: Sess): Promise<GameState> {
  return (await api('GET', `/api/games/${s.code}?token=${s.token}`)).body.state;
}

/** Zeile der Matrix: misst die Zeit, sammelt Fehler, protokolliert das Ergebnis */
async function row(name: string, fn: (p: Page, note: (s: string) => void) => Promise<void>) {
  const t = await app.page();
  const notes: string[] = [];
  const t0 = Date.now();
  let ok = false;
  try {
    await fn(t.page, (s) => notes.push(s));
    assert.deepEqual(t.errors, [], `Fehler im Browser: ${t.errors.join(' | ')}`);
    ok = true;
  } catch (e) {
    await t.shot(`matrix-fail-${name.replace(/[^\w-]+/g, '_')}`).catch(() => {});
    notes.push(String((e as Error).message).split('\n')[0]);
    throw e;
  } finally {
    results.push({ row: name, ok, ms: Date.now() - t0, note: notes.join('; ') });
    await t.context.close();
  }
}

// ---------------------------------------------------------------- Routenjagd

async function openRouteLobby(p: Page, name = 'Matrix'): Promise<Sess> {
  await p.goto(app.base);
  await setName(p, name);
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  return session(p);
}

async function setRoute(s: Sess, settings: Partial<GameSettings>) {
  const r = await api('PUT', `/api/games/${s.code}/settings`, { token: s.token, settings });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as GameState;
}

/** eine Teilstrecke ab dem Start bauen und abgeben (erste Linie, die die Einschränkung erlaubt) */
async function buildAndSubmit(p: Page, s: Sess) {
  const st = await routeState(s);
  const r = st.rounds[st.currentRound];
  const from = net.stations.find((x) => x.id === r.from!.id)!;
  const input = p.locator('.line-input');
  // Tageslinien zuerst; manche Haltestellen bedient (je nach Zeit) nur ein Nachtbus
  for (const id of [...from.lines.filter((l) => !/^N/.test(l)), ...from.lines.filter((l) => /^N/.test(l))]) {
    await input.fill(id);
    await input.press('Enter');
    // X-treme „ohne Vorschläge“: Ausstieg eintippen – irgendeine andere Station der Linie
    if (await p.locator('.typed-legs').isVisible({ timeout: 800 }).catch(() => false)) {
      const line = net.lines.find((l) => l.id === id)!;
      const other = line.patterns.flat().find((sid) => sid !== from.id && net.stations.find((x) => x.id === sid)!.name !== from.name);
      if (other) {
        await p.locator('.typed-alight').fill(net.stations.find((x) => x.id === other)!.name);
        await p.locator('.typed-legs [data-act=add]').click();
        await p.locator('[data-act=submit]').click();
        return id;
      }
      await p.locator('[data-act=change]').click();
      continue;
    }
    if (await p.locator('.alight-select').first().isVisible({ timeout: 800 }).catch(() => false)) {
      const values = await p.locator('.leg-form .alight-select option:not([disabled])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      if (values.length) {
        await p.locator('.leg-form .alight-select').selectOption(values[values.length - 1]);
        await p.locator('[data-act=submit]').click();
        return id;
      }
      await p.locator('[data-act=change]').click();
    }
  }
  throw new Error(`keine Linie ab ${from.name} wählbar`);
}

/** eine Runde spielen: ggf. „Wo liegt das?“, dann Route oder abbrechen, bis zur Auflösung */
async function playRound(p: Page, s: Sess, how: 'route' | 'cancel' | 'timeout', idx: number) {
  await p.locator('.locate, .line-input, .typed-legs, .hb-cancel').first().waitFor({ timeout: 180_000 });
  if (how === 'timeout') {
    await p.locator('.btn-big', { hasText: /Nächste Runde|Zum Endergebnis/ }).waitFor({ timeout: 120_000 });
    return;
  }
  if (await p.locator('.locate').count()) {
    const map = (await p.locator('#map').boundingBox())!;
    await p.mouse.click(map.x + map.width * 0.45, map.y + map.height * 0.5);
    await p.mouse.click(map.x + map.width * 0.55, map.y + map.height * 0.45);
    await p.locator('#confirm').click();
  }
  if (how === 'cancel') {
    p.once('dialog', (d) => void d.accept());
    await p.locator('.hb-cancel').click();
  } else await buildAndSubmit(p, s);
  await p.locator('.btn-big', { hasText: /Nächste Runde|Zum Endergebnis/ }).waitFor({ timeout: 180_000 });
  const st = await routeState(s);
  assert.equal(st.rounds[idx].status, 'revealed');
}

async function playRouteGame(p: Page, s: Sess, rounds: number, how: 'route' | 'cancel' | 'timeout' = 'route') {
  await p.locator('#start').click();
  for (let i = 0; i < rounds; i++) {
    await playRound(p, s, how, i);
    await p.locator('.btn-big', { hasText: /Nächste Runde|Zum Endergebnis/ }).click();
  }
  await p.locator('#again').waitFor({ timeout: 60_000 });
  const st = await routeState(s);
  assert.equal(st.phase, 'finished');
  return st;
}

const ROUTE_ROWS: { name: string; settings: Partial<GameSettings>; rounds?: number; how?: 'route' | 'cancel' | 'timeout' }[] = [
  { name: 'R01 Leicht · 3 Runden · Ortung · Tipps günstig', settings: { difficulty: 'easy', rounds: 3, locate: true, tips: 'cheap' }, rounds: 3 },
  { name: 'R02 Mittel · schnellste · ohne Wartezeit', settings: { difficulty: 'medium', rounds: 1, locate: false, goal: 'fastest', countWait: false, avgWait: false } },
  { name: 'R03 Schwer · Challenges immer · Tipps teuer', settings: { difficulty: 'hard', rounds: 1, restrictions: 'always', tips: 'expensive' } },
  { name: 'R04 Profi · lang · 10 min Limit', settings: { difficulty: 'expert', rounds: 1, roundTimeLimitSec: 600 } },
  { name: 'R05 Eigene: nur wichtige U · kurz · 0 Umstiege · Sa 2 Uhr', settings: { stations: ['Ukey'], distance: 'short', minTransfers: 0, slot: 'sa02', rounds: 1 } },
  { name: 'R06 aktuelles Netz · Mo–Fr 17 Uhr', settings: { network: 'current', slot: 'wd17', rounds: 1 } },
  { name: 'R07 So 12 Uhr · Fokus 1. Bezirk 1,5 km 90 %', settings: { slot: 'su12', rounds: 1, focus: { lat: 48.2085, lon: 16.3731, radiusM: 1500, share: 0.9 } } },
  { name: 'R08 Busse alle · ohne Zeitlimit', settings: { stations: ['U', 'S', 'T', 'all'], rounds: 1, roundTimeLimitSec: null } },
  { name: 'R09 X-treme ohne Hilfen', settings: { xtreme: 'noHints', rounds: 1 } },
  { name: 'R10 X-treme ohne Namen (abbrechen)', settings: { xtreme: 'noNames', rounds: 1 }, how: 'cancel' },
  { name: 'R11 X-treme ohne Karte (abbrechen)', settings: { xtreme: 'noMap', rounds: 1 }, how: 'cancel' },
  { name: 'R12 Zeitlimit-Minimum 20 s läuft ab (Auto-Abgabe)', settings: { rounds: 1, roundTimeLimitSec: 20, locate: false }, how: 'timeout' },
  { name: 'R13 Grenzwert 1 Runde · Abbruch durch Host', settings: { rounds: 1, locate: true }, how: 'cancel' },
];

for (const r of ROUTE_ROWS)
  test(`Routenjagd ${r.name}`, async () => {
    await row(`Routenjagd ${r.name}`, async (p, note) => {
      const s = await openRouteLobby(p);
      const st = await setRoute(s, r.settings);
      note(`Schwierigkeit ${st.settings.difficulty}, Max ${st.settings.rounds} Runden`);
      const end = await playRouteGame(p, s, r.rounds ?? 1, r.how);
      note(`Punkte ${end.players[0].score}`);
      assert.ok(Number.isFinite(end.players[0].score) && end.players[0].score >= 0);
    });
  });

// ---------------------------------------------------------------- Training

const TRAIN_ROWS: { name: string; preset: string; slot: string; area?: number; coach: boolean }[] = [
  { name: 'T01 Leicht · Coach an · ganz Wien', preset: 'easy', slot: 'wd12', coach: true },
  { name: 'T02 Profi · Coach aus · Sa 2 Uhr', preset: 'expert', slot: 'sa02', coach: false },
  { name: 'T03 Mittel · Schwerpunkt 23. Bezirk', preset: 'medium', slot: 'su12', area: 23, coach: true },
];
for (const r of TRAIN_ROWS)
  test(`Training ${r.name}`, async () => {
    await row(`Training ${r.name}`, async (p) => {
      await p.goto(app.base);
      await p.locator('.mode-training').click();
      await p.locator(`[data-slot="${r.slot}"]`).click();
      await p.locator(`[data-preset="${r.preset}"]`).click();
      if (r.area) {
        await p.locator('[data-area="focus"]').click();
        await p.locator('#area').selectOption(String(r.area));
      }
      if ((await p.locator('#coach').isChecked()) !== r.coach) await p.locator('label.toggle:has(#coach)').click();
      await p.locator('#start').click();
      await p.locator('.round-head .od').waitFor({ timeout: 180_000 });
      // Start-Station aus der Anzeige → Linie suchen
      const fromName = (await p.locator('.od-row').first().innerText()).replace(/^A\s*/, '').trim();
      const from = net.stations.find((x) => x.name === fromName);
      assert.ok(from, `Start „${fromName}“ nicht im Netz`);
      const input = p.locator('.line-input');
      let done = false;
      // Tageslinien zuerst; nachts hält an manchen Stationen nur ein Nachtbus
      for (const id of [...from.lines.filter((l) => !/^N/.test(l)), ...from.lines.filter((l) => /^N/.test(l))]) {
        await input.fill(id);
        await input.press('Enter');
        if (await p.locator('.leg-form .alight-select').isVisible({ timeout: 800 }).catch(() => false)) {
          const values = await p.locator('.leg-form .alight-select option:not([disabled])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
          await p.locator('.leg-form .alight-select').selectOption(values[values.length - 1]);
          done = true;
          break;
        }
      }
      assert.ok(done, 'keine Linie wählbar');
      await p.locator('[data-act=submit]').click();
      await p.locator('#next').waitFor({ timeout: 120_000 });
      await p.locator('#setup').click();
      await p.locator('#start').waitFor();
    });
  });

// ---------------------------------------------------------------- Quiz

async function openQuizLobby(p: Page, name = 'Quiz'): Promise<Sess> {
  await p.goto(app.base);
  await setName(p, name);
  await p.locator('.mode-quiz').click();
  await p.locator('#start').waitFor();
  return session(p);
}

/** eine Quizfrage beantworten (irgendeine Antwort) oder ablaufen lassen */
async function answerQuestion(p: Page, wait: boolean) {
  await p.locator('.quiz-q h2').waitFor({ timeout: 30_000 });
  if (!wait) {
    await p.waitForTimeout(300);
    const map = (await p.locator('#map').boundingBox())!;
    if (await p.locator('.quiz-options button[data-o]').count()) await p.locator('.quiz-options button[data-o]').first().click();
    else if (await p.locator('.pick-lines button[data-o]').count()) {
      await p.locator('.pick-lines button[data-o]').first().click();
      await p.getByRole('button', { name: 'Antworten' }).click();
    } else {
      await p.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
      await p.mouse.click(map.x + map.width / 2 + 30, map.y + map.height / 2 + 20);
      await p.locator('.quiz-q button.btn-primary').click();
    }
  }
  await p.locator('.result-card').waitFor({ timeout: 70_000 });
}

const ALL_TYPES = ['locate', 'direct', 'towards', 'transfer', 'uCross', 'uLink', 'stopLines', 'termini', 'lineShape', 'draw', 'district', 'nextStop', 'busArea'] as const;
const only = (t: (typeof ALL_TYPES)[number]) => Object.fromEntries(ALL_TYPES.map((x) => [x, x === t ? 7 : 1])) as QuizSettings['weights'];

const QUIZ_ROWS: { name: string; settings: Partial<QuizSettings>; wait?: boolean }[] = [
  { name: 'Q01 Standard · 5 Fragen', settings: { questions: 5 } },
  { name: 'Q02 20 Fragen (Maximum) · 45 s', settings: { questions: 20, timeSec: 45 } },
  { name: 'Q03 Zeit 10 s läuft ab (keine Antwort)', settings: { questions: 5, timeSec: 10 }, wait: true },
  { name: 'Q04 1. Bezirk', settings: { questions: 5, area: 1 } },
  { name: 'Q05 23. Bezirk · mit Bus', settings: { questions: 5, area: 23, modes: ['U', 'S', 'T', 'B'] } },
  { name: 'Q06 nur Nachtbus', settings: { questions: 5, modes: ['N'] } },
  { name: 'Q07 nur Bus · Busnummern', settings: { questions: 5, modes: ['B'], weights: only('busArea') } },
  { name: 'Q08 nur S-Bahn', settings: { questions: 5, modes: ['S'] } },
  { name: 'Q09 Linie zeichnen bevorzugt', settings: { questions: 5, weights: only('draw') } },
  { name: 'Q10 Wo liegt …? bevorzugt', settings: { questions: 5, weights: only('locate') } },
];

for (const r of QUIZ_ROWS)
  test(`Quiz ${r.name}`, async () => {
    await row(`Quiz ${r.name}`, async (p, note) => {
      const s = await openQuizLobby(p);
      const res = await api('PUT', `/api/games/${s.code}/settings`, { token: s.token, settings: r.settings });
      assert.equal(res.status, 200);
      await p.locator('#start').click();
      // Anzahl tatsächlich erzeugter Fragen (kleine Gebiete/Verkehrsmittel können weniger ergeben)
      await p.locator('.quiz-q h2').waitFor({ timeout: 30_000 });
      const state = (await api('GET', `/api/games/${s.code}?token=${s.token}`)).body.state as QuizState;
      const n = state.total;
      note(`${n} Fragen`);
      for (let q = 0; q < n; q++) {
        await answerQuestion(p, !!r.wait);
        await p.locator('.btn-big', { hasText: /Nächste Frage|Zum Endergebnis/ }).click();
      }
      await p.locator('.final h2', { hasText: 'Quiz-Endstand' }).waitFor({ timeout: 30_000 });
    });
  });
