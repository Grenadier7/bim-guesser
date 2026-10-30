// Eigene Verbindungssuche auf dem Referenzfahrplan (data/timetable.json, siehe scripts/build-timetable.ts).
//
// Liefert dieselben Fahrten wie die Wiener-Linien-Auskunft (efa.trip) – für die Referenztage des regulären Netzes
// ohne Abfrage im Internet, mit Regionalzügen (R/REX/CJX) und ohne dass der Tag je aus der Auskunft verschwindet.
// Für alle anderen Tage („Aktuell“) gibt localTrip null zurück und efa.ts fragt wie bisher die Auskunft.
//
// Verfahren: RAPTOR (Delling, Pajor, Werneck 2012) – Runde k = beste Ankunft mit höchstens k Fahrten. Daraus die
// Pareto-Menge „schneller, aber mehr Umstiege“; mehrere Abfahrten durch erneutes Suchen nach der ersten Abfahrt.
// Fußwege: zwischen Halten bis 500 m und von/zu Adressen bis 1,5 km, Luftlinie × 1,3 bei 80 m/min (wie im Spiel).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LatLon, LineEdit, Mode } from '../shared/types.ts';
import type { EfaLeg, EfaPoint, EfaTrip, TripQuery } from './efa.ts';
import { overrides, params } from './overrides.ts';

const FILE = process.env.TIMETABLE_FILE ?? path.resolve(import.meta.dirname, '../data/timetable.json');
// Umsteigezeit, Fußwege und höchstens so viele Fahrten: params (server/overrides.ts, Admin-Seite) –
// Standard 2 min Umsteigen, Fußweg zu anderer Haltestelle ≤ 500 m, von/zu Adressen ≤ 1,5 km, ganz zu Fuß ≤ 1,2 km, ≤ 5 Fahrten

const walkMin = (m: number) => Math.max(1, Math.round((m * 1.3) / 80));

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

// ---------------------------------------------------------------- Daten

interface Node {
  key: string;
  efaId: string;
  name: string;
  lat: number;
  lon: number;
}

interface Pattern {
  line: number;
  stops: number[];
  /** durchgebundener Zug: ab Position `at` heißt er anders (S7 → REX2 ab Rennweg) */
  cont: { line: number; at: number } | null;
}

/** Linie einer Fahrt auf diesem Muster ab Position `board` (wer vor dem Wechsel einsteigt, fährt mit der ersten) */
const lineAt = (p: Pattern, board: number) => (p.cont && board >= p.cont.at ? p.cont.line : p.line);

/** Fahrten eines Musters an einem Tag: Zeiten flach (Fahrt i, Halt j → times[i * len + j]), nach Abfahrt sortiert */
interface DayPattern {
  count: number;
  times: Int32Array;
}

interface Day {
  /** Mitternacht des Tages in „naiven“ Minuten (wie efa.naiveMinutes) */
  start: number;
  patterns: (DayPattern | null)[];
}

interface Data {
  nodes: Node[];
  byEfa: Map<string, number>;
  lines: { name: string; mode: Mode; mot: number }[];
  patterns: Pattern[];
  /** je Halt: (Muster, Position) */
  stopPatterns: [number, number][][];
  /** je Halt: erreichbare Halte zu Fuß (Halt, Minuten) */
  footpaths: [number, number][][];
  days: Map<string, Day>;
}

/** at:49:1040 ↔ EFA-ID 60201040 (Wiener Haltestellen) */
function efaIdOf(key: string): string {
  const m = /^at:49:(\d+)$/.exec(key);
  return m ? String(60200000 + Number(m[1])) : key;
}

let data: Data | null | undefined;
let validUntil: string | null = null;

/** Netz-Stationen ↔ Fahrplan-Halte (für Linien-Änderungen der Admin-Seite) – setzt app.ts */
export interface StationContext {
  /** Netz-Station zu einer EFA-ID (oder null) */
  stationOf(efaId: string): string | null;
  /** Netz-Station: Name, Lage und Haupt-EFA-ID (für neue Halte) */
  station(id: string): { name: string; lat: number; lon: number; efaId: string } | null;
}
let ctx: StationContext | null = null;
let report: string[] = [];

