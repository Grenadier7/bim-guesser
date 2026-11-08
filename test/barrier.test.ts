// Fußwege über die Donau nur über eine Brücke (shared/barrier.ts) – mit den echten Daten
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { barrierJson, bridgeLabel, crossesRiver, makeBarrier, walkRoute } from '../shared/barrier.ts';
import { distM } from '../shared/geo.ts';

const read = (f: string) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const net = read('network.json') as { stations: { id: string; name: string; lat: number; lon: number; lines: string[] }[] };
const json = barrierJson(read('water.json'), read('bridges.json'));
const bar = makeBarrier(json);
const st = (name: string, line?: string) => net.stations.find((s) => s.name === name && (!line || s.lines.includes(line)))!;

test('Barriere: Donau und Neue Donau, Donaubrücken als Übergänge, klein genug für den Browser', () => {
  assert.ok(json.lines.length >= 2);
  assert.ok(json.bridges.some((b) => b.name === 'Reichsbrücke'));
  assert.ok(JSON.stringify(json).length < 60_000, `${JSON.stringify(json).length} Zeichen`);
});

test('Fußweg über die Donau → Umweg über die nächste Brücke', () => {
  // wie im Bild: Donauinsel-Seite → anderes Ufer
  const a = st('Kaisermühlen-VIC', 'U1');
  const b = st('Handelskai', 'U6');
  assert.ok(crossesRiver(bar, a, b));
  const r = walkRoute(bar, a, b);
  assert.ok(r.via, 'über eine Brücke');
  assert.ok(r.m >= distM(a, b));
  // mitten zwischen zwei Brücken quer über den Fluss: deutlicher Umweg
  const c = { lat: 48.2165, lon: 16.4265 };
  const d = { lat: 48.2105, lon: 16.4135 };
  const r2 = walkRoute(bar, c, d);
  assert.ok(crossesRiver(bar, c, d) && r2.via);
  assert.ok(r2.m > distM(c, d) * 1.5, `${Math.round(r2.m)} m statt ${Math.round(distM(c, d))} m Luftlinie`);
});

test('Fußwege auf derselben Seite bleiben Luftlinie', () => {
  for (const [x, y] of [
    ['Westbahnhof', 'Burggasse-Stadthalle'],
    ['Handelskai', 'Dresdner Straße'],
    ['Kagran', 'Kagraner Platz'],
  ]) {
    const a = st(x);
    const b = st(y);
    const r = walkRoute(bar, a, b);
    assert.equal(r.via, null, `${x} → ${y}`);
    assert.equal(Math.round(r.m), Math.round(distM(a, b)));
  }
});

test('ohne Daten: Luftlinie', () => {
  const a = st('Kaisermühlen-VIC', 'U1');
  const b = st('Handelskai', 'U6');
  assert.equal(walkRoute(null, a, b).m, distM(a, b));
});

test('Brückenname kurz', () => {
  assert.equal(bridgeLabel('U1-Brücke über die Donau'), 'U1-Brücke');
  assert.equal(bridgeLabel('U6 Brücke über der Donau'), 'U6 Brücke');
  assert.equal(bridgeLabel('Brücke über die Donau'), 'Donaubrücke');
  assert.equal(bridgeLabel('Reichsbrücke'), 'Reichsbrücke');
});
