// Ø-Wartezeit: erwartete Zeit bis zur nächsten Abfahrt bei zufälliger Ankunft innerhalb einer Stunde
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedWait } from '../server/routing.ts';

const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

test('regelmäßiger 10-min-Takt: im Schnitt 4,5 min warten (halber Takt)', () => {
  const deps = Array.from({ length: 20 }, (_, i) => hhmm('12:00') + i * 10);
  assert.equal(expectedWait(deps, hhmm('12:00')), 4.5);
});

test('unregelmäßiger Takt (50B: 12:35, 13:15, 13:55, 14:45) wird exakt gemittelt', () => {
  const deps = ['12:35', '13:15', '13:55', '14:45'].map(hhmm);
  // 12:00–12:35 → 35 … 0 min, 12:36–12:59 → 39 … 16 min  ⇒  (630 + 660) / 60
  assert.equal(expectedWait(deps, hhmm('12:00')), 21.5);
});

test('Reihenfolge der Abfahrten egal, Betriebsschluss → null', () => {
  assert.equal(expectedWait([hhmm('12:30'), hhmm('12:10')], hhmm('12:00'), 10), 5.5);
  assert.equal(expectedWait([], hhmm('12:00')), null);
  assert.equal(expectedWait([hhmm('11:50')], hhmm('12:00')), null);
});

test('kein Sprung, wenn man 2 min später ankommt', () => {
  const deps = Array.from({ length: 30 }, (_, i) => hhmm('06:00') + i * 15 + (i % 3) * 2);
  const a = expectedWait(deps, hhmm('12:00'))!;
  const b = expectedWait(deps, hhmm('12:02'))!;
  assert.ok(Math.abs(a - b) < 1, `${a} vs ${b}`);
});
