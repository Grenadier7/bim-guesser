// Fußwege über die Donau: nur über eine Brücke. Ein gerader Fußweg, der Donau oder Neue Donau schneidet, wird als
// Umweg über die nächste Donaubrücke gerechnet (Weg zur Brücke + von der Brücke zum Ziel). Die Routensuche bleibt
// gleich – nur die Entfernung eines Fußwegs ändert sich (Auswertung, Referenzroute, Baukasten).
import { distM } from './geo.ts';

type LL = [number, number];

export interface Barrier {
  /** Flusslinien (vereinfacht), je mit Begrenzungsrahmen [minLat, minLon, maxLat, maxLon] */
  lines: { pts: LL[]; box: [number, number, number, number] }[];
  /** Übergänge: Donaubrücken (Mitte) */
  bridges: { name: string; lat: number; lon: number }[];
}

/** schlanke Form für den Browser (/api/barrier) */
export interface BarrierJson {
  lines: LL[][];
  bridges: { name: string; lat: number; lon: number }[];
}

/** Flüsse, über die man nur auf einer Brücke kommt (Donaukanal, Wienfluss: Brücken alle paar hundert Meter) */
const RIVERS = new Set(['Donau', 'Neue Donau']);
/** Punkte näher als das am vorigen fallen weg – reicht für einen Fluss, der 200–400 m breit ist */
const SIMPLIFY_M = 60;
/** Linien in Stücke mit eigenem Rahmen teilen (schneller Vorab-Test) */
const CHUNK = 40;

/** aus data/water.json und data/bridges.json */
export function barrierJson(water: { waters: { name: string; kind: string; lines: LL[][] }[] }, bridges: { bridges: { name: string; river: string; lat: number; lon: number }[] }): BarrierJson {
  const lines: LL[][] = [];
  for (const w of water.waters) {
    if (w.kind !== 'river' || !RIVERS.has(w.name)) continue;
    for (const l of w.lines) {
      const out: LL[] = [];
      for (const p of l) if (!out.length || distM({ lat: out[out.length - 1][0], lon: out[out.length - 1][1] }, { lat: p[0], lon: p[1] }) >= SIMPLIFY_M) out.push([+p[0].toFixed(5), +p[1].toFixed(5)]);
      const end: LL = [+l[l.length - 1][0].toFixed(5), +l[l.length - 1][1].toFixed(5)];
      if (out[out.length - 1][0] !== end[0] || out[out.length - 1][1] !== end[1]) out.push(end);
      if (out.length > 1) lines.push(out);
    }
  }
  return { lines, bridges: bridges.bridges.filter((b) => b.river === 'Donau').map((b) => ({ name: b.name, lat: b.lat, lon: b.lon })) };
}

export function makeBarrier(j: BarrierJson): Barrier {
  const lines: Barrier['lines'] = [];
  for (const l of j.lines)
    for (let i = 0; i < l.length - 1; i += CHUNK) {
      const pts = l.slice(i, i + CHUNK + 1);
      const lats = pts.map((p) => p[0]);
      const lons = pts.map((p) => p[1]);
      lines.push({ pts, box: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)] });
    }
  return { lines, bridges: j.bridges };
}

const cross = (o: LL, a: LL, b: LL) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function intersects(p1: LL, p2: LL, q1: LL, q2: LL): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** schneidet der gerade Weg a → b einen der Flüsse? */
export function crossesRiver(bar: Barrier, a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean {
  const p1: LL = [a.lat, a.lon];
  const p2: LL = [b.lat, b.lon];
  const [minLat, maxLat] = a.lat < b.lat ? [a.lat, b.lat] : [b.lat, a.lat];
  const [minLon, maxLon] = a.lon < b.lon ? [a.lon, b.lon] : [b.lon, a.lon];
  for (const l of bar.lines) {
    if (l.box[2] < minLat || l.box[0] > maxLat || l.box[3] < minLon || l.box[1] > maxLon) continue;
    for (let i = 0; i < l.pts.length - 1; i++) if (intersects(p1, p2, l.pts[i], l.pts[i + 1])) return true;
  }
  return false;
}

/** kurzer Name für den Text: „U1-Brücke über die Donau“ → „U1-Brücke“, namenlose → „Donaubrücke“ */
export function bridgeLabel(name: string): string {
  const n = name.replace(/\s+über (die|der|den) .*$/, '').trim();
  return !n || n === 'Brücke' ? 'Donaubrücke' : n;
}

/** Fußweg a → b in Metern (Luftlinie) – über die Donau als Umweg über die nächste Brücke; `via` = diese Brücke */
export function walkRoute(bar: Barrier | null, a: { lat: number; lon: number }, b: { lat: number; lon: number }): { m: number; via: Barrier['bridges'][number] | null } {
  const direct = distM(a, b);
  if (!bar || direct < 150 || !crossesRiver(bar, a, b)) return { m: direct, via: null };
  let best = { m: Infinity, via: null as Barrier['bridges'][number] | null };
  for (const br of bar.bridges) {
    const m = distM(a, br) + distM(br, b);
    if (m < best.m) best = { m, via: br };
  }
  return best.via ? best : { m: direct, via: null };
}
