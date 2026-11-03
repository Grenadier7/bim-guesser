// Tages-Challenges: Plan (für alle gleich, gleich oft, Blacklist, normal + besonders, wechselnde Gruppen), Bezirk
// des Tages, feste Einstellungen je Challenge, und die Regeln (shared/challengeRules.ts) mit klaren Meldungen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHALLENGES,
  DAILY_COUNT,
  DISTRICT_GROUPS,
  SCHEDULE_DAYS,
  allChallenges,
  buildSchedule,
  dailyChallenges,
  districtChallenge,
  districtOfDay,
  scheduleKey,
  similar,
  type ChallengeContext,
} from '../shared/challenges.ts';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { sanitizeSettings } from '../server/settings.ts';
import { lineProblem, legProblem, routeProblem, ruleSummary, stationProblem, type RuleNet } from '../shared/challengeRules.ts';
import { pickRequired } from '../server/challengeRound.ts';
import type { GameSettings, RouteOption } from '../shared/types.ts';

const full: ChallengeContext = { night: { id: 'sa02', time: '02:00' }, sunday: { id: 'su12', time: '12:00' }, current: true, addresses: true, water: true };
const bare: ChallengeContext = { night: null, sunday: null, current: false, addresses: false, water: false };
const day = (i: number) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
const district = districtChallenge([4, 5], ['Wieden', 'Margareten']);
const plan = buildSchedule(full);
const D = plan.days.length;
const at = (i: number) => plan.days[((i % D) + D) % D];
const kindOf = new Map(allChallenges(full).map((c) => [c.id, c.kind]));

test('je Tag 3 aus dem Plan + Bezirk des Tages, für alle gleich; der Plan ist immer derselbe', () => {
  const a = dailyChallenges('2026-11-02', full, district);
  assert.equal(a.length, DAILY_COUNT + 1);
  assert.ok(a.some((c) => c.id === district.id), 'Bezirk des Tages immer dabei');
  assert.deepEqual(dailyChallenges('2026-11-02', full, district), a);
  assert.equal(D, SCHEDULE_DAYS);
  assert.deepEqual(buildSchedule(full), plan, 'gleiche Challenges → gleicher Plan');
  assert.notEqual(scheduleKey(bare), plan.key, 'andere Challenges → neuer Plan');
  // gespeicherter Plan wird genommen
  assert.deepEqual(dailyChallenges('2026-11-02', full, district, plan), a);
});

test('Plan: nie zweimal hintereinander, nie Ähnliches am selben Tag – auch über das Plan-Ende hinweg', () => {
  let nearby = 0;
  for (let i = 0; i < D; i++) {
    const today = at(i);
    const next = at(i + 1);
    assert.equal(new Set(today).size, today.length);
    for (const x of today) for (const y of today) if (x !== y) assert.ok(!similar(x, y), `Tag ${i}: ${x} und ${y} sind zu ähnlich`);
    for (const x of next) assert.ok(!today.includes(x), `${x} an Tag ${i} und ${i + 1}`);
    for (const x of today) for (const y of next) if (similar(x, y)) nearby++;
  }
  assert.ok(nearby <= 3, `${nearby}× Ähnliches an aufeinanderfolgenden Tagen`);
});

test('Plan: in jedem 30-Tage-Fenster kommt jede Challenge fast gleich oft', () => {
  const ids = [...kindOf.keys()];
  for (let s = 0; s < D; s++) {
    const n = new Map(ids.map((id) => [id, 0]));
    for (let i = s; i < s + 30; i++) for (const id of at(i)) n.set(id, n.get(id)! + 1);
    const v = [...n.values()];
    assert.ok(Math.max(...v) - Math.min(...v) <= 2, `ab Tag ${s}: ${Math.min(...v)}–${Math.max(...v)}×`);
  }
});

