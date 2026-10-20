// Auskunfts-Attrappe für Tests im selben Prozess: ersetzt `globalThis.fetch`. Ohne eigenen Fahrplan fährt zwischen
// zwei beliebigen Stationen alle 5 min eine direkte „U6“ in 20 min. `fail` schaltet auf „Auskunft weg“.
// Vor dem ersten Import von server/efa.ts aufrufen (STATE_DIR für den Datei-Cache wird hier gesetzt).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface EfaMock {
  calls: number;
  fail: boolean;
}

export async function installEfaMock(): Promise<EfaMock> {
  process.env.STATE_DIR ??= mkdtempSync(path.join(tmpdir(), 'bimguesser-mock-'));
  const { Network } = await import('../../server/network.ts');
  const { naiveMinutes } = await import('../../server/efa.ts');
  const net = Network.load();
  const efa2st = new Map<string, string>();
  for (const [sid, ids] of Object.entries(net.data.efaIds)) for (const id of ids) efa2st.set(id, sid);
  const mock: EfaMock = { calls: 0, fail: false };
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
    mock.calls++;
    if (mock.fail) throw new TypeError('fetch failed (Attrappe: Auskunft nicht erreichbar)');
    const url = new URL(input instanceof Request ? input.url : String(input));
    const q = url.searchParams;
    if (!url.pathname.endsWith('XML_TRIP_REQUEST2')) return new Response(JSON.stringify({ departureList: [] }));
    const o = efa2st.get(q.get('name_origin') ?? '');
    const d = efa2st.get(q.get('name_destination') ?? '');
    if (!o || !d) return new Response(JSON.stringify({ trips: [] }));
    const dt = q.get('itdDate')!;
    const tm = q.get('itdTime')!;
    const T = naiveMinutes(+dt.slice(0, 4), +dt.slice(4, 6), +dt.slice(6, 8), +tm.slice(0, 2), +tm.slice(2, 4));
    const trips = Array.from({ length: Number(q.get('calcNumberOfTrips') ?? 5) }, (_, i) => ({
      legs: [{ points: [point(o, T + 1 + i * 5), point(d, T + 21 + i * 5)], mode: { code: 2, number: 'U6' }, stopSeq: [], path: '' }],
    }));
    return new Response(JSON.stringify({ trips }));
  }) as typeof fetch;
  return mock;
}
