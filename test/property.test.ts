// Eigenschaften der Wertung und der Ø-Wartezeit über viele zufällige Eingaben (fester Startwert → reproduzierbar)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { computeScore, DIFFICULTY_PRESETS, maxRoundPointsWithBonus, scoreRoute, TIPS, timeBonus } from '../shared/rules.ts';
import type { TipKind, TipLevel } from '../shared/types.ts';
import { expectedWait } from '../server/routing.ts';

/** kleiner, schneller Zufallsgenerator mit Startwert (mulberry32) */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const N = 2000;

test('scoreRoute: immer 0…1300, ganzzahlig, fällt mit längerer Reisezeit (nie steigt)', () => {
  const r = rng(1);
  for (let i = 0; i < N; i++) {
    const best = 3 + r() * 80;
    const a = best * (0.5 + r() * 2);
    const b = a + r() * 30;
    const sa = scoreRoute(a, best);
    const sb = scoreRoute(b, best);
    assert.ok(sa >= 0 && sa <= 1300 && Number.isInteger(sa), `scoreRoute(${a}, ${best}) = ${sa}`);
    assert.ok(sb <= sa, `länger ${b} min gibt ${sb} > ${sa} für ${a} min (Bestzeit ${best})`);
  }
});

test('computeScore: nie negativ oder NaN, nie über dem Maximum mit Bonus', () => {
  const r = rng(2);
  const kinds = Object.keys(TIPS) as TipKind[];
  const levels: TipLevel[] = ['off', 'cheap', 'expensive'];
  for (let i = 0; i < N; i++) {
    const preset = DIFFICULTY_PRESETS[Math.floor(r() * DIFFICULTY_PRESETS.length)];
    const settings = { ...DEFAULT_SETTINGS, stations: preset.stations, distance: preset.distance, minTransfers: preset.minTransfers, locate: r() < 0.5 };
    const limit = r() < 0.3 ? null : 60 + Math.floor(r() * 540);
    const tips = kinds.filter(() => r() < 0.3);
    const s = computeScore({
      routePoints: scoreRoute(5 + r() * 60, 5 + r() * 60),
      tips,
      elapsedSec: r() < 0.1 ? null : (r() - 0.1) * (limit ?? 300),
      limitSec: limit,
      locateDist: settings.locate ? { from: r() < 0.2 ? null : r() * 5000, to: r() * 5000 } : null,
      multiplier: Math.round(0.7 * (1 + r()) * 100) / 100,
      tipLevel: levels[Math.floor(r() * 3)],
    });
    assert.ok(Number.isFinite(s.total) && s.total >= 0, JSON.stringify(s));
    // Multiplikator hier zufällig bis 1,4 – Vergleich mit dem Maximum bei Faktor 1,4 (Profi-ähnlich)
    assert.ok(s.total <= maxRoundPointsWithBonus({ ...settings, stations: ['all'], distance: 'medium', minTransfers: 0, locate: true }) + 1, `${s.total}`);
  }
});

test('Zeitbonus: 0…10 % der Routenpunkte, je schneller desto mehr', () => {
  const r = rng(3);
  for (let i = 0; i < N; i++) {
    const pts = Math.floor(r() * 1300);
    const limit = 20 + Math.floor(r() * 580);
    const a = (r() * 1.4 - 0.2) * limit;
    const b = a + r() * 60;
    const ta = timeBonus(pts, a, limit);
    assert.ok(ta >= 0 && ta <= Math.round(pts * 0.1), `${ta}`);
    assert.ok(timeBonus(pts, b, limit) <= ta);
  }
});

test('Ø-Wartezeit: zwischen 0 und der größten Lücke, regelmäßiger Takt H → H/2', () => {
  const r = rng(4);
  for (let i = 0; i < N; i++) {
    const t = 720;
    const deps: number[] = [];
    let x = t - 10 + r() * 20;
    while (x < t + 200) {
      deps.push(Math.round(x));
      x += 1 + r() * 30;
    }
    const w = expectedWait(deps, t);
    if (w == null) continue;
    const gaps = [deps.find((d) => d >= t)! - t, ...deps.slice(1).map((d, k) => d - deps[k])];
    assert.ok(w >= 0 && w <= Math.max(...gaps) + 1e-9, `w=${w}, größte Lücke ${Math.max(...gaps)}`);
    const h = 2 + Math.floor(r() * 30);
    const regular = Array.from({ length: Math.ceil(200 / h) + 2 }, (_, k) => t + k * h);
    // Fenster 60 min ist ein Vielfaches von h? sonst Randeffekt am Ende – nur ganze Takte prüfen
    if (60 % h === 0) assert.equal(expectedWait(regular, t), h / 2);
  }
});