export function configureTimetable(c: StationContext) {
  ctx = c;
}

/** Fahrplan neu laden (nach Änderungen auf der Admin-Seite); liefert, was die Linien-Änderungen bewirkt haben */
export function reloadTimetable(): string[] {
  data = undefined;
  if (load() || !overrides().edits.length) return report;
  return ['⚠ Referenzfahrplan ist aus (TIMETABLE=off oder data/timetable.json fehlt) – Linien-Änderungen wirken nur auf den Routen-Baukasten.'];
}

export function timetableInfo(): { loaded: boolean; validUntil: string | null } {
  return { loaded: !!load(), validUntil };
}

/**
 * Warnung, wenn der Referenzfahrplan abgelaufen ist: laut Lizenz (Abschnitt 6a/7d) nach Ende der Gültigkeit nicht
 * mehr in öffentlich zugänglichen Auskunftssystemen verwenden – neue Daten laden (scripts/build-timetable.ts) oder
 * schriftliche Zustimmung der Mobilitätsverbünde Österreich einholen.
 */
export function timetableWarnings(now = new Date()): string[] {
  load();
  if (!validUntil || now.toISOString().slice(0, 10) <= validUntil) return [];
  return [`Referenzfahrplan nur bis ${validUntil} gültig – Lizenz! Neue GTFS-Daten laden und npm run build:timetable ausführen (oder TIMETABLE=off).`];
}

function load(): Data | null {
  if (data !== undefined) return data;
  if (process.env.TIMETABLE === 'off' || !existsSync(FILE)) return (data = null);
  const raw = JSON.parse(readFileSync(FILE, 'utf8')) as {
    validUntil?: string;
    days: Record<string, string>;
    nodes: [string, string, number, number][];
    lines: [string, Mode, number][];
    patterns: ([number, number[]] | [number, number[], number, number])[];
    trips: Record<string, number[][]>;
  };
  validUntil = raw.validUntil ?? null;
  report = applyEdits(raw, overrides().edits);
  const nodes = raw.nodes.map(([key, name, lat, lon]) => ({ key, efaId: efaIdOf(key), name, lat, lon }));
  const patterns = raw.patterns.map(([line, stops, contLine, contAt]) => ({ line, stops, cont: contLine != null ? { line: contLine, at: contAt! } : null }));
  const stopPatterns: [number, number][][] = nodes.map(() => []);
  patterns.forEach((p, pi) => p.stops.forEach((s, pos) => stopPatterns[s].push([pi, pos])));
  // Fußwege: grobes Raster für die Nachbarsuche (Zellen mindestens so groß wie der längste Umsteige-Fußweg)
  const reach = Math.max(300, params.transferWalkM);
  const cell = (lat: number, lon: number) => `${Math.floor((lat * 111_000) / reach)}:${Math.floor((lon * 74_000) / reach)}`;
  const grid = new Map<string, number[]>();
  nodes.forEach((n, i) => (grid.get(cell(n.lat, n.lon)) ?? grid.set(cell(n.lat, n.lon), []).get(cell(n.lat, n.lon))!).push(i));
  const footpaths = nodes.map((n, i) => {
    const out: [number, number][] = [];
    const [a, b] = cell(n.lat, n.lon).split(':').map(Number);
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (const j of grid.get(`${a + x}:${b + y}`) ?? []) {
          if (j === i) continue;
          const d = distM(n, nodes[j]);
          if (d <= params.transferWalkM) out.push([j, walkMin(d) + params.changeMin]);
        }
    return out;
  });
  const days = new Map<string, Day>();
  for (const [type, date] of Object.entries(raw.days)) {
    const [y, m, d] = date.split('-').map(Number);
    const byPattern = new Map<number, number[][]>();
    for (const t of raw.trips[type] ?? []) (byPattern.get(t[0]) ?? byPattern.set(t[0], []).get(t[0])!).push(t);
    const dayPatterns: (DayPattern | null)[] = patterns.map((p, pi) => {
      const list = byPattern.get(pi);
      if (!list?.length) return null;
      const len = p.stops.length;
      list.sort((x, z) => x[1] - z[1]);
      const times = new Int32Array(list.length * len);
      list.forEach((t, i) => {
        let cur = t[1];
        times[i * len] = cur;
        for (let j = 1; j < len; j++) times[i * len + j] = cur += t[1 + j];
      });
      return { count: list.length, times };
    });
    days.set(`${y}-${m}-${d}`, { start: Date.UTC(y, m - 1, d) / 60000, patterns: dayPatterns });
  }
  const byEfa = new Map(nodes.map((n, i) => [n.efaId, i]));
  data = { nodes, byEfa, lines: raw.lines.map(([name, mode, mot]) => ({ name, mode, mot })), patterns, stopPatterns, footpaths, days };
  console.log(`Referenzfahrplan geladen: ${nodes.length} Halte, ${patterns.length} Muster, Tage ${Object.values(raw.days).join(', ')}`);
  return data;
}

