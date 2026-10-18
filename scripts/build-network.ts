// Baut data/network.json: alle Wiener Stationen + Linien mit Haltefolgen.
//  - U-Bahn, Bim, Bus, Nachtbus, Badner Bahn: aus dem offiziellen Wiener Linien GTFS
//  - S-Bahn: über die Wiener Linien Routing-API (EFA), da nicht im GTFS
//  - Referenztage für das "reguläre Netz": nächstgelegener Tag ohne Ersatzverkehr
//    (GTFS) und mit funktionierenden S-Bahn-Testverbindungen (API)
//
// Aufruf: npm run build:data   (lädt GTFS nach data/raw/, ~90 MB; --refresh lädt neu)
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { DayType, District, LatLon, Line, Mode, NetworkData, ReferenceDay, Station } from '../shared/types.ts';
import { lineColor } from '../shared/rules.ts';
import * as efa from '../server/efa.ts';
import { isTypicalDay, nextTypicalDay } from '../server/timeslots.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const GTFS_URL = 'https://www.wienerlinien.at/ogd_realtime/doku/ogd/gtfs/gtfs.zip';
const GTFS_ZIP = path.join(ROOT, 'data/raw/gtfs.zip');
const OUT = path.join(ROOT, 'data/network.json');
const DAY = 86400000;

// ---------------------------------------------------------------- GTFS lesen

