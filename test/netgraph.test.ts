// Netzgraph (Netzkarte): Kurven laufen exakt durch die Stationen, jede Haltefolge ist zeichenbar,
// Fahrtrichtungen stimmen – mit den echten Netzdaten.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { NetworkPublic } from '../shared/types.ts';
import { NetIndex } from '../client/src/net.ts';
import { app } from '../client/src/store.ts';

app.net = new NetIndex(JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8')) as NetworkPublic);
const { NetGraph, kindOf } = await import('../client/src/netgraph.ts');
const { patternsOf } = await import('../client/src/learn/model.ts');
const g = new NetGraph(app.net);
const near = (a: [number, number], s: { lat: number; lon: number }) => Math.abs(a[0] - s.lat) < 1e-9 && Math.abs(a[1] - s.lon) < 1e-9;

test('Grundkarte: U-, S-Bahn, Bim und die Kurs-Busse – keine anderen Busse, keine Nachtlinien', () => {
  const modes = new Set(g.lines.map((l) => l.mode));
  assert.deepEqual([...modes].sort(), ['B', 'S', 'T', 'U']);
  assert.deepEqual(g.lines.filter((l) => l.mode === 'B').map((l) => l.id).sort(), ['10A', '13A', '48A']);
});

test('jede Kurve beginnt und endet exakt an ihren Stationen', () => {
  for (const e of g.edges.values()) {
    assert.ok(e.curve.length >= 3, `zu wenige Punkte ${e.key}`);
    assert.ok(near(e.curve[0], g.station(e.a)), `Anfang ${e.key}`);
    assert.ok(near(e.curve[e.curve.length - 1], g.station(e.b)), `Ende ${e.key}`);
    for (const [lat, lon] of e.curve) assert.ok(Number.isFinite(lat) && Number.isFinite(lon), `NaN in ${e.key}`);
  }
});

test('jede reguläre Haltefolge lässt sich als durchgehende Kurve zeichnen', () => {
  for (const line of g.lines) {
    const kind = kindOf(line)!;
    for (const p of patternsOf(line)) {
      const seq = p.filter((id, i) => id !== p[i - 1]);
      if (seq.length < 2) continue;
      const path = g.path(kind, seq);
      assert.ok(path.length >= seq.length, `${line.id}: Kurve zu kurz`);
      assert.ok(near(path[0], g.station(seq[0])), `${line.id}: Anfang`);
      assert.ok(near(path[path.length - 1], g.station(seq[seq.length - 1])), `${line.id}: Ende`);
    }
  }
});

test('Abschnitte entlang einer Linie (für Bänder und Kurs-Abschnitte)', () => {
  const p = g.along('U6', 'Spittelau', 'Längenfeldgasse');
  assert.ok(p.length > 10);
  assert.ok(near(p[0], app.net.data.stations.find((s) => s.name === 'Spittelau')!));
  assert.deepEqual(g.along('U6', 'Spittelau', 'gibt es nicht'), []);
  assert.deepEqual(g.along('99X', 'A', 'B'), []);
});

test('Fahrtrichtungen: U-Bahn in beide Richtungen, einzelne Einbahn-Abschnitte (z.B. 13A) erkannt', () => {
  const u1 = [...g.edges.values()].filter((e) => e.lines.has('U1'));
  assert.ok(u1.length > 15);
  assert.ok(u1.every((e) => e.dirs.get('U1') === 3), 'U1 sollte überall in beide Richtungen fahren');
  const oneWay = [...g.edges.values()].filter((e) => e.dirs.get('13A') === 1 || e.dirs.get('13A') === 2);
  assert.ok(oneWay.length > 0, '13A hat getrennte Hin- und Rückwege');
});

test('Endstationen ohne Kurzführungen (S1 endet nicht am Praterstern)', () => {
  const ends = [...(g.terminals.get('S1')?.keys() ?? [])].map((id) => g.station(id).name);
  assert.ok(ends.includes('Süßenbrunn') && ends.includes('Liesing'), ends.join(', '));
  assert.ok(!ends.includes('Praterstern'), ends.join(', '));
});
