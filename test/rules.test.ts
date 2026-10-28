// Wertung: Routenpunkte, Tipps, Umstiegsaufschlag, Gesamtpunkte
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeScore, difficultyMultiplier, fmtTimeLeft, maxRoundPoints, maxRoundPointsWithBonus, timeBonus, routeCost, scoreRoute, TIP_MIN_KEEP, TIPS, tipShareOf, transferPenalty } from '../shared/rules.ts';
import type { TipKind } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';

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

test('N-4: Restzeit statt benötigter Zeit', () => {
  assert.equal(fmtTimeLeft(50, 180), '2:10 / 3:00 übrig');
  assert.equal(fmtTimeLeft(200, 180), '0:00 / 3:00 übrig');
  assert.equal(fmtTimeLeft(8, 15), '7 / 15 s übrig');
  assert.equal(fmtTimeLeft(50, null), 'in 0:50');
});

test('Wertung von Hand nachgerechnet: scoreRoute-Tabelle', () => {
  // Toleranz max(1, 4 %), danach f = 1 − Umweg/(Bestzeit·0,7), Punkte = 1000·f^1,5; besser als die Auskunft: +2 % je 1 %
  const cases: [number, number, number][] = [[30, 30, 1000], [31.2, 30, 1000], [32, 30, 943], [38, 30, 556], [51, 30, 14], [52, 30, 1], [53, 30, 0],
    [29, 30, 1067], [27, 30, 1200], [24, 30, 1300], [4, 5, 1200], [10, 0, 0]];
  for (const [u, b, want] of cases) assert.equal(scoreRoute(u, b), want, `scoreRoute(${u}, ${b})`);
});

test('computeScore von Hand: 556 Routenpunkte, Tipp Start günstig, 90/180 s, Ortung 250 + 1625 m, ×1,05 → 487', () => {
  const s = computeScore({ routePoints: 556, tips: ['startLines'], elapsedSec: 90, limitSec: 180, locateDist: { from: 250, to: 1625 }, multiplier: 1.05, tipLevel: 'cheap' });
  // 556·0,6 = 333,6 → 334 · Zeitbonus 334·0,1·0,5 = 16,7 → 17 · Ortung 75 + 37,5 → 38 · (334 + 17 + 113)·1,05 = 487,2
  assert.deepEqual([s.routeAfterTips, s.timeBonus, s.locate, s.total], [334, 17, 113, 487]);
});

test('Regression L-01: Schwierigkeits-Faktor – „wichtige U“ zählt ×0,85', () => {
  const base = { distance: 'short', minTransfers: 0 } as const;
  assert.equal(difficultyMultiplier({ ...base, stations: ['Ukey'] }), 0.77); // 0,85 · 0,9 · 1 = 0,765
  assert.equal(difficultyMultiplier({ stations: ['U', 'S'], distance: 'medium', minTransfers: 1 }), 1.05);
  assert.equal(difficultyMultiplier({ stations: ['U', 'S', 'T', 'all'], distance: 'long', minTransfers: 2 }), 1.69); // 1,4 · 1,1 · 1,1
  assert.equal(difficultyMultiplier({ stations: [], distance: 'medium', minTransfers: 0 }), 0.9);
});

test('Regression L-02: Maximum mit Bonus für bessere Routen (Profi + Ortung: 2113 regulär, 2670 mit Bonus)', () => {
  const profi = { ...DEFAULT_SETTINGS, stations: ['U', 'S', 'T', 'all'], distance: 'long', minTransfers: 2, locate: true } as typeof DEFAULT_SETTINGS;
  assert.equal(maxRoundPoints(profi), 2113); // (1000 + 100 + 150) · 1,69 = 2112,5
  assert.equal(maxRoundPointsWithBonus(profi), 2670); // (1300 + 130 + 150) · 1,69 = 2670,2
});

test('Regression L-04/L-05: Zeitbonus nie über 10 %, kaputte Zeiten geben 0 statt NaN', () => {
  assert.equal(timeBonus(1000, -50, 180), 100);
  assert.equal(timeBonus(1000, 500, 180), 0);
  assert.equal(scoreRoute(Number.NaN, 30), 0);
  assert.equal(scoreRoute(30, Number.POSITIVE_INFINITY), 0);
});

test('Adressen als Start/Ziel: Haltestellen-Auswahl zählt nicht, Faktor wie Bus-Knoten (×1,3)', () => {
  const s = { stations: ['Ukey'] as never, distance: 'medium' as const, minTransfers: 0 as const };
  assert.equal(difficultyMultiplier({ ...s, endpoints: 'addresses' }), 1.3);
  assert.equal(difficultyMultiplier({ ...s, stations: ['U', 'S', 'T', 'all'] as never, endpoints: 'addresses' }), 1.3);
  assert.equal(difficultyMultiplier({ ...s, endpoints: 'stations' }), 0.85);
});

test('Wertungs-Modi: drei Modi, „Umstiege vermeiden“ nur bei Realistisch, alte Kombinationen = eigene', async () => {
  const { SCORING_MODES, scoringModeOf } = await import('../shared/rules.ts');
  const { DEFAULT_SETTINGS } = await import('../shared/defaults.ts');
  assert.deepEqual(SCORING_MODES.map((m) => m.id), ['realistic', 'info', 'ride']);
  for (const m of SCORING_MODES) assert.equal(scoringModeOf(m.settings), m.id);
  // Standard: Realistisch ohne Umstiegs-Aufschlag
  assert.equal(scoringModeOf(DEFAULT_SETTINGS), 'realistic');
  assert.equal(DEFAULT_SETTINGS.goal, 'fastest');
  assert.equal(transferPenalty(DEFAULT_SETTINGS), 0);
  // Umstiege vermeiden = Realistisch mit goal 'best' (+2 min je Umstieg)
  assert.equal(scoringModeOf({ countWait: true, avgWait: true, goal: 'best' }), 'realistic');
  assert.equal(transferPenalty({ goal: 'best', avgWait: true }), 2);
  // ältere Kombinationen
  assert.equal(scoringModeOf({ countWait: false, avgWait: true, goal: 'best' }), null);
  assert.equal(scoringModeOf({ countWait: true, avgWait: false, goal: 'best' }), null);
});
