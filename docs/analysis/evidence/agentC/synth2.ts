// Offline: synthetic EFA via mocked fetch, checks averaged waits (no live API calls)
const R = 'file:///D:/files/!workingDIR/Zuhause_Dateien/verbindungs_guesser/';
const { Network } = await import(R + 'server/network.ts');
const routing = await import(R + 'server/routing.ts');
const { naiveMinutes } = await import(R + 'server/efa.ts');
const net = Network.load();
const efa2st = new Map<string, string>();
for (const [sid, ids] of Object.entries(net.data.efaIds) as [string, string[]][]) for (const id of ids) efa2st.set(id, sid);

const U1 = net.lines.get('U1')!.patterns[0];
const U3 = net.lines.get('U3')!.patterns;
// transfer station: on U1 pattern and some U3 pattern
let X = '', u3p: string[] = [];
for (const p of U3) for (const s of p) if (!X && U1.indexOf(s) >= 3 && p.indexOf(s) + 3 < p.length) { X = s; u3p = p; }
const A = U1[U1.indexOf(X) - 3];
const C = u3p[u3p.indexOf(X) + 3];
console.log('route', net.station(A).name, '-U1->', net.station(X).name, '-U3->', net.station(C).name);

const SLOT = naiveMinutes(2026, 6, 30, 12, 0);
// timetables: [phase, headway, ride]
const TT: Record<string, [number, number, number]> = {};
let H1 = Number(process.argv[2] ?? 30), P1 = Number(process.argv[3] ?? 25);
TT[`${A}>${X}`] = [P1, H1, 10];
TT[`${X}>${C}`] = [1, Number(process.argv[4] ?? 4), 6];
const pt = (sid: string, min: number) => {
  const d = new Date(min * 60000);
  const p = (n: number) => String(n).padStart(2, '0');
  const s = net.station(sid);
  return { name: s.name, nameWO: s.name, ref: { id: net.data.efaIds[sid][0], coords: `${s.lon},${s.lat}` }, dateTime: { date: `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` } };
};
let calls = 0;
globalThis.fetch = (async (url: string) => {
  calls++;
  const q = new URL(url).searchParams;
  const o = efa2st.get(q.get('name_origin')!)!, d = efa2st.get(q.get('name_destination')!)!;
  const dt = q.get('itdDate')!, tm = q.get('itdTime')!;
  const T = naiveMinutes(+dt.slice(0, 4), +dt.slice(4, 6), +dt.slice(6, 8), +tm.slice(0, 2), +tm.slice(2, 4));
  const n = Number(q.get('calcNumberOfTrips') ?? 5);
  const tt = TT[`${o}>${d}`];
  const trips: any[] = [];
  if (tt) {
    const [ph, h, ride] = tt;
    let k = Math.ceil((T - SLOT - ph) / h);
    for (let i = 0; i < n; i++, k++) {
      const dep = SLOT + ph + k * h;
      trips.push({ legs: [{ points: [pt(o, dep), pt(d, dep + ride)], mode: { code: 2, number: `${o}>${d}` === `${A}>${X}` ? 'U1' : 'U3' }, stopSeq: [], path: '' }] });
    }
  }
  return new Response(JSON.stringify({ trips }), { status: 200 });
}) as any;

const legs = [{ line: 'U1', from: A, to: X }, { line: 'U3', from: X, to: C }];
for (const countWait of [false, true]) {
  const r = await routing.evaluateUserRoute(net, legs, A, C, SLOT, 'regular', { countWait, avgWait: true, restriction: null }, []);
  console.log(`H1=${H1} phase=${P1} countWait=${countWait}`, 'median', r.route?.medianMin, 'ride', r.route?.rideMin);
  console.log('  steps', r.route?.steps?.map((s: any) => `${s.kind}@${s.at}:${s.min}`).join(' '));
}
console.log('synthetic calls', calls);
// ideal: U3 wait with 4-min headway = expectedWait(...)
console.log('ideal U3 wait', routing.expectedWait(Array.from({ length: 90 }, (_, i) => 1 + i * Number(process.argv[4] ?? 4)), 12));
