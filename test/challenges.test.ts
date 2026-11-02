// Tages-Challenges: für alle gleich je Tag, nur was es im Spiel gibt, und jede ergibt stimmige Einstellungen
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHALLENGES, dailyChallenges, districtChallenge, type ChallengeContext } from '../shared/challenges.ts';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { sanitizeSettings } from '../server/settings.ts';

const full: ChallengeContext = { night: { id: 'sa02', time: '02:00' }, rush: { id: 'wd17', time: '17:00' }, avoid: true };
const bare: ChallengeContext = { night: null, rush: null, avoid: false };

test('je Tag 3 verschiedene, für alle gleich – und an anderen Tagen andere', () => {
  const a = dailyChallenges('2026-11-02', full);
  assert.equal(a.length, 3);
  assert.equal(new Set(a.map((c) => c.id)).size, 3);
  assert.deepEqual(dailyChallenges('2026-11-02', full), a);
  const week = new Set(['03', '04', '05', '06', '07', '08', '09'].flatMap((d) => dailyChallenges(`2026-11-${d}`, full).map((c) => c.id)));
  assert.ok(week.size >= 8, `nur ${week.size} verschiedene in einer Woche`);
});

test('nur, was es im Spiel gibt: ohne Nacht-/Stoßzeit-Uhrzeit und ohne „Umstiege vermeiden“ keine Nachtschicht, Stoßzeit, Gemütlich', () => {
  for (let d = 1; d <= 28; d++) {
    const ids = dailyChallenges(`2026-12-${String(d).padStart(2, '0')}`, bare).map((c) => c.id);
    for (const no of ['night', 'rush', 'comfy']) assert.ok(!ids.includes(no), `${no} am ${d}.12.`);
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
