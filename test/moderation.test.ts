// Chat-Moderation mit der Standard-Liste: trifft Schimpfwörter (auch getarnt, mehrere Sprachen), aber keine harmlosen Wörter
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BAD_WORDS } from '../shared/config.ts';
import { isOffensive, moderate, setBadWords } from '../server/moderation.ts';

setBadWords(DEFAULT_BAD_WORDS);

test('Schimpfwörter in mehreren Sprachen werden ersetzt – auch getarnt und gebeugt', () => {
  for (const bad of ['du Arschloch', 'f1cken', 'F.u.c.k.i.n.g', 'oaschloch', 'Hurensohn!!', 'siktir git', 'amına', 'jebem ti', 'pička', 'kurac', 'mamu ti', 'kys', 'heil hitler'])
    assert.notEqual(moderate(bad), bad, bad);
  assert.equal(moderate('du Arschloch'), 'du *********');
});

test('harmlose Wörter bleiben – auch Teile von Ortsnamen und Wörter aus anderen Sprachen', () => {
  for (const ok of [
    'Musik in der Mongolei',
    'Marsch zum Karlsplatz',
    'der Barsch ist dick',
    'I got it, nice pic',
    'Schurer und Peter fahren U6',
    'Physikklausur am Schottentor',
    'Kurven bei der Fahrt',
    'Futter für die Tauben',
    'Ich bin Siktor',
    'Funsen? nein, Fundbüro',
    'Pickerl fürs Auto',
  ])
    assert.equal(moderate(ok), ok, ok);
});

test('Namen mit Schimpfwort werden abgelehnt, normale nicht', () => {
  assert.ok(isOffensive('xFickerx'));
  assert.ok(isOffensive('KurvaMaster'));
  assert.ok(!isOffensive('Grenadier7'));
  assert.ok(!isOffensive('Mongolei-Fan'));
  assert.ok(!isOffensive('Pedersen'));
  assert.ok(!isOffensive('Sikora'));
});