async function ensureGtfs() {
  if (existsSync(GTFS_ZIP) && !process.argv.includes('--refresh')) return;
  console.log('Lade GTFS …');
  await mkdir(path.dirname(GTFS_ZIP), { recursive: true });
  const res = await fetch(GTFS_URL);
  if (!res.ok || !res.body) throw new Error(`GTFS download: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(GTFS_ZIP));
}

function openZip(): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) => yauzl.open(GTFS_ZIP, { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z!))));
}

/** Ruft onRow für jede Zeile einer GTFS-Datei auf (gestreamt) */
async function readCsv(file: string, onRow: (row: Record<string, string>) => void): Promise<void> {
  const zip = await openZip();
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName !== file) return zip.readEntry();
      zip.openReadStream(entry, async (err, stream) => {
        if (err || !stream) return reject(err);
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let header: string[] | null = null;
        for await (const raw of rl) {
          const cells = splitCsv(raw.replace(/^﻿/, ''));
          if (!header) {
            header = cells;
            continue;
          }
          const row: Record<string, string> = {};
          header.forEach((h, i) => (row[h] = cells[i] ?? ''));
          onRow(row);
        }
        zip.close();
        resolve();
      });
    });
    zip.on('end', () => reject(new Error(`${file} nicht im GTFS`)));
    zip.readEntry();
  });
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------- Hilfen

interface Node {
  efaId: string;
  name: string;
  lat: number;
  lon: number;
}

/** Haltefolge (EFA-IDs) mit Netz-Flags "c"/"r"/"cr" */
type FlaggedPatterns = Map<string, string>;

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function normName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+(S\s*U|U\s*S|S|U)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "at:49:1667:0:1" -> EFA-ID "60201667" (nur Wiener Haltestellen, Präfix at:49) */
function gtfsToEfa(stopId: string): string | null {
  const m = /^at:49:(\d+)/.exec(stopId);
  return m ? String(60200000 + Number(m[1])) : null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const noon = (d: Date) => efa.naiveMinutes(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 12, 0);

function mergeFlags(a: string | undefined, b: string): string {
  return [...new Set(((a ?? '') + b).split(''))].sort().join('');
}

/** Entfernt Haltefolgen, die komplett in einer anderen (mit mind. denselben Flags) enthalten sind */
function dropSubPatterns(pats: FlaggedPatterns): FlaggedPatterns {
  const list = [...pats.entries()].map(([k, f]) => ({ k, f, s: `,${k},`, n: k.split(',').length })).sort((a, b) => b.n - a.n);
  const out: FlaggedPatterns = new Map();
  for (const p of list) {
    const covered = [...out.entries()].some(([k, f]) => `,${k},`.includes(p.s) && p.f.split('').every((c) => f.includes(c)));
    if (!covered) out.set(p.k, p.f);
  }
  return out;
}

// ---------------------------------------------------------------- GTFS-Grunddaten

interface Gtfs {
  routes: Map<string, { short: string; type: number; long: string }>;
  trips: Map<string, { route: string; service: string }>;
  isActive: (service: string, date: Date) => boolean;
  validUntil: Date;
}

async function loadGtfs(): Promise<Gtfs> {
  const wdCols = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const cal = new Map<string, { days: boolean[]; start: string; end: string }>();
  let maxEnd = '';
  await readCsv('calendar.txt', (r) => {
    cal.set(r.service_id, { days: wdCols.map((c) => r[c] === '1'), start: r.start_date, end: r.end_date });
    if (r.end_date > maxEnd) maxEnd = r.end_date;
  });
  const exc = new Map<string, Map<string, string>>();
  await readCsv('calendar_dates.txt', (r) => {
    const m = exc.get(r.service_id) ?? new Map();
    m.set(r.date, r.exception_type);
    exc.set(r.service_id, m);
  });
  const isActive = (service: string, date: Date) => {
    const key = ymd(date);
    const e = exc.get(service)?.get(key);
    if (e) return e === '1';
    const c = cal.get(service);
    return !!c && c.days[(date.getUTCDay() + 6) % 7] && c.start <= key && c.end >= key;
  };

  const routes = new Map<string, { short: string; type: number; long: string }>();
  await readCsv('routes.txt', (r) =>
    routes.set(r.route_id, { short: r.route_short_name.trim(), type: Number(r.route_type), long: r.route_long_name }),
  );
  const trips = new Map<string, { route: string; service: string }>();
  await readCsv('trips.txt', (r) => trips.set(r.trip_id, { route: r.route_id, service: r.service_id }));
  const validUntil = new Date(`${maxEnd.slice(0, 4)}-${maxEnd.slice(4, 6)}-${maxEnd.slice(6, 8)}T00:00:00Z`);
  console.log(`GTFS: ${routes.size} Routen, ${trips.size} Fahrten, gültig bis ${iso(validUntil)}`);
  return { routes, trips, isActive, validUntil };
}

// ---------------------------------------------------------------- Referenztage (reguläres Netz)

/** S-Bahn-Testverbindungen, die an einem "normalen" Tag direkt fahren müssen */
const S_PROBES: [string, string][] = [
  ['Wien Floridsdorf', 'Wien Meidling'], // Stammstrecke
  ['Wien Praterstern', 'Wien Rennweg'], // Stammstrecke Mitte
  ['Wien Handelskai', 'Wien Hütteldorf'], // S45
  ['Wien Westbahnhof', 'Wien Hütteldorf'], // S50
  ['Wien Hauptbahnhof', 'Wien Simmering'], // S60/S80
];

/**
 * Wunsch-Referenztage – genommen, sobald die Auskunft für sie Daten hat (Prüfnotiz trotzdem ausgeben).
 * Ausgesucht per GTFS-Vergleich (Okt. 2026): Nur Ende Juni fährt die S-Bahn-Stammstrecke (ab ca. 8.7. bis
 * mindestens Dezember gesperrt) UND Bim/Bus sind fast im Normalbetrieb (Anfang Juni: 42 fährt nicht, 9 verkürzt).
 * Ab Mitte September wären Bim/Bus wieder normal – dann fehlt aber die Stammstrecke.
 * Achtung: Die Auskunft hält nur einige Monate Vergangenheit vor – danach neue Tage wählen.
 */
const PREFERRED_DAYS: Partial<Record<DayType, string>> = { wd: '2026-06-30', sa: '2026-06-27', su: '2026-06-28' };

async function pickRegularDays(gtfs: Gtfs): Promise<Record<DayType, ReferenceDay>> {
  // Ersatzverkehr-Routen der Wiener Linien und ihre Betriebstage
  const ersatz = new Map<string, Set<string>>(); // short name -> services
  for (const t of gtfs.trips.values()) {
    const r = gtfs.routes.get(t.route);
    if (!r || !/ersatz|SEV/i.test(`${r.long} ${r.short}`)) continue;
    ersatz.set(r.short, (ersatz.get(r.short) ?? new Set()).add(t.service));
  }
  const ersatzOn = (d: Date) => [...ersatz.entries()].filter(([, svc]) => [...svc].some((s) => gtfs.isActive(s, d))).map(([k]) => k);

  const probes: [string, string][] = [];
  for (const [a, b] of S_PROBES) {
    const [pa, pb] = await Promise.all([efa.findStop(a), efa.findStop(b)]);
    if (pa && pb) probes.push([pa.id, pb.id]);
  }
  /** Fehlgeschlagene Proben; bricht ab, sobald mehr als maxFails erreicht sind */
  const failedProbes = async (d: Date, maxFails: number) => {
    const failed: string[] = [];
    for (let i = 0; i < probes.length; i++) {
      const [a, b] = probes[i];
      const ok = await efa
        .trip({ from: a, to: b, time: noon(d), mots: [1], maxChanges: 0, count: 1 })
        .then((t) => t.length > 0)
        .catch(() => false);
      if (!ok) failed.push(`${S_PROBES[i][0].replace('Wien ', '')}–${S_PROBES[i][1].replace('Wien ', '')}`);
      if (failed.length > maxFails) break;
    }
    return failed;
  };

  const today = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  const result = {} as Record<DayType, ReferenceDay>;
  for (const type of ['wd', 'sa', 'su'] as DayType[]) {
    // Kandidaten: zuerst Zukunft (aufsteigend), dann Vergangenheit (absteigend); API hält ca. 4–5 Monate zurück
    const future: Date[] = [];
    const past: Date[] = [];
    for (let i = 1; today.getTime() + i * DAY <= gtfs.validUntil.getTime(); i++) future.push(new Date(today.getTime() + i * DAY));
    for (let i = 0; i <= 150; i++) past.push(new Date(today.getTime() - i * DAY));
    const candidates = [...future, ...past].filter((d) => isTypicalDay(d, type));

    // Wunschtag: genommen, sobald die Auskunft für ihn Daten hat (Score nur zur Info)
    const pref = PREFERRED_DAYS[type];
    if (pref) {
      const d = new Date(`${pref}T00:00:00Z`);
      const e = ersatzOn(d);
      const f = await failedProbes(d, probes.length);
      if (f.length < probes.length) {
        const note = [f.length ? `S-Bahn gestört: ${f.join(', ')}` : '', e.length ? `Ersatzverkehr: ${e.join(', ')}` : ''].filter(Boolean).join('; ');
        result[type] = { date: pref, score: f.length * 10 + e.length * 3, note: note || 'keine bekannten Störungen' };
        console.log(`Referenztag ${type}: ${pref} (Wunschtag, Score ${result[type].score}, ${result[type].note})`);
        continue;
      }
      console.log(`Wunschtag ${type} ${pref}: keine Daten in der Auskunft – suche automatisch`);
    }

    let best: ReferenceDay | null = null;
    let probed = 0;
    for (const d of candidates) {
      const e = ersatzOn(d);
      if (best && e.length * 3 >= best.score) continue;
      if (++probed > 150) break;
      const maxFails = best ? Math.floor((best.score - e.length * 3 - 1) / 10) : probes.length;
      const f = await failedProbes(d, maxFails);
      if (f.length > maxFails || f.length === probes.length) continue; // schlechter, oder keine API-Daten
      const score = f.length * 10 + e.length * 3;
      const note = [f.length ? `S-Bahn gestört: ${f.join(', ')}` : '', e.length ? `Ersatzverkehr: ${e.join(', ')}` : '']
        .filter(Boolean)
        .join('; ');
      if (!best || score < best.score) best = { date: iso(d), score, note: note || 'keine bekannten Störungen' };
      if (score === 0) break;
    }
    if (!best) throw new Error(`Kein Referenztag für ${type} gefunden`);
    result[type] = best;
    console.log(`Referenztag ${type}: ${best.date} (Score ${best.score}, ${best.note})`);
  }
  return result;
}

// ---------------------------------------------------------------- GTFS -> Linien

async function gtfsLines(gtfs: Gtfs, nodes: Map<string, Node>, current: Date[], regular: Date[]) {
  // Fahrten -> in welchem Netz aktiv
  const tripFlag = new Map<string, string>();
  const svcFlag = new Map<string, string>();
  for (const [tripId, t] of gtfs.trips) {
    let f = svcFlag.get(t.service);
    if (f === undefined) {
      f = (current.some((d) => gtfs.isActive(t.service, d)) ? 'c' : '') + (regular.some((d) => gtfs.isActive(t.service, d)) ? 'r' : '');
      svcFlag.set(t.service, f);
    }
    if (f) tripFlag.set(tripId, f);
  }
  console.log(`  ${tripFlag.size} Fahrten im aktuellen oder regulären Netz`);

  // Stops (nur Wien) -> Knoten auf Ebene der Haltestelle (Mittel der Steige)
  const acc = new Map<string, { names: Map<string, number>; lat: number; lon: number; n: number }>();
  await readCsv('stops.txt', (r) => {
    const id = gtfsToEfa(r.stop_id);
    if (!id) return;
    const a = acc.get(id) ?? { names: new Map(), lat: 0, lon: 0, n: 0 };
    a.names.set(r.stop_name, (a.names.get(r.stop_name) ?? 0) + 1);
    a.lat += Number(r.stop_lat);
    a.lon += Number(r.stop_lon);
    a.n++;
    acc.set(id, a);
  });
  for (const [id, a] of acc) {
    // häufigster Steig-Name, z.B. "Hauptbahnhof" statt "Südtiroler Pl. - Hbf."
    const name = [...a.names.entries()].sort((x, y) => y[1] - x[1])[0][0];
    nodes.set(id, { efaId: id, name, lat: a.lat / a.n, lon: a.lon / a.n });
  }

  // Haltefolgen je Linie und Netz zählen
  type Count = { c: Map<string, number>; r: Map<string, number>; type: number; nc: number; nr: number };
  const counts = new Map<string, Count>();
  let curTrip = '';
  let cur: [number, string][] = [];
  const flush = () => {
    const flag = tripFlag.get(curTrip);
    if (flag && cur.length) {
      const route = gtfs.routes.get(gtfs.trips.get(curTrip)!.route)!;
      cur.sort((a, b) => a[0] - b[0]);
      const seq: string[] = [];
      for (const [, s] of cur) {
        const id = gtfsToEfa(s);
        if (id && seq[seq.length - 1] !== id) seq.push(id);
      }
      if (seq.length >= 2) {
        const c = counts.get(route.short) ?? { c: new Map(), r: new Map(), type: route.type, nc: 0, nr: 0 };
        const key = seq.join(',');
        if (flag.includes('c')) c.c.set(key, (c.c.get(key) ?? 0) + 1), c.nc++;
        if (flag.includes('r')) c.r.set(key, (c.r.get(key) ?? 0) + 1), c.nr++;
        counts.set(route.short, c);
      }
    }
    cur = [];
  };
  let rows = 0;
  await readCsv('stop_times.txt', (r) => {
    if (r.trip_id !== curTrip) {
      flush();
      curTrip = r.trip_id;
    }
    if (tripFlag.has(r.trip_id)) cur.push([Number(r.stop_sequence), r.stop_id]);
    if (++rows % 2_000_000 === 0) console.log(`  stop_times: ${rows / 1e6} Mio. Zeilen`);
  });
  flush();

  const result: { id: string; mode: Mode; patterns: FlaggedPatterns }[] = [];
  for (const [short, c] of counts) {
    if (!short || /SEV|^ZF$/.test(short)) continue;
    const mode: Mode = c.type === 1 ? 'U' : c.type === 0 ? 'T' : short.startsWith('N') ? 'N' : 'B';
    const pats: FlaggedPatterns = new Map();
    for (const [flag, m, n] of [['c', c.c, c.nc], ['r', c.r, c.nr]] as const) {
      const min = Math.max(2, n * 0.03);
      for (const [k, cnt] of m) if (cnt >= min) pats.set(k, mergeFlags(pats.get(k), flag));
    }
    if (pats.size) result.push({ id: short, mode, patterns: dropSubPatterns(pats) });
  }
  return result;
}

// ---------------------------------------------------------------- S-Bahn über EFA

const S_HUBS = [
  'Wien Floridsdorf', 'Wien Meidling', 'Wien Praterstern', 'Wien Hauptbahnhof', 'Wien Hütteldorf',
  'Wien Handelskai', 'Wien Heiligenstadt', 'Wien Westbahnhof', 'Wien Franz-Josefs-Bahnhof', 'Wien Simmering',
  'Wien Stadlau', 'Wien Liesing', 'Wien Rennweg', 'Wien Ottakring', 'Wien Leopoldau', 'Wien Süßenbrunn',
  'Wien Strebersdorf', 'Wien Speising', 'Wien Aspern Nord', 'Wien Hadersdorf', 'Wien Penzing',
  'Wien Krottenbachstraße', 'Wien Kaiserebersdorf', 'Wien Erzherzog-Karl-Straße', 'Wien Grillgasse',
];

async function sBahnLines(nodes: Map<string, Node>, when: number, flag: 'c' | 'r') {
  const dests = new Map<string, Set<string>>(); // line -> EFA-IDs von Zielen + Hubs
  for (const name of S_HUBS) {
    const hub = await efa.findStop(name);
    if (!hub) continue;
    for (const sl of await efa.servingLines(hub.id, when)) {
      if (sl.mode !== 'S' || !/^S\d+$/.test(sl.line)) continue;
      const set = dests.get(sl.line) ?? new Set<string>();
      set.add(sl.destId);
      set.add(hub.id);
      dests.set(sl.line, set);
    }
  }

  const result = new Map<string, FlaggedPatterns>();
  for (const [line, set] of dests) {
    const ids = [...set];
    const pats: FlaggedPatterns = new Map();
    const jobs: Promise<void>[] = [];
    for (const a of ids)
      for (const b of ids) {
        if (a === b) continue;
        jobs.push(
          efa
            .trip({ from: a, to: b, time: when, mots: [1], maxChanges: 0, count: 3 })
            .then((trips) => {
              const leg = trips.flatMap((t) => t.legs).find((l) => l.mode === 'S' && l.line === line);
              if (!leg) return;
              const seq: string[] = [];
              for (const s of leg.stops) {
                if (s.place !== 'Wien' || !s.id) continue;
                if (!nodes.has(s.id)) nodes.set(s.id, { efaId: s.id, name: s.name, lat: s.lat, lon: s.lon });
                if (seq[seq.length - 1] !== s.id) seq.push(s.id);
              }
              if (seq.length >= 2) pats.set(seq.join(','), flag);
            })
            .catch((e) => console.warn(`  ${line} ${a}->${b}: ${e.message}`)),
        );
      }
    await Promise.all(jobs);
    if (pats.size) result.set(line, pats);
  }
  console.log(`S-Bahn (${flag === 'c' ? 'aktuell' : 'regulär'}): ${[...result.keys()].sort().join(' ')}`);
  return result;
}

// ---------------------------------------------------------------- Stationen gruppieren

function groupStations(nodes: Map<string, Node>, used: Set<string>) {
  const byName = new Map<string, Node[]>();
  for (const n of nodes.values()) {
    if (!used.has(n.efaId)) continue;
    const k = normName(n.name);
    byName.set(k, [...(byName.get(k) ?? []), n]);
  }
  const groups: Node[][] = [];
  for (const members of byName.values()) {
    // gleichnamige Haltestellen, die nah beieinander liegen, zusammenfassen
    const clusters: Node[][] = [];
    for (const n of members) {
      const c = clusters.find((cl) => cl.some((m) => distM(m, n) < 700));
      if (c) c.push(n);
      else clusters.push([n]);
    }
    groups.push(...clusters);
  }
  return groups;
}

function shortestName(names: string[]): string {
  return names.map((n) => n.replace(/\s*\((S-Bahn-Station|Bahnhof)\)/, '').replace(/\s+(S\s*U|U\s*S|S|U)$/, '')).sort((a, b) => a.length - b.length)[0];
}

// ---------------------------------------------------------------- Bezirke (Stadt Wien Open Data)

const DISTRICTS_URL =
  'https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien:BEZIRKSGRENZEOGD&srsName=EPSG:4326&outputFormat=json';
const DISTRICTS_FILE = path.join(ROOT, 'data/raw/bezirke.json');

/** Douglas-Peucker für geschlossene Ringe: am weitesten entfernten Punkt teilen (Anfang = Ende) */
function simplifyRing(pts: LatLon[], tol = 0.0003): LatLon[] {
  if (pts.length < 4) return pts;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > farD) (farD = d), (far = i);
  }
  const a = simplifyLine(pts.slice(0, far + 1), tol);
  const b = simplifyLine(pts.slice(far), tol);
  return [...a, ...b.slice(1)];
}

/** Douglas-Peucker in Grad (≈ 0.0003° ≈ 25–30 m) */
function simplifyLine(pts: LatLon[], tol: number): LatLon[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > maxD) (maxD = d), (idx = i);
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]).map(([la, lo]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5] as LatLon);
}

function pointInRing(lat: number, lon: number, ring: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function loadDistricts(): Promise<District[]> {
  if (!existsSync(DISTRICTS_FILE) || process.argv.includes('--refresh')) {
    console.log('Lade Bezirksgrenzen …');
    const res = await fetch(DISTRICTS_URL);
    if (!res.ok) throw new Error(`Bezirke: HTTP ${res.status}`);
    await writeFile(DISTRICTS_FILE, await res.text());
  }
  const geo = JSON.parse(await readFile(DISTRICTS_FILE, 'utf8'));
  const out: District[] = [];
  for (const f of geo.features) {
    const polys: number[][][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const rings = polys.map((poly) => simplifyRing(poly[0].map(([lon, lat]) => [lat, lon] as LatLon)));
    out.push({ id: Number(f.properties.BEZNR), name: String(f.properties.NAMEK), rings });
  }
  return out.sort((a, b) => a.id - b.id);
}

function districtOf(lat: number, lon: number, districts: District[]): number {
  for (const d of districts) if (d.rings.some((r) => pointInRing(lat, lon, r))) return d.id;
  // knapp außerhalb (Vereinfachung/Grenzlage): nächster Bezirk über die Randpunkte
  let best = 0;
  let bestD = Infinity;
  for (const d of districts)
    for (const r of d.rings)
      for (const [la, lo] of r) {
        const dd = (la - lat) ** 2 + (lo - lon) ** 2;
        if (dd < bestD) (bestD = dd), (best = d.id);
      }
  return best;
}

// ---------------------------------------------------------------- main

async function main() {
  await ensureGtfs();
  const districts = await loadDistricts();
  const gtfs = await loadGtfs();
  const regularDays = await pickRegularDays(gtfs);

  const currentDates: Date[] = [];
  for (let i = 1; i <= 28; i++) currentDates.push(new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) + i * DAY));
  const regularDates = Object.values(regularDays).map((r) => new Date(`${r.date}T00:00:00Z`));

  const nodes = new Map<string, Node>();
  const rawLines = await gtfsLines(gtfs, nodes, currentDates, regularDates);
  const sCur = await sBahnLines(nodes, noon(nextTypicalDay('wd')), 'c');
  const sReg = await sBahnLines(nodes, noon(new Date(`${regularDays.wd.date}T00:00:00Z`)), 'r');
  for (const line of new Set([...sCur.keys(), ...sReg.keys()])) {
    const pats: FlaggedPatterns = new Map();
    for (const src of [sCur.get(line), sReg.get(line)]) for (const [k, f] of src ?? []) pats.set(k, mergeFlags(pats.get(k), f));
    rawLines.push({ id: line, mode: 'S', patterns: dropSubPatterns(pats) });
  }

  const used = new Set(rawLines.flatMap((l) => [...l.patterns.keys()].flatMap((k) => k.split(','))));
  const groups = groupStations(nodes, used);
  const stationOf = new Map<string, string>();
  const stations: Station[] = groups.map((g, i) => {
    const id = `s${i}`;
    for (const n of g) stationOf.set(n.efaId, id);
    return {
      id,
      name: shortestName(g.map((n) => n.name)),
      lat: Math.round((g.reduce((s, n) => s + n.lat, 0) / g.length) * 1e6) / 1e6,
      lon: Math.round((g.reduce((s, n) => s + n.lon, 0) / g.length) * 1e6) / 1e6,
      modes: [],
      lines: [],
      district: 0,
    };
  });
  const stationById = new Map(stations.map((s) => [s.id, s]));

  const lineCountAtStop = new Map<string, number>();
  const lines: Line[] = [];
  for (const l of rawLines) {
    const pats: FlaggedPatterns = new Map();
    for (const [k, f] of l.patterns) {
      const seq: string[] = [];
      for (const efaId of k.split(',')) {
        lineCountAtStop.set(efaId, (lineCountAtStop.get(efaId) ?? 0) + 1);
        const sid = stationOf.get(efaId)!;
        if (seq[seq.length - 1] !== sid) seq.push(sid);
      }
      if (seq.length >= 2) pats.set(seq.join(','), mergeFlags(pats.get(seq.join(',')), f));
    }
    const final = dropSubPatterns(pats);
    if (!final.size) continue;
    lines.push({
      id: l.id,
      mode: l.mode,
      color: lineColor(l.mode, l.id),
      patterns: [...final.keys()].map((k) => k.split(',')),
      nets: [...final.values()],
    });
    for (const sid of new Set([...final.keys()].flatMap((k) => k.split(',')))) {
      const st = stationById.get(sid)!;
      if (!st.lines.includes(l.id)) st.lines.push(l.id);
      if (!st.modes.includes(l.mode)) st.modes.push(l.mode);
    }
  }

  const modeOrder: Mode[] = ['U', 'S', 'T', 'B', 'N'];
  const lineSort = (a: Line, b: Line) =>
    modeOrder.indexOf(a.mode) - modeOrder.indexOf(b.mode) || a.id.localeCompare(b.id, 'de', { numeric: true });
  lines.sort(lineSort);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  for (const s of stations) {
    s.lines.sort((a, b) => lineSort(lineById.get(a)!, lineById.get(b)!));
    s.modes.sort((a, b) => modeOrder.indexOf(a) - modeOrder.indexOf(b));
  }

  const efaIds: Record<string, string[]> = {};
  for (const [efaId, sid] of stationOf) (efaIds[sid] ??= []).push(efaId);
  for (const ids of Object.values(efaIds)) ids.sort((a, b) => (lineCountAtStop.get(b) ?? 0) - (lineCountAtStop.get(a) ?? 0));

  for (const st of stations) st.district = districtOf(st.lat, st.lon, districts);
  const perDistrict = districts.map((d) => `${d.id}:${stations.filter((s) => s.district === d.id).length}`).join(' ');
  console.log(`Stationen je Bezirk: ${perDistrict}`);

  const data: NetworkData = { generatedAt: new Date().toISOString(), regularDays, stations, lines, districts, efaIds };
  await writeFile(OUT, JSON.stringify(data));
  const byMode = modeOrder.map((m) => `${m}:${lines.filter((l) => l.mode === m).length}`).join(' ');
  console.log(`Fertig: ${stations.length} Stationen, ${lines.length} Linien (${byMode}), ${efa.requestCount} API-Requests -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
