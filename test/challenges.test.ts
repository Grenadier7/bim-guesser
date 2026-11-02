// Tages-Challenges: Rotation (für alle gleich, fair, wechselnde Gruppen), Bezirk des Tages, stimmige Einstellungen,
// und die Regeln (shared/challengeRules.ts) mit klaren Meldungen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHALLENGES, DAILY_COUNT, allChallenges, dailyChallenges, districtChallenge, districtOfDay, type ChallengeContext } from '../shared/challenges.ts';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { sanitizeSettings } from '../server/settings.ts';
import { lineProblem, legProblem, routeProblem, stationProblem, type RuleNet } from '../shared/challengeRules.ts';

const full: ChallengeContext = { night: { id: 'sa02', time: '02:00' }, sunday: { id: 'su12', time: '12:00' }, current: true, addresses: true, water: true };
const bare: ChallengeContext = { night: null, sunday: null, current: false, addresses: false, water: false };
const day = (i: number) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
const district = districtChallenge(2, 'Leopoldstadt', [48.21, 16.4]);

test('je Tag 3 aus der Rotation + Bezirk des Tages, für alle gleich; Folgetage ohne Überschneidung', () => {
  const a = dailyChallenges('2026-11-02', full, district);
  assert.equal(a.length, DAILY_COUNT + 1);
  assert.ok(a.some((c) => c.id === district.id), 'Bezirk des Tages immer dabei');
  assert.deepEqual(dailyChallenges('2026-11-02', full, district), a);
  for (let i = 0; i < 60; i++) {
    const today = new Set(dailyChallenges(day(i), full).map((c) => c.id));
    for (const c of dailyChallenges(day(i + 1), full)) assert.ok(!today.has(c.id), `${c.id} an zwei Tagen hintereinander (${day(i)})`);
  }
});

test('Rotation: jede kommt gleich oft und in fast gleichem Abstand; jede ist mal der Tagesvorschlag', () => {
  const n = allChallenges(full).length;
  const seen = new Map<string, number[]>();
  const first = new Set<string>();
  for (let i = 0; i < n * 3; i++) {
    const list = dailyChallenges(day(i), full);
    first.add(list[0].id);
    for (const c of list) seen.set(c.id, [...(seen.get(c.id) ?? []), i]);
  }
  assert.equal(seen.size, n, 'alle kommen dran');
  for (const [id, days] of seen) {
    assert.ok(Math.abs(days.length - DAILY_COUNT * 3) <= 1, `${id}: ${days.length}× in ${n * 3} Tagen`);
    const gaps = days.slice(1).map((d, i) => d - days[i]);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 4, `${id}: Abstände ${gaps.join(',')}`);
  }
  assert.ok(first.size >= n * 0.7, `nur ${first.size} von ${n} waren Tagesvorschlag`);
});

test('Bezirk des Tages: jeden Tag ein anderer, alle 23 kommen dran', () => {
  const ids = Array.from({ length: 23 }, (_, i) => districtOfDay(day(i)));
  assert.equal(new Set(ids).size, 23);
  for (let i = 0; i < 40; i++) assert.notEqual(districtOfDay(day(i)), districtOfDay(day(i + 1)));
});

test('nicht immer dieselben zusammen: über mehrere Durchläufe wechseln die Partner', () => {
  const partners = new Map<string, Set<string>>();
  for (let i = 0; i < 150; i++) {
    const ids = dailyChallenges(day(i), full).map((c) => c.id);
    for (const a of ids) for (const b of ids) if (a !== b) partners.set(a, (partners.get(a) ?? new Set()).add(b));
  }
  for (const [id, set] of partners) assert.ok(set.size >= 5, `${id} immer mit denselben: ${[...set].join(', ')}`);
});

test('nur, was es im Spiel gibt (Nacht, Sonntag, Aktuell, Adressen, Wasser)', () => {
  const ids = allChallenges(bare).map((c) => c.id);
  for (const no of ['night', 'sunday', 'current', 'doors', 'dickmacks', 'water']) assert.ok(!ids.includes(no), no);
  assert.ok(allChallenges(full).length > ids.length);
});

test('jede Challenge: Standard-Rundenzahl unter den Optionen, stimmige Einstellungen am Server', () => {
  for (const c of [...allChallenges(full), district]) {
    assert.ok(c.roundOptions.includes(c.settings.rounds!), `${c.id}: ${c.settings.rounds} nicht in ${c.roundOptions}`);
    assert.ok(c.settings.rounds! <= 4 || c.id === 'thriller', `${c.id}: ${c.settings.rounds} Runden sind mehr als 5 Minuten`);
    const base: Record<string, unknown> = { ...DEFAULT_SETTINGS, focus: null, locate: false };
    if (c.settings.difficulty) for (const k of ['stations', 'distance', 'minTransfers']) delete base[k];
    const st = sanitizeSettings({ ...base, ...c.settings, challenge: c.id });
    assert.equal(st.challenge, c.id);
    for (const [k, v] of Object.entries(c.settings)) {
      if (k === 'difficulty' && (c.settings.distance || c.settings.variant === 'tram' || c.settings.endpoints || c.settings.stations)) continue;
      if (k === 'slot' && v === 'wd-night') continue;
      const norm = (x: unknown) => (Array.isArray(x) ? [...x].sort() : x);
      assert.deepEqual(norm(st[k as keyof typeof st]), norm(v), `${c.id}: ${k}`);
    }
  }
  assert.equal(CHALLENGES.filter((c) => ['coffee', 'marathon', 'purist', 'comfy', 'rail', 'rush', 'blind', 'no-names', 'locals', 'city'].includes(c.id)).length, 0, 'entfernte Challenges');
});