// ---------------------------------------------------------------- Linien-Änderungen (Admin-Seite)

type RawPattern = [number, number[]] | [number, number[], number, number];
interface Raw {
  nodes: [string, string, number, number][];
  lines: [string, Mode, number][];
  patterns: RawPattern[];
  trips: Record<string, number[][]>;
}

/**
 * Änderungen auf die Rohdaten anwenden, bevor daraus die Suchstrukturen entstehen. Fahrten sind [Muster, Abfahrt,
 * Fahrzeit zum 2. Halt, zum 3. Halt, …] – verlängern/kürzen ändert Haltefolge und diese Fahrzeiten gemeinsam.
 */
function applyEdits(raw: Raw, edits: LineEdit[]): string[] {
  if (!edits.length) return [];
  if (!ctx) return ['Linien-Änderungen nicht angewendet (Netz noch nicht verbunden).'];
  const c = ctx;
  const nodeStation = new Map<number, string | null>();
  const stationAt = (i: number) => {
    if (!nodeStation.has(i)) nodeStation.set(i, c.stationOf(efaIdOf(raw.nodes[i][0])));
    return nodeStation.get(i)!;
  };
  const tripsOf = (pi: number) => Object.values(raw.trips).flatMap((list) => list.filter((t) => t[0] === pi));
  /** Halt im Fahrplan für eine Netz-Station: am liebsten einer, den schon eine Linie desselben Verkehrsmittels nutzt */
  const nodeFor = (station: string, mode: Mode): number => {
    const cands = raw.nodes.map((_, i) => i).filter((i) => stationAt(i) === station);
    const sameMode = cands.find((i) => raw.patterns.some(([li, stops]) => raw.lines[li][1] === mode && stops.includes(i)));
    if (sameMode != null) return sameMode;
    if (cands.length) return cands[0];
    const st = c.station(station);
    if (!st) throw new Error(`Station ${station} gibt es nicht`);
    raw.nodes.push([st.efaId, st.name, st.lat, st.lon]);
    nodeStation.set(raw.nodes.length - 1, station);
    return raw.nodes.length - 1;
  };
  const name = (station: string) => c.station(station)?.name ?? station;
  const out: string[] = [];
  for (const e of edits) {
    const li = raw.lines.findIndex(([n]) => n === e.line);
    if (li < 0) {
      out.push(`✖ ${e.line}: Linie nicht im Fahrplan`);
      continue;
    }
    const mode = raw.lines[li][1];
    let pats = 0;
    let trips = 0;
    try {
      raw.patterns.forEach((p, pi) => {
        if (p[0] !== li && p[2] !== li) return;
        const stops = p[1];
        if (e.kind === 'extend') {
          if (p[2] != null) return;
          const add = e.stops.map((s) => nodeFor(s.station, mode));
          if (stops.some((s) => add.includes(s))) return; // schon verlängert
          if (stationAt(stops[stops.length - 1]) === e.at) {
            p[1] = [...stops, ...add];
            for (const t of tripsOf(pi)) (t.push(...e.stops.map((s) => s.min)), trips++);
          } else if (stationAt(stops[0]) === e.at) {
            const total = e.stops.reduce((a, s) => a + s.min, 0);
            p[1] = [...[...add].reverse(), ...stops];
            const mins = e.stops.map((s) => s.min).reverse();
            for (const t of tripsOf(pi)) (t.splice(1, 1, t[1] - total, ...mins), trips++);
          } else return;
          pats++;
        } else if (e.kind === 'cut') {
          if (p[0] !== li) return;
          const ia = stops.findIndex((s) => stationAt(s) === e.at);
          const ib = stops.findIndex((s) => stationAt(s) === e.beyond);
          if (ia < 0 || ib < 0) return;
          const list = tripsOf(pi);
          if (ib > ia) {
            // Teil danach weg: Haltefolge bis `at`, Fahrzeiten danach weg
            p[1] = stops.slice(0, ia + 1);
            for (const t of list) t.splice(2 + ia);
            if (p[3] != null && p[3] > ia) (p.length = 2);
          } else {
            // Teil davor weg: Abfahrt verschiebt sich auf `at`
            p[1] = stops.slice(ia);
            for (const t of list) {
              const skip = t.slice(2, 2 + ia).reduce((a, x) => a + x, 0);
              t.splice(1, 1 + ia, t[1] + skip);
            }
            if (p[3] != null) {
              const at = p[3] - ia;
              if (at <= 0) (p[0] = p[2]!, (p.length = 2));
              else p[3] = at;
            }
          }
          pats++;
          trips += list.length;
          // nur noch ein Halt: Fahrten ganz weg
          if (p[1].length < 2) for (const [k, l] of Object.entries(raw.trips)) raw.trips[k] = l.filter((t) => t[0] !== pi);
        } else {
          let hit = false;
          for (let j = 1; j < stops.length; j++) {
            const a = stationAt(stops[j - 1]);
            const b = stationAt(stops[j]);
            if ((a === e.from && b === e.to) || (a === e.to && b === e.from)) {
              for (const t of tripsOf(pi)) ((t[1 + j] = e.min), trips++);
              hit = true;
            }
          }
          if (hit) pats++;
        }
      });
    } catch (err) {
      out.push(`✖ ${e.line}: ${(err as Error).message}`);
      continue;
    }
    const what =
      e.kind === 'extend'
        ? `ab/bis ${name(e.at)} weiter nach ${e.stops.map((s) => `${name(s.station)} (+${s.min})`).join(', ')}`
        : e.kind === 'cut'
          ? `endet bei ${name(e.at)} (ohne Richtung ${name(e.beyond)})`
          : `${name(e.from)} ↔ ${name(e.to)}: ${e.min} min`;
    out.push(pats ? `✔ ${e.line} ${what}: ${pats} Haltefolge(n), ${trips} Fahrt(en)` : `✖ ${e.line} ${what}: keine passende Haltefolge gefunden`);
  }
  console.log(`Linien-Änderungen im Referenzfahrplan:\n  ${out.join('\n  ')}`);
  return out;
}

