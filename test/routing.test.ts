// Routing mit synthetischer Auskunft (offline, deterministisch): Ø-Wartezeiten, lückenloses Nachladen der
// Abfahrten, Anzahl der Abfragen, Start = Ziel / kein Weg. `globalThis.fetch` liefert einen erfundenen Fahrplan.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'routing-test-'));
const { Network } = await import('../server/network.ts');
const routing = await import('../server/routing.ts');
const { naiveMinutes } = await import('../server/efa.ts');

const net = Network.load();
const efa2st = new Map<string, string>();
for (const [sid, ids] of Object.entries(net.data.efaIds)) for (const id of ids) efa2st.set(id, sid);

/** Fahrplan je Abschnitt „von>nach“: erste Abfahrt (min nach SLOT), Takt, Fahrzeit, Linie */
const timetable = new Map<string, { phase: number; every: number; ride: number; line: string }>();
let calls = 0;
let SLOT = 0;

const p2 = (n: number) => String(n).padStart(2, '0');
const point = (sid: string, min: number) => {
  const d = new Date(min * 60000);
  const s = net.station(sid);
  return {
    name: s.name,
    ref: { id: net.data.efaIds[sid][0], coords: `${s.lon},${s.lat}` },
    dateTime: { date: `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`, time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` },
  };
};
globalThis.fetch = (async (input: string | URL | Request) => {
  calls++;
  const q = new URL(input instanceof Request ? input.url : String(input)).searchParams;
  const o = efa2st.get(q.get('name_origin')!);
  const d = efa2st.get(q.get('name_destination')!);
  const dt = q.get('itdDate')!;
  const tm = q.get('itdTime')!;
  const T = naiveMinutes(+dt.slice(0, 4), +dt.slice(4, 6), +dt.slice(6, 8), +tm.slice(0, 2), +tm.slice(2, 4));
  const tt = timetable.get(`${o}>${d}`);
  const trips = [];
  if (tt) {
    let k = Math.ceil((T - SLOT - tt.phase) / tt.every);
    for (let i = 0; i < Number(q.get('calcNumberOfTrips') ?? 5); i++, k++) {
      const dep = SLOT + tt.phase + k * tt.every;
      trips.push({ legs: [{ points: [point(o!, dep), point(d!, dep + tt.ride)], mode: { code: 2, number: tt.line }, stopSeq: [], path: '' }] });
    }
  }
  return new Response(JSON.stringify({ trips }));
}) as typeof fetch;

// Umstieg U1 → U3 (Stephansplatz): A drei Stationen vor X auf der U1, C drei nach X auf der U3
const U1 = net.lines.get('U1')!.patterns[0];
const U3 = net.lines.get('U3')!.patterns;
let X = '';
let u3: string[] = [];
for (const p of U3) for (const s of p) if (!X && U1.indexOf(s) >= 3 && p.indexOf(s) + 3 < p.length) [X, u3] = [s, p];
const A = U1[U1.indexOf(X) - 3];
const C = u3[u3.indexOf(X) + 3];
const legs = [
  { line: 'U1', from: A, to: X },
  { line: 'U3', from: X, to: C },
];
let day = 1;
/** jeder Fall an einem eigenen Tag – sonst liefert der Auskunfts-Cache die Antworten des vorigen Falls */
function setup(u1: { phase: number; every: number }, u3every: number) {
  SLOT = naiveMinutes(2026, 6, day++, 12, 0);
  timetable.clear();
  timetable.set(`${A}>${X}`, { ...u1, ride: 10, line: 'U1' });
  timetable.set(`${X}>${C}`, { phase: 1, every: u3every, ride: 6, line: 'U3' });
  calls = 0;
}
const waitAt = (r: Awaited<ReturnType<typeof routing.evaluateUserRoute>>, station: string) =>
  r.route?.steps?.find((s) => s.kind === 'wait' && s.to === net.station(station).name)?.min;

test('Regression H-03: Umstiegs-Wartezeit hängt nicht davon ab, welche Fahrplan-Abschnitte zufällig geladen sind', async () => {
  for (const phase of [2, 25, 50]) {
    setup({ phase, every: 60 }, 3);
    const r = await routing.evaluateUserRoute(net, legs, A, C, SLOT, 'regular', { countWait: false, avgWait: true, restriction: null }, []);
    const w = waitAt(r, X);
    assert.ok(w != null && w <= 2, `U1 ab +${phase} min, U3 alle 3 min: Umstiegs-Wartezeit ${w} min`);
  }
});

test('Regression H-01: Ø-Wartezeit lädt nicht pauschal 3 Stunden Fahrplan (Abfragen begrenzt)', async () => {
  setup({ phase: 2, every: 4 }, 3);
  await routing.evaluateUserRoute(net, legs, A, C, SLOT, 'regular', { countWait: true, avgWait: true, restriction: null }, []);
  // gemessen: vorher 17 Abfragen (3 h Fahrplan je Abschnitt), jetzt 6 (Fenster 60 min + nächste Abfahrt)
  assert.ok(calls <= 8, `${calls} Abfragen für eine Route mit 2 Abschnitten`);
});

test('regelmäßiger Takt: Ø-Wartezeit beim Umstieg ≈ halber Takt', async () => {
  setup({ phase: 0, every: 5 }, 10);
  const r = await routing.evaluateUserRoute(net, legs, A, C, SLOT, 'regular', { countWait: false, avgWait: true, restriction: null }, []);
  const w = waitAt(r, X)!;
  assert.ok(w >= 4 && w <= 6, `10-min-Takt: ${w} min`);
});

test('Linie fährt im Fenster gar nicht → verständlicher Fehler statt Absturz', async () => {
  setup({ phase: 0, every: 5 }, 5);
  timetable.delete(`${X}>${C}`);
  const r = await routing.evaluateUserRoute(net, legs, A, C, SLOT, 'regular', { countWait: false, avgWait: false, restriction: null }, []);
  assert.equal(r.route, null);
  assert.match(r.error ?? '', /U3/);
});

test('Regression Punkt 16: Linie fährt den Abschnitt nicht → Meldung mit Vorschlag der Auskunft', async () => {
  setup({ phase: 0, every: 5 }, 5);
  // auf dem Abschnitt X → C fährt zu dieser Zeit nur eine andere U-Bahn (statt der gewählten U3)
  timetable.set(`${X}>${C}`, { phase: 1, every: 5, ride: 6, line: 'U2' });
  const r = await routing.evaluateUserRoute(net, legs, A, C, SLOT, 'regular', { countWait: false, avgWait: false, restriction: null }, []);
  assert.equal(r.route, null);
  assert.match(r.error ?? '', /U3 fährt um diese Zeit nicht direkt/);
  assert.match(r.error ?? '', /So fährt man.*U2 bis/);
});