test('Plan: jeden Tag normale und besondere; Gruppen wechseln; jede ist mal der Tagesvorschlag', () => {
  for (let i = 0; i < D; i++) assert.equal(new Set(at(i).map((id) => kindOf.get(id))).size, 2, `Tag ${i}: ${at(i).join(', ')}`);
  const partners = new Map<string, Set<string>>();
  for (let i = 0; i < D; i++) for (const a of at(i)) for (const b of at(i)) if (a !== b) partners.set(a, (partners.get(a) ?? new Set()).add(b));
  for (const [id, set] of partners) assert.ok(set.size >= 8, `${id} immer mit denselben: ${[...set].join(', ')}`);
  const first = new Set(Array.from({ length: D }, (_, i) => dailyChallenges(day(i), full)[0].id));
  assert.ok(first.size >= kindOf.size * 0.7, `nur ${first.size} von ${kindOf.size} waren Tagesvorschlag`);
});

test('Plan: wächst mit – auch mit mehr Challenges gleich oft und ohne Ähnliches am selben Tag', () => {
  const extra = Array.from({ length: 8 }, (_, i) => ({ ...CHALLENGES[i], id: `extra-${i}`, avoid: i % 2 ? [`extra-${i - 1}`] : undefined }));
  CHALLENGES.push(...extra);
  try {
    const p = buildSchedule(full);
    const count = new Map<string, number>();
    for (const d of p.days) for (const id of d) count.set(id, (count.get(id) ?? 0) + 1);
    const v = [...count.values()];
    assert.ok(Math.max(...v) - Math.min(...v) <= 2, `${Math.min(...v)}–${Math.max(...v)}× in ${p.days.length} Tagen`);
    for (const d of p.days) for (const x of d) for (const y of d) if (x !== y) assert.ok(!similar(x, y));
    // auch je 30 Tage fast gleich oft
    const L = p.days.length;
    for (let s = 0; s < L; s++) {
      const n = new Map([...count.keys()].map((id) => [id, 0]));
      for (let i = s; i < s + 30; i++) for (const id of p.days[i % L]) n.set(id, n.get(id)! + 1);
      const w = [...n.values()];
      assert.ok(Math.max(...w) - Math.min(...w) <= 2, `mit mehr Challenges ab Tag ${s}: ${Math.min(...w)}–${Math.max(...w)}×`);
    }
  } finally {
    CHALLENGES.splice(CHALLENGES.length - extra.length, extra.length);
  }
});

test('Bezirk des Tages: alle Gruppen der Reihe nach, nie zweimal hintereinander, nie mit der Ring-Runde am 1.', () => {
  const G = DISTRICT_GROUPS.length;
  assert.equal(D % G, 0, 'Plan-Länge ist ein Vielfaches der Gruppen');
  for (let b = 0; b < D; b += G) assert.equal(new Set(plan.districts.slice(b, b + G)).size, G);
  for (let i = 0; i < D; i++) {
    assert.notEqual(plan.districts[i], plan.districts[(i + 1) % D]);
    if (DISTRICT_GROUPS[plan.districts[i]].includes(1)) assert.ok(!plan.days[i].includes('ring-round'), `Tag ${i}: Ring-Runde und 1. Bezirk`);
  }
  assert.equal(typeof districtOfDay('2026-11-02', full), 'number');
  assert.deepEqual(DISTRICT_GROUPS.flat().sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i + 1), 'alle 23 Bezirke');
});

test('nur, was es im Spiel gibt (Nacht, Sonntag, Aktuell, Adressen, Wasser)', () => {
  const ids = allChallenges(bare).map((c) => c.id);
  for (const no of ['night', 'sunday', 'current', 'doors', 'dickmacks', 'water', 'bath']) assert.ok(!ids.includes(no), no);
  assert.ok(allChallenges(full).length > ids.length);
});