/** Gibt es den Referenzfahrplan für diesen Zeitpunkt? (sonst fragt efa.ts die Auskunft) */
export function coversTime(time: number): boolean {
  return !!dayOf(time);
}

function dayOf(time: number): Day | null {
  const d = load();
  if (!d) return null;
  const x = new Date(time * 60000);
  return d.days.get(`${x.getUTCFullYear()}-${x.getUTCMonth() + 1}-${x.getUTCDate()}`) ?? null;
}

// ---------------------------------------------------------------- RAPTOR

interface Access {
  node: number;
  min: number;
}

type Parent = { kind: 'ride'; pattern: number; trip: number; board: number; alight: number } | { kind: 'walk'; from: number; min: number } | null;

interface Journey {
  /** Fahrten in Reihenfolge; Fußwege dazwischen */
  parts: ({ kind: 'ride'; pattern: number; trip: number; board: number; alight: number } | { kind: 'walk'; from: number; to: number; dep: number; arr: number })[];
  originWalk: { to: number; min: number } | null;
  destWalk: { from: number; min: number } | null;
  dep: number;
  arr: number;
}

function raptor(d: Data, day: Day, origins: Access[], targets: Access[], t0: number, maxRides: number, mots: Set<number> | null): Journey[] {
  const n = d.nodes.length;
  const INF = 1e9;
  const best = new Float64Array(n).fill(INF);
  const tau: Float64Array[] = [new Float64Array(n).fill(INF)];
  const parents: Parent[][] = [new Array(n).fill(null)];
  const originMin = new Map<number, number>();
  let marked = new Set<number>();
  for (const o of origins) {
    const t = t0 + o.min;
    if (t < tau[0][o.node]) {
      tau[0][o.node] = best[o.node] = t;
      originMin.set(o.node, o.min);
      marked.add(o.node);
    }
  }
  const targetMin = new Map(targets.map((x) => [x.node, x.min]));
  const targetBest = () => {
    let b = INF;
    for (const [node, m] of targetMin) b = Math.min(b, best[node] + m);
    return b;
  };
  const results: Journey[] = [];
  let prevArr = INF;
  for (let k = 1; k <= maxRides && marked.size; k++) {
    tau[k] = Float64Array.from(tau[k - 1]);
    parents[k] = new Array(n).fill(null);
    // Muster, die an markierten Halten halten – ab der frühesten markierten Position
    const queue = new Map<number, number>();
    for (const s of marked)
      for (const [p, pos] of d.stopPatterns[s]) {
        if (mots && !mots.has(d.lines[d.patterns[p].line].mot)) continue;
        if (!day.patterns[p]) continue;
        const cur = queue.get(p);
        if (cur == null || pos < cur) queue.set(p, pos);
      }
    const bound = () => targetBest();
    const newly = new Set<number>();
    for (const [p, start] of queue) {
      const dp = day.patterns[p]!;
      const stops = d.patterns[p].stops;
      const len = stops.length;
      let trip = -1;
      let board = -1;
      for (let pos = start; pos < len; pos++) {
        const s = stops[pos];
        if (trip >= 0) {
          const arr = dp.times[trip * len + pos];
          if (arr < best[s] && arr < bound()) {
            tau[k][s] = best[s] = arr;
            parents[k][s] = { kind: 'ride', pattern: p, trip, board, alight: pos };
            newly.add(s);
          }
        }
        // früher einsteigen möglich?
        const ready = tau[k - 1][s];
        if (ready < INF && (trip < 0 || ready + (k > 1 ? params.changeMin : 0) <= dp.times[trip * len + pos])) {
          const need = ready + (k > 1 && !originMin.has(s) ? params.changeMin : 0);
          // erste Fahrt mit Abfahrt ≥ need an dieser Position (Fahrten überholen sich praktisch nie)
          let lo = 0;
          let hi = trip >= 0 ? trip : dp.count;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (dp.times[mid * len + pos] >= need) hi = mid;
            else lo = mid + 1;
          }
          if (lo < dp.count && (trip < 0 || lo < trip)) {
            trip = lo;
            board = pos;
          }
        }
      }
    }
    // Fußwege nach den Fahrten dieser Runde
    marked = new Set(newly);
    for (const s of newly)
      for (const [j, m] of d.footpaths[s]) {
        const t = tau[k][s] + m;
        if (t < best[j] && t < targetBest()) {
          tau[k][j] = best[j] = t;
          parents[k][j] = { kind: 'walk', from: s, min: m };
          marked.add(j);
        }
      }
    // bestes Ziel dieser Runde (Pareto: nur wenn schneller als mit weniger Fahrten)
    let arr = INF;
    let at = -1;
    for (const [node, m] of targetMin)
      if (tau[k][node] + m < arr && parents[k][node]) {
        arr = tau[k][node] + m;
        at = node;
      }
    if (at >= 0 && arr < prevArr) {
      prevArr = arr;
      const j = rebuild(d, day, tau, parents, k, at, originMin, targetMin.get(at)!);
      if (j) results.push(j);
    }
  }
  return results;
}

