// Lernmodus (reine Logik): Takt-Text im Steckbrief, Vergleichsfarben
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareColors, fmtHeadway, headwayText } from '../client/src/learn/model.ts';

test('Takt: Mo–Fr mit Abweichungen früh/abends, Sa, So; deutsche Zahlen', () => {
  const h = { U6: { wd7: 2.5, wd12: 4, wd20: 5, sa12: 5, su12: 5 } };
  assert.equal(headwayText('U6', h), 'Mo–Fr alle 4 min (früh alle 2,5, abends alle 5) · Sa alle 5 min · So alle 5 min');
});

test('Takt: gleicher Takt ohne Klammer, seltene Linien „× pro Stunde“, Nachtlinie nur abends', () => {
  assert.equal(headwayText('S45', { S45: { wd7: 10, wd12: 10, wd20: 10, sa12: 10, su12: 10 } }), 'Mo–Fr alle 10 min · Sa alle 10 min · So alle 10 min');
  assert.equal(fmtHeadway(60), '1× pro Stunde');
  assert.equal(fmtHeadway(30), 'alle 30 min');
  assert.equal(headwayText('N25', { N25: { wd7: null, wd12: null, wd20: null, sa12: null, su12: null } }), null);
  assert.equal(headwayText('X', {}), null);
  assert.equal(headwayText('X', undefined), null);
});

test('N-3: Vergleichsfarben – U-Bahnen in ihrer echten Farbe, andere Linien bekommen freie Farben', () => {
  const c = compareColors([
    { id: 'U6', mode: 'U', color: '#9d6930' },
    { id: '13A', mode: 'B', color: '#0a295d' },
    { id: 'U3', mode: 'U', color: '#ee7d00' },
    { id: '5', mode: 'T', color: '#a8475a' },
  ]);
  assert.equal(c.U6, '#9d6930');
  assert.equal(c.U3, '#ee7d00');
  assert.notEqual(c['13A'], c['5']);
  assert.ok(![c.U6, c.U3].includes(c['13A']));
});

test('N-1: Linien einer Gegend – Stephansplatz 600 m: U1/U3 und Busse 1A/2A/3A; ohne Bus keine Busse; Bezirk 1', async () => {
  const { readFileSync } = await import('node:fs');
  const { linesInArea } = await import('../client/src/learn/model.ts');
  const net = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8'));
  const stephansplatz = net.stations.find((s: { name: string }) => s.name === 'Stephansplatz');
  const circle = { kind: 'circle' as const, lat: stephansplatz.lat, lon: stephansplatz.lon, radiusM: 600 };
  const all = linesInArea(circle, new Set(['U', 'S', 'T', 'B']), net.lines, net.stations).map((x) => x.line.id);
  for (const id of ['U1', 'U3', '1A', '2A', '3A']) assert.ok(all.includes(id), `${id} fehlt: ${all.join(' ')}`);
  assert.ok(!all.some((id) => /^\d+E$/.test(id)), 'Sonderlinie dabei');
  const noBus = linesInArea(circle, new Set(['U', 'S', 'T']), net.lines, net.stations);
  assert.ok(noBus.every((x) => x.line.mode !== 'B'));
  const d1 = linesInArea({ kind: 'district', id: 1 }, new Set(['U']), net.lines, net.stations).map((x) => x.line.id);
  assert.deepEqual([...d1].sort(), ['U1', 'U2', 'U3', 'U4']);
});

test('Punkt 8: Stern für gleichwertige Linien („S1/S2“) – ein Knopf für die ganze Gruppe', async () => {
  const { readFileSync } = await import('node:fs');
  const { NetIndex } = await import('../client/src/net.ts');
  const { app } = await import('../client/src/store.ts');
  app.net = new NetIndex(JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8')));
  const { starMini, setMine } = await import('../client/src/learn/model.ts');
  assert.match(starMini('S1/S2'), /data-star-group="S1\/S2"/);
  assert.match(starMini('U6'), /data-star-line="U6"/);
  assert.equal(starMini('XYZ'), '');
  setMine('S1', true);
  assert.match(starMini('S1/S2'), /✬/, 'teilweise gemerkt');
  setMine('S1', false);
});