test('jede Challenge: eigene, feste Einstellungen – egal, was in der Lobby eingestellt war', () => {
  // Lobby ganz anders eingestellt: Profi, Aktuell, Nacht, X-treme, Adressen …
  const lobby: Partial<GameSettings> = { ...DEFAULT_SETTINGS, difficulty: 'expert', stations: ['U', 'S', 'T', 'all'], distance: 'long', minTransfers: 2, slot: 'sa02', network: 'current', xtreme: 'noMap', endpoints: 'addresses', restrictions: 'always', countWait: false, tips: 'off' };
  for (const c of [...allChallenges(full), district]) {
    assert.ok(c.roundOptions.includes(c.settings.rounds!), `${c.id}: ${c.settings.rounds} nicht in ${c.roundOptions}`);
    assert.ok(c.settings.rounds! <= 4 || c.id === 'thriller', `${c.id}: ${c.settings.rounds} Runden sind mehr als 5 Minuten`);
    assert.ok(c.roundOptions.includes(5), `${c.id}: 5 Runden nicht wählbar`);
    for (const k of ['stations', 'distance', 'minTransfers', 'slot', 'network', 'endpoints', 'xtreme', 'restrictions', 'countWait'] as const)
      assert.ok(c.settings[k] !== undefined, `${c.id}: ${k} nicht festgelegt`);
    const a = sanitizeSettings({ ...lobby, ...c.settings, challenge: c.id });
    const b = sanitizeSettings({ ...DEFAULT_SETTINGS, ...c.settings, challenge: c.id });
    assert.deepEqual(a, b, `${c.id}: hängt von der Lobby ab`);
    for (const [k, v] of Object.entries(c.settings)) {
      if (k === 'slot' && v === 'wd-night') continue;
      const norm = (x: unknown) => (Array.isArray(x) ? [...x].sort() : x);
      assert.deepEqual(norm(a[k as keyof typeof a]), norm(v), `${c.id}: ${k}`);
    }
  }
  assert.equal(CHALLENGES.filter((c) => ['coffee', 'marathon', 'purist', 'comfy', 'rail', 'rush', 'blind', 'no-names', 'locals', 'city', 'timetable'].includes(c.id)).length, 0, 'entfernte Challenges');
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
  // Umland: falscher Zug – ohne den richtigen zu verraten
  const um = lineProblem({ restriction: 'umland', entryLines: ['S60'], entryTown: 'Bruck' }, [], 'U1', net)!;
  assert.match(um, /Von Bruck fährt die U1 nicht nach Wien/);
  assert.doesNotMatch(um, /S60/);
  assert.equal(lineProblem({ restriction: 'umland', entryLines: ['S60'], entryTown: 'Bruck' }, [], 'S60', net), null);
  assert.match(lineProblem({ restriction: 'noRail' }, [], 'S60', net)!, /Ohne U- und S-Bahn/);
  assert.equal(lineProblem({ restriction: 'noRail' }, [], '43', net), null);
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

test('Fleckerlteppich: gesperrte Bezirke – Einstieg und Durchfahrt, klare Meldung', () => {
  const rr = { restriction: 'avoidDistricts' as const, districts: [1] };
  assert.match(stationProblem(rr, 'U1', 'b', net)!, /1\. Bezirk – der ist heute gesperrt/);
  assert.match(legProblem(rr, [], leg('U1', 'a', 'c'), net)!, /Karlsplatz liegt im 1\. Bezirk/);
  assert.equal(legProblem({ ...rr, districts: [3] }, [], leg('U1', 'a', 'c'), net), null);
  assert.match(ruleSummary(rr)!, /Bezirke 1 \(rot auf der Karte\)/);
});

test('Eine von drei: lästige Linien, die beste erlaubte Verbindung nimmt genau eine', () => {
  const r = (lines: string[], min: number): RouteOption =>
    ({ key: lines.join('>'), legs: lines.map((line) => ({ mode: 'B', line })), medianMin: min, minMin: min, maxMin: min, rideMin: min, samples: 1 }) as unknown as RouteOption;
  const routes = [r(['U1'], 20), r(['13A', '43'], 23), r(['13A'], 24), r(['43'], 25), r(['S60'], 26), r(['D'], 27)];
  const mode = (id: string) => (id === 'U1' ? 'U' : id === 'S60' ? 'S' : 'T');
  for (let i = 0; i < 5; i++) {
    const req = pickRequired('anyLine', routes, mode);
    assert.equal(req.length, 3);
    assert.ok(!req.includes('U1'), 'nicht die Linie der schnellsten Verbindung');
    assert.ok(!(req.includes('13A') && req.includes('43')), `13A und 43 zusammen wären eine Verbindung mit zweien: ${req}`);
  }
});