function rebuild(d: Data, day: Day, tau: Float64Array[], parents: Parent[][], k: number, target: number, originMin: Map<number, number>, destMin: number): Journey | null {
  const parts: Journey['parts'] = [];
  let node = target;
  for (let r = k; r > 0; r--) {
    let p = parents[r][node];
    if (p?.kind === 'walk') {
      parts.unshift({ kind: 'walk', from: p.from, to: node, dep: tau[r][p.from], arr: tau[r][node] });
      node = p.from;
      p = parents[r][node];
    }
    if (p?.kind !== 'ride') return null;
    parts.unshift({ kind: 'ride', pattern: p.pattern, trip: p.trip, board: p.board, alight: p.alight });
    node = d.patterns[p.pattern].stops[p.board];
  }
  if (!originMin.has(node)) return null;
  const first = parts.find((x) => x.kind === 'ride') as Extract<Journey['parts'][number], { kind: 'ride' }>;
  const len = d.patterns[first.pattern].stops.length;
  const firstDep = day.patterns[first.pattern]!.times[first.trip * len + first.board];
  const om = originMin.get(node)!;
  return {
    parts,
    originWalk: om > 0 ? { to: node, min: om } : null,
    destWalk: destMin > 0 ? { from: target, min: destMin } : null,
    dep: firstDep - om,
    arr: tau[k][target] + destMin,
  };
}

