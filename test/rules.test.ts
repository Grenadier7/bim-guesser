// Wertung: Routenpunkte, Tipps, Umstiegsaufschlag, Gesamtpunkte
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeScore, routeCost, scoreRoute, TIP_MIN_KEEP, TIPS, tipShareOf, transferPenalty } from '../shared/rules.ts';
import type { TipKind } from '../shared/types.ts';

const near = (actual: number, expected: number, tol: number) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} ≉ ${expected} (±${tol})`);

test('beste Route gibt die vollen 1000 Punkte, kleine Abweichungen sind toleriert', () => {
  assert.equal(scoreRoute(30, 30), 1000);
  assert.equal(scoreRoute(31, 30), 1000); // Toleranz max(1 min, 4 %)
});

test('Punkte fallen mit der Reisezeit und sind bei +70 % weg', () => {
  near(scoreRoute(38, 30), 560, 25);
  near(scoreRoute(45, 30), 200, 25);
  near(scoreRoute(60, 40), 200, 25);
  assert.equal(scoreRoute(30 * 1.7 + 2, 30), 0);
  for (let m = 30; m < 60; m++) assert.ok(scoreRoute(m + 1, 30) <= scoreRoute(m, 30), `nicht monoton bei ${m}`);
});

test('besser als die beste Route der Auskunft: Bonus bis höchstens 1300', () => {
  near(scoreRoute(29, 30), 1067, 2);
  assert.equal(scoreRoute(27, 30), 1200);
  assert.equal(scoreRoute(24, 30), 1300);
  assert.equal(scoreRoute(10, 30), 1300);
});

test('Umstiegsaufschlag nur bei „beste Route“: 2 min mit Ø-Wartezeiten, sonst 4 min', () => {
  assert.equal(transferPenalty({ goal: 'best', avgWait: true }), 2);
  assert.equal(transferPenalty({ goal: 'best', avgWait: false }), 4);
  assert.equal(transferPenalty({ goal: 'fastest', avgWait: true }), 0);
  assert.equal(routeCost(30, 2, { goal: 'best', avgWait: true }), 34);
});

test('Tipps wirken multiplikativ – mindestens 10 % der Routenpunkte bleiben', () => {
  const all = Object.keys(TIPS) as TipKind[];
  for (const level of ['cheap', 'expensive'] as const) {
    const share = tipShareOf(all, level);
    assert.ok(share <= 1 - TIP_MIN_KEEP + 1e-9, `${level}: ${share}`);
    assert.ok(tipShareOf(all.slice(0, 1), level) < share);
  }
  assert.ok(tipShareOf(all.slice(0, 1), 'expensive') > tipShareOf(all.slice(0, 1), 'cheap'));
});

test('Gesamtpunkte = (Route nach Tipps + Zeitbonus + Verorten) × Multiplikator', () => {
  const s = computeScore({ routePoints: 1000, tips: [], elapsedSec: 0, limitSec: 120, locateDist: null, multiplier: 1.5 });
  assert.equal(s.routeAfterTips, 1000);
  assert.equal(s.total, Math.round((s.routeAfterTips + s.timeBonus + s.locate) * 1.5));
  const late = computeScore({ routePoints: 1000, tips: [], elapsedSec: 120, limitSec: 120, locateDist: null, multiplier: 1 });
  assert.equal(late.timeBonus, 0);
});
