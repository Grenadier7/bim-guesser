// Ø-Wartezeit: erwartete Zeit bis zur nächsten Abfahrt bei zufälliger Ankunft innerhalb einer Stunde
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedWait } from '../server/routing.ts';

const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

test('Regression L-03: regelmäßiger Takt → genau der halbe Takt (10 → 5, 15 → 7,5)', () => {
  const every = (h: number) => Array.from({ length: 20 }, (_, i) => hhmm('12:00') + i * h);
  assert.equal(expectedWait(every(10), hhmm('12:00')), 5);
  assert.equal(expectedWait(every(15), hhmm('12:00')), 7.5);
});

test('unregelmäßiger Takt (50B: 12:35, 13:15, 13:55, 14:45) wird exakt gemittelt', () => {
  const deps = ['12:35', '13:15', '13:55', '14:45'].map(hhmm);
  // 12:00–12:35: Ø 17,5 min über 35 min · 12:35–13:00: Ø (40 + 15) / 2 = 27,5 über 25 min  ⇒  (612,5 + 687,5) / 60
  assert.equal(Math.round(expectedWait(deps, hhmm('12:00'))! * 1000) / 1000, 21.667);
});

test('Reihenfolge der Abfahrten egal, Betriebsschluss → null', () => {
  assert.equal(expectedWait([hhmm('12:30'), hhmm('12:10')], hhmm('12:00'), 10), 5);
  assert.equal(expectedWait([], hhmm('12:00')), null);
  assert.equal(expectedWait([hhmm('11:50')], hhmm('12:00')), null);
});

test('kein Sprung, wenn man 2 min später ankommt', () => {
  const deps = Array.from({ length: 30 }, (_, i) => hhmm('06:00') + i * 15 + (i % 3) * 2);
  const a = expectedWait(deps, hhmm('12:00'))!;
  const b = expectedWait(deps, hhmm('12:02'))!;
  assert.ok(Math.abs(a - b) < 1, `${a} vs ${b}`);
});