// ---------------------------------------------------------------- Umrechnen in EFA-Fahrten

function point(d: Data, i: number): EfaPoint {
  const n = d.nodes[i];
  return { id: n.efaId, name: n.name, place: 'Wien', lat: n.lat, lon: n.lon };
}

function toTrip(d: Data, day: Day, j: Journey, from: EfaPoint | null, to: EfaPoint | null): EfaTrip {
  const legs: EfaLeg[] = [];
  const walk = (a: EfaPoint, b: EfaPoint, dep: number, arr: number): EfaLeg => ({
    mode: 'W',
    line: null,
    from: a,
    to: b,
    dep: day.start + dep,
    arr: day.start + arr,
    path: [
      [a.lat, a.lon],
      [b.lat, b.lon],
    ],
    stops: [],
  });
  if (j.originWalk && from) legs.push(walk(from, point(d, j.originWalk.to), j.dep, j.dep + j.originWalk.min));
  for (const p of j.parts) {
    if (p.kind === 'walk') {
      legs.push(walk(point(d, p.from), point(d, p.to), p.dep, p.arr));
      continue;
    }
    const pat = d.patterns[p.pattern];
    const line = d.lines[lineAt(pat, p.board)];
    const len = pat.stops.length;
    const times = day.patterns[p.pattern]!.times;
    const stops = pat.stops.slice(p.board, p.alight + 1).map((s) => point(d, s));
    legs.push({
      mode: line.mode,
      line: line.name,
      from: stops[0],
      to: stops[stops.length - 1],
      dep: day.start + times[p.trip * len + p.board],
      arr: day.start + times[p.trip * len + p.alight],
      path: stops.map((s) => [s.lat, s.lon] as LatLon),
      stops,
    });
  }
  if (j.destWalk && to) legs.push(walk(point(d, j.destWalk.from), to, j.arr - j.destWalk.min, j.arr));
  return { legs, dep: legs[0].dep, arr: legs[legs.length - 1].arr };
}

// ---------------------------------------------------------------- Abfrage wie efa.trip

/** Start/Ziel: EFA-Halt oder „coord:lon:lat“ (Adresse) → Zugänge zu Fuß */
function access(d: Data, id: string): { list: Access[]; point: EfaPoint; address: boolean } | null {
  if (id.startsWith('coord:')) {
    const [, lon, lat] = id.split(':').map(Number);
    const p: EfaPoint = { id, name: 'Adresse', place: 'Wien', lat, lon };
    const list = d.nodes
      .map((n, i) => ({ node: i, m: distM(n, p) }))
      .filter((x) => x.m <= params.accessWalkM)
      .sort((a, b) => a.m - b.m)
      .slice(0, 40)
      .map((x) => ({ node: x.node, min: walkMin(x.m) }));
    return list.length ? { list, point: p, address: true } : null;
  }
  const i = d.byEfa.get(id);
  if (i == null) return null;
  // auch von Nachbarhaltestellen derselben Gegend los (wie die Auskunft: Station + Umgebung)
  return { list: [{ node: i, min: 0 }, ...d.footpaths[i].map(([node, min]) => ({ node, min: min - params.changeMin }))], point: point(d, i), address: false };
}

