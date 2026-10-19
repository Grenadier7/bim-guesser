// Charakterisierung: Einstellungen und Eingaben aus Requests (server/settings.ts) – inkl. alter Formate
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults.ts';
import { cleanLegs, sanitizeSettings, validLatLon } from '../server/settings.ts';

test('ohne Eingabe: Standardwerte (Kopie, nicht dasselbe Objekt)', () => {
  const s = sanitizeSettings(undefined);
  assert.deepEqual(s, DEFAULT_SETTINGS);
  assert.notEqual(s, DEFAULT_SETTINGS);
});

test('Schnellwahl setzt die Regler, einzelne Regler überschreiben danach → custom', () => {
  const easy = sanitizeSettings({ difficulty: 'easy' });
  assert.deepEqual([easy.stations, easy.distance, easy.minTransfers, easy.difficulty], [['Ukey', 'Skey'], 'medium', 0, 'easy']);
  const custom = sanitizeSettings({ difficulty: 'easy', distance: 'long' });
  assert.equal(custom.difficulty, 'custom');
  assert.equal(custom.distance, 'long');
});

test('alte Formate: needTransfer, tips true/false, restrictions true/false', () => {
  assert.equal(sanitizeSettings({ needTransfer: false } as never).minTransfers, 0);
  assert.equal(sanitizeSettings({ needTransfer: true, minTransfers: undefined } as never).minTransfers, 1);
  assert.equal(sanitizeSettings({ tips: true } as never).tips, 'cheap');
  assert.equal(sanitizeSettings({ tips: false } as never).tips, 'off');
  assert.equal(sanitizeSettings({ restrictions: true } as never).restrictions, 'sometimes');
  assert.equal(sanitizeSettings({ restrictions: false } as never).restrictions, 'never');
});

test('Grenzwerte: Runden 1–10 (nur ganze Zahlen), Zeitlimit 20–600 s oder null', () => {
  assert.equal(sanitizeSettings({ rounds: 0 }).rounds, 1);
  assert.equal(sanitizeSettings({ rounds: 99 }).rounds, 10);
  assert.equal(sanitizeSettings({ rounds: 2.5 }).rounds, DEFAULT_SETTINGS.rounds);
  assert.equal(sanitizeSettings({ roundTimeLimitSec: 1 }).roundTimeLimitSec, 20);
  assert.equal(sanitizeSettings({ roundTimeLimitSec: 9999 }).roundTimeLimitSec, 600);
  assert.equal(sanitizeSettings({ roundTimeLimitSec: null }).roundTimeLimitSec, null);
});

test('Fokus nur in/um Wien, Radius aus der Liste, Koordinaten gerundet', () => {
  assert.equal(sanitizeSettings({ focus: { lat: 52.5, lon: 13.4, radiusM: 2500, share: 0.5 } }).focus, null);
  const f = sanitizeSettings({ focus: { lat: 48.2081234, lon: 16.3731234, radiusM: 1234, share: 0.5 } }).focus!;
  assert.deepEqual([f.lat, f.lon, f.radiusM], [48.20812, 16.37312, 2500]);
});

test('X-treme: ohne Namen/Karte kein „Wo liegt das?“, günstige Tipps werden teuer', () => {
  const s = sanitizeSettings({ xtreme: 'noMap', locate: true, tips: 'cheap' });
  assert.equal(s.locate, false);
  assert.equal(s.tips, 'expensive');
  assert.equal(sanitizeSettings({ xtreme: 'quatsch' as never }).xtreme, DEFAULT_SETTINGS.xtreme);
});

test('Teilstrecken: höchstens 10, nur Objekte, Felder gekürzt', () => {
  assert.deepEqual(cleanLegs('x'), []);
  const legs = cleanLegs([null, 5, { line: 'U6'.repeat(20), from: 1, to: undefined }, ...Array(20).fill({ line: 'U1' })]);
  assert.equal(legs.length, 8); // erst auf 10 Einträge gekürzt, davon 2 keine Objekte
  assert.deepEqual(legs[0], { line: 'U6U6U6U6U6U6', from: '1', to: '' });
});

test('Koordinaten-Tipp: genau zwei endliche Zahlen im gültigen Bereich', () => {
  assert.deepEqual(validLatLon([48.2, 16.4]), [48.2, 16.4]);
  assert.deepEqual(validLatLon(['48.2', '16.4']), [48.2, 16.4]);
  for (const bad of [null, [1], [1, 2, 3], [91, 0], [0, 181], [NaN, 0], 'x']) assert.equal(validLatLon(bad), null, String(bad));
});