// ---------------------------------------------------------------- Regeln

/** kleines Netz: U1 (A–B–C, B unterirdisch), 43 (C–D), 13A (D–E), S60 (E–F); Bezirke: B = 1. */
const lines: Record<string, { mode: 'U' | 'T' | 'B' | 'S'; stops: string[] }> = {
  U1: { mode: 'U', stops: ['a', 'b', 'c'] },
  U2: { mode: 'U', stops: ['c', 'x'] },
  '43': { mode: 'T', stops: ['c', 'd'] },
  '13A': { mode: 'B', stops: ['d', 'e'] },
  S60: { mode: 'S', stops: ['e', 'f'] },
  S45: { mode: 'S', stops: ['e', 'f'] },
};
const names: Record<string, string> = { a: 'Alaudagasse', b: 'Karlsplatz', c: 'Cottage', d: 'Dornbach', e: 'Erdbergstraße', f: 'Floridsdorf Süd', x: 'X' };
const net: RuleNet = {
  mode: (id) => lines[id]?.mode ?? null,
  name: (id) => names[id] ?? id,
  district: (id) => (id === 'b' ? 1 : 10),
  traversed: (l, a, b) => {
    const s = lines[l]?.stops ?? [];
    const i = s.indexOf(a);
    const j = s.indexOf(b);
    return i >= 0 && j > i ? s.slice(i, j + 1) : [];
  },
};
const leg = (line: string, from: string, to: string) => ({ line, from, to });

test('Regeln: Linien sofort sperren – mit Begründung', () => {
  assert.match(lineProblem({ restriction: 'busOnly' }, [], 'U1', net)!, /Busreise: nur Busse/);
  assert.equal(lineProblem({ restriction: 'busOnly' }, [], '13A', net), null);
  assert.match(lineProblem({ restriction: 'tramEnds' }, [], '13A', net)!, /erste Fahrt muss mit der Bim/);
  assert.match(lineProblem({ restriction: 'maxOneU' }, [leg('U1', 'a', 'c')], 'U2', net)!, /Eine U reicht/);
  assert.match(lineProblem({ restriction: 'noSameMode' }, [leg('U1', 'a', 'c')], 'U2', net)!, /nach U-Bahn nicht wieder U-Bahn/);
  assert.match(lineProblem({ restriction: 'oneLeg' }, [leg('U1', 'a', 'c')], '43', net)!, /Fußbus: nur eine Linie/);
  assert.match(lineProblem({ restriction: 'umland', entryLines: ['S60'], entryTown: 'Bruck' }, [], 'U1', net)!, /S60 aus Bruck/);
  assert.match(lineProblem({ restriction: 'insider' }, [], 'S45', net)!, /Insider/);
  assert.equal(lineProblem({ restriction: 'insider' }, [], 'S60', net), null);
});

test('Regeln: Halte (unterirdisch, innere Bezirke) und ganze Route', () => {
  assert.match(legProblem({ restriction: 'sunny' }, [], leg('U1', 'a', 'c'), net)!, /U1 fährt bei Karlsplatz unter der Erde/);
  assert.match(stationProblem({ restriction: 'avoidInner' }, 'U1', 'b', net)!, /1\. Bezirk/);
  assert.match(legProblem({ restriction: 'avoidInner' }, [], leg('U1', 'a', 'c'), net)!, /Karlsplatz liegt im 1\. Bezirk/);
  assert.match(routeProblem({ restriction: 'mixModes' }, [leg('U1', 'a', 'c'), leg('43', 'c', 'd')], net)!, /mindestens 3 verschiedene/);
  assert.equal(routeProblem({ restriction: 'mixModes' }, [leg('U1', 'a', 'c'), leg('43', 'c', 'd'), leg('13A', 'd', 'e')], net), null);
  assert.match(routeProblem({ restriction: 'min2Transfers' }, [leg('U1', 'a', 'c'), leg('43', 'c', 'd')], net)!, /2-mal umsteigen/);
  assert.match(routeProblem({ restriction: 'tramEnds' }, [leg('43', 'c', 'd'), leg('13A', 'd', 'e')], net)!, /letzte Fahrt muss mit der Bim/);
  assert.match(routeProblem({ restriction: 'mustLine', required: ['13A'] }, [leg('U1', 'a', 'c')], net)!, /13A muss dabei sein/);
  assert.match(routeProblem({ restriction: 'anyLine', required: ['13A', '43', 'S60'] }, [leg('U1', 'a', 'c')], net)!, /Eine von 13A, 43, S60/);
  assert.equal(routeProblem({ restriction: 'anyLine', required: ['13A', '43', 'S60'] }, [leg('U1', 'a', 'c'), leg('43', 'c', 'd')], net), null);
  assert.match(routeProblem({ restriction: 'needBus' }, [leg('U1', 'a', 'c')], net)!, /Busfahrer/);
});