/** nur direkte Fahrten von A nach B (maxChanges 0): die nächsten Abfahrten, ohne Fußwege */
function direct(d: Data, day: Day, a: number, b: number, t: number, count: number, mots: Set<number> | null): EfaTrip[] {
  const found: { dep: number; trip: EfaTrip }[] = [];
  for (const [p, i] of d.stopPatterns[a]) {
    const pat = d.patterns[p];
    if (mots && !mots.has(d.lines[pat.line].mot)) continue;
    const j = pat.stops.indexOf(b, i + 1);
    const dp = day.patterns[p];
    if (j < 0 || !dp) continue;
    const len = pat.stops.length;
    for (let k = 0; k < dp.count; k++) {
      const dep = dp.times[k * len + i];
      if (dep < t) continue;
      found.push({ dep, trip: toTrip(d, day, { parts: [{ kind: 'ride', pattern: p, trip: k, board: i, alight: j }], originWalk: null, destWalk: null, dep, arr: dp.times[k * len + j] }, null, null) });
    }
  }
  return found
    .sort((x, y) => x.dep - y.dep)
    .slice(0, count)
    .map((x) => x.trip);
}

/**
 * Wie efa.trip – aber aus dem Referenzfahrplan. null = dafür gibt es keinen Referenzfahrplan (anderer Tag, unbekannte
 * Haltestelle) → efa.ts fragt die Auskunft.
 */
export function localTrip(q: TripQuery): EfaTrip[] | null {
  const d = load();
  const day = d && dayOf(q.time);
  if (!d || !day) return null;
  const from = access(d, q.from);
  const to = access(d, q.to);
  if (!from || !to) return null;
  const mots = q.mots ? new Set(q.mots) : null;
  const count = q.count ?? 5;
  const t = q.time - day.start;
  // direkt (für die Wartezeiten je Teilstrecke): alle Linien, die A → B fahren – ein Zwischenhalt (via) ist hier
  // überflüssig, die Auskunft brauchte ihn nur, weil sie sonst bloß die schnellste Linie liefert
  if (q.maxChanges === 0 && !from.address && !to.address) return direct(d, day, from.list[0].node, to.list[0].node, t, count, mots);
  const maxRides = q.maxChanges != null ? q.maxChanges + 1 : params.maxRides;
  const search = (tt: number, f: Access[], g: Access[], fp: EfaPoint | null, gp: EfaPoint | null) =>
    raptor(d, day, f, g, tt, maxRides, mots).map((j) => toTrip(d, day, j, fp, gp));
  const run = (tt: number): EfaTrip[] => {
    if (!q.via) return search(tt, from.list, to.list, from.point, to.point);
    // über einen Zwischenhalt: erst bis dorthin, dann weiter
    const via = d.byEfa.get(q.via);
    if (via == null) return [];
    const a = search(tt, from.list, [{ node: via, min: 0 }], from.point, null).at(-1);
    if (!a) return [];
    const b = search(a.arr - day.start, [{ node: via, min: 0 }], to.list, null, to.point).at(-1);
    if (!b) return [];
    return [{ legs: [...a.legs, ...b.legs], dep: a.dep, arr: b.arr }];
  };
  const out: EfaTrip[] = [];
  const seen = new Set<string>();
  let tt = t;
  for (let i = 0; i < count + 2 && out.length < count; i++) {
    const found = run(tt);
    const rides = found.filter((x) => x.legs.some((l) => l.mode !== 'W'));
    if (!rides.length) {
      out.push(...found.filter((x) => !seen.has(JSON.stringify(x.legs.map((l) => [l.line, l.dep])))));
      break;
    }
    for (const x of found) {
      const key = JSON.stringify(x.legs.map((l) => [l.line, l.dep]));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
    // nächste Suche nach der ersten Abfahrt mit einem Fahrzeug
    tt = Math.min(...rides.map((x) => x.legs.find((l) => l.mode !== 'W')!.dep)) - day.start + 1;
  }
  // ganz zu Fuß, wenn es nah ist (die Auskunft bietet das auch an)
  const fp = from.point;
  const tp = to.point;
  const dist = distM(fp, tp);
  if (dist <= params.walkOnlyM && q.via == null)
    out.push({ legs: [{ mode: 'W', line: null, from: fp, to: tp, dep: q.time, arr: q.time + walkMin(dist), path: [[fp.lat, fp.lon], [tp.lat, tp.lon]], stops: [] }], dep: q.time, arr: q.time + walkMin(dist) });
  return out.sort((a, b) => a.dep - b.dep || a.arr - b.arr).slice(0, Math.max(count, out.length));
}
