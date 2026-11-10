// Zielnetz 2040: alle Änderungen greifen (Bericht ohne ✖), Takt gilt für die Linie (nicht je Haltefolge),
// Netz und Fahrplan zeigen dieselben neuen Strecken
import './support/scale.ts';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createApp } from '../server/app.ts';
import { Network } from '../server/network.ts';
import { reloadTimetable, timetableView } from '../server/timetable.ts';
import { ZIEL2040 } from '../server/ziel2040.ts';

process.env.TIMETABLE = 'on';
const net = Network.load();
let report: string[] = [];

before(() => {
  createApp({ net, version: 'test', accountsDb: ':memory:', mail: async () => {} });
  report = reloadTimetable(ZIEL2040.id);
});

const view = (plan: string, line: string) => timetableView(plan, line, (e) => net.stationOfEfa(e), (e) => net.stations.get(net.stationOfEfa(e) ?? '')?.name ?? null)!;

test('jede Änderung des Zielnetzes greift im Fahrplan', () => {
  assert.ok(report.length >= ZIEL2040.edits.length, `${report.length} Zeilen`);
  const bad = report.filter((l) => !l.startsWith('✔'));
  assert.deepEqual(bad, []);
});

test('Takt der Linie: nur die Hauptfahrt je Richtung fährt im Takt – nicht jede Variante (S4 war 6× überlagert)', () => {
  const before = view('__base', 'S4');
  const after = view(ZIEL2040.id, 'S4');
  assert.ok(before.patterns.length >= 3, 'S4 hat Varianten');
  const inWindow = (deps: number[]) => deps.filter((t) => t >= 300 && t <= 1440).length;
  const busy = after.patterns.filter((p) => inWindow(p.deps.wd) > 0);
  assert.equal(busy.length, 2, busy.map((p) => p.key).join(', '));
  // 05:00–24:00 alle 15 min = 77 Fahrten je Richtung
  for (const p of busy) assert.equal(inWindow(p.deps.wd), 77, p.key);
  // Gegenrichtung: umgekehrte Halte, nicht eine Variante mit anderem Ende
  const [a, b] = busy.map((p) => p.key.split('>'));
  assert.deepEqual(a, [...b].reverse());
});

test('neue Strecken in Netz und Fahrplan', () => {
  const s12 = view(ZIEL2040.id, '12').patterns[0].stops.map((s) => s.name);
  for (const n of ['Rauscherstraße', 'Nordwestbahnsiedlung', 'Krieau', 'Stadion']) assert.ok(s12.includes(n), `12 über ${n}`);
  for (const n of ['Brigittaplatz', 'Höchstädtplatz']) assert.ok(!s12.includes(n), `12 nicht mehr über ${n}`);
  const s60 = view(ZIEL2040.id, 'S60').patterns[0].stops.map((s) => s.name);
  assert.ok(s60.includes('Zentralfriedhof'), 'S60 hält am Zentralfriedhof (zwischen Grillgasse und Kledering)');
  assert.equal(view(ZIEL2040.id, '26A').patterns.length, 0, '26A fährt nicht mehr – GE übernimmt die Strecke');
  assert.ok(view(ZIEL2040.id, 'GE').patterns[0].stops.length >= 20);
});

test('Stand des Netzes: gleich in Netz und Abfrage, neu sobald sich der Plan ändert (Browser lädt dann neu)', async () => {
  const { PlanStore } = await import('../server/plans.ts');
  const { PlanRuntime } = await import('../server/planruntime.ts');
  const store = new PlanStore();
  const rt = new PlanRuntime(Network.load(), store, () => ({ removed: [], added: [] }));
  const v1 = rt.version(ZIEL2040.id)!;
  assert.match(v1, /^[0-9a-f]{12}$/);
  assert.equal(JSON.parse(rt.networkJson(ZIEL2040.id)!).version, v1);
  assert.equal(rt.version('gibtsnicht'), null);
  // Plan ändern (eine Station mehr) → neuer Stand
  const plan = store.get(ZIEL2040.id)!;
  store.save(
    [...store.list().filter((p) => p.id !== plan.id), { ...plan, edits: [...plan.edits, { kind: 'addStation', station: 'z40-test', name: 'Teststation', lat: 48.2, lon: 16.4, district: 1 }] }],
    'test',
    'Test',
  );
  rt.apply(ZIEL2040.id);
  assert.notEqual(rt.version(ZIEL2040.id), v1);
});

test('Plan-Netz ohne „Aktuell“: U2 nur noch die neue Strecke, Volkstheater ist U5', async () => {
  const { PlanStore } = await import('../server/plans.ts');
  const { PlanRuntime } = await import('../server/planruntime.ts');
  const rt = new PlanRuntime(Network.load(), new PlanStore(), () => ({ removed: [], added: [] }));
  const n = rt.planNet(ZIEL2040.id)!;
  const name = (id: string) => n.stations.get(id)!.name;
  const u2 = n.lines.get('U2')!;
  assert.ok(u2.nets.every((x) => x === 'r'));
  for (const p of u2.patterns) {
    const names = p.map(name);
    assert.ok(names.includes('Neubaugasse') && names.includes('Pilgramgasse'), names.join(' › '));
    assert.ok(!names.includes('Volkstheater') && !names.includes('Karlsplatz'), names.join(' › '));
  }
  const vt = [...n.stations.values()].find((s) => s.name === 'Volkstheater')!;
  assert.deepEqual(vt.lines.filter((l) => l.startsWith('U')).sort(), ['U3', 'U5']);
});
