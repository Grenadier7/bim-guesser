// Tages-Challenges: für alle gleich je Tag, nur was es im Spiel gibt, und jede ergibt stimmige Einstellungen
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHALLENGES, DAILY_COUNT, dailyChallenges, districtChallenge, type ChallengeContext } from '../shared/challenges.ts';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { sanitizeSettings } from '../server/settings.ts';

const full: ChallengeContext = { night: { id: 'sa02', time: '02:00' }, rush: { id: 'wd17', time: '17:00' }, sunday: { id: 'su12', time: '12:00' }, avoid: true };
const bare: ChallengeContext = { night: null, rush: null, sunday: null, avoid: false };

const day = (i: number) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);

test('je Tag 4 verschiedene, für alle gleich; aufeinanderfolgende Tage ohne Überschneidung', () => {
  const a = dailyChallenges('2026-11-02', full);
  assert.equal(a.length, DAILY_COUNT);
  assert.equal(new Set(a.map((c) => c.id)).size, DAILY_COUNT);
  assert.deepEqual(dailyChallenges('2026-11-02', full), a);
  for (let i = 0; i < 60; i++) {
    const today = new Set(dailyChallenges(day(i), full).map((c) => c.id));
    for (const c of dailyChallenges(day(i + 1), full)) assert.ok(!today.has(c.id), `${c.id} an zwei Tagen hintereinander (${day(i)})`);
  }
});

test('Rotation: jede kommt gleich oft und in fast gleichem Abstand; jede ist mal der Tagesvorschlag', () => {
  const n = CHALLENGES.length;
  const seen = new Map<string, number[]>();
  const first = new Set<string>();
  for (let i = 0; i < n * 4; i++) {
    const list = dailyChallenges(day(i), full);
    first.add(list[0].id);
    for (const c of list) seen.set(c.id, [...(seen.get(c.id) ?? []), i]);
  }
  assert.equal(seen.size, n, 'alle kommen dran');
  for (const [id, days] of seen) {
    assert.ok(Math.abs(days.length - DAILY_COUNT * 4) <= 1, `${id}: ${days.length}× in ${n * 4} Tagen`);
    const gaps = days.slice(1).map((d, i) => d - days[i]);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 3, `${id}: Abstände ${gaps.join(',')}`);
  }
  assert.ok(first.size >= n * 0.8, `nur ${first.size} von ${n} waren Tagesvorschlag`);
});

test('Bezirk der Woche läuft in der Rotation mit – etwa einmal pro Woche', () => {
  const district = districtChallenge(2, 'Leopoldstadt', [48.21, 16.4]);
  const days: number[] = [];
  for (let i = 0; i < 70; i++) if (dailyChallenges(day(i), full, district).some((c) => c.id === district.id)) days.push(i);
  assert.ok(days.length >= 8 && days.length <= 10, `${days.length}× in 70 Tagen`);
  for (let i = 0; i < 70; i++) assert.equal(dailyChallenges(day(i), full, district).length, DAILY_COUNT);
});

test('nicht immer dieselben 4 zusammen: über mehrere Durchläufe wechseln die Partner', () => {
  const partners = new Map<string, Set<string>>();
  for (let i = 0; i < 120; i++) {
    const ids = dailyChallenges(day(i), full).map((c) => c.id);
    for (const a of ids) for (const b of ids) if (a !== b) partners.set(a, (partners.get(a) ?? new Set()).add(b));
  }
  for (const [id, set] of partners) assert.ok(set.size >= 8, `${id} immer mit denselben: ${[...set].join(', ')}`);
});

test('nur, was es im Spiel gibt: ohne Nacht-/Stoßzeit-Uhrzeit und ohne „Umstiege vermeiden“ keine Nachtschicht, Stoßzeit, Gemütlich', () => {
  for (let d = 1; d <= 28; d++) {
    const ids = dailyChallenges(`2026-12-${String(d).padStart(2, '0')}`, bare).map((c) => c.id);
    for (const no of ['night', 'rush', 'sunday', 'comfy']) assert.ok(!ids.includes(no), `${no} am ${d}.12.`);
  }
});

test('jede Challenge ergibt am Server stimmige Einstellungen (Standard + Änderungen, Schnellwahl wird nicht überschrieben)', () => {
  const all = [...CHALLENGES.map((d) => ({ id: d.id, settings: d.settings(full) })), districtChallenge(2, 'Leopoldstadt', [48.21, 16.4])];
  for (const c of all) {
    const base: Record<string, unknown> = { ...DEFAULT_SETTINGS, focus: null };
    if (c.settings.difficulty) for (const k of ['stations', 'distance', 'minTransfers']) delete base[k];
    const st = sanitizeSettings({ ...base, ...c.settings, challenge: c.id });
    assert.equal(st.challenge, c.id);
    for (const [k, v] of Object.entries(c.settings)) {
      if (k === 'difficulty' && (c.settings.distance || c.settings.variant === 'tram' || c.settings.endpoints)) continue; // eigene Regler → „Eigene“
      assert.deepEqual(st[k as keyof typeof st], v, `${c.id}: ${k}`);
    }
    if (st.variant === 'tram') assert.deepEqual(st.stations, ['T']);
    if (c.settings.xtreme === 'noNames' || c.settings.xtreme === 'noMap') assert.equal(st.locate, false);
  }
});
