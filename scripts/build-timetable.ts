// Eigener Referenzfahrplan aus den GTFS-Daten der Mobilitätsverbünde Österreich → data/timetable.json
//
//   node scripts/build-timetable.ts
//
// Quellen (nicht im Repo, Download von data.mobilitaetsverbuende.at, entpackt):
//   data/raw/timetables         – Verkehrsverbund Ost-Region (Wiener Linien, Badner Bahn, …)
//   data/raw/timetables-trains  – Bahn (ÖBB: S-Bahn, R, REX, CJX), Fahrplanjahr ab Fahrplanwechsel
//
// Ergebnis: nur die drei Referenztage aus data/network.json (plus die Nachtfahrten nach Mitternacht vom Vortag),
// nur Halte in und knapp um Wien, nur Linien, die das Spiel kennt (Wiener Linien, Badner Bahn, 49B …) und
// Nahverkehrszüge (S, R, REX, CJX – keine Railjets/IC/WESTbahn). server/timetable.ts sucht darauf Verbindungen;
// die Wiener-Linien-Auskunft braucht es dann nur noch für „Aktuell“.
//
// Regionalzüge (R/REX/CJX) fahren in Wien nur auf S-Bahn-Abschnitten mit – sie zählen dort als S-Bahn (kürzere
// Wartezeit), sind aber keine eigenen Linien im Netz. Linien mit Ergänzungen (S40, 18, 43, 46) bekommen in
// data/network.json ihre regulären Haltefolgen aus dem Fahrplan.
//
// Lizenz: „Datenquelle: Mobilitätsverbünde Österreich OG – data.mobilitaetsverbuende.at“, Daten verarbeitet
// (gefiltert, umgerechnet). Achtung Lizenz Abschnitt 6a/7d: nach Ende der Gültigkeit (Fahrplanjahr) nicht mehr
// in öffentlich zugänglichen Auskunftssystemen verwenden – ohne schriftliche Zustimmung jedes Jahr neu bauen.
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Mode, NetworkData } from '../shared/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NETWORK = path.join(ROOT, 'data/network.json');
const OUT = path.join(ROOT, 'data/timetable.json');
const SOURCES = [
  { dir: path.join(ROOT, 'data/raw/timetables'), kind: 'vor' as const },
  { dir: path.join(ROOT, 'data/raw/timetables-trains'), kind: 'rail' as const },
];
/** Wien plus etwas Rand (Umstiege knapp hinter der Stadtgrenze, z.B. Schwechat, Klosterneuburg-Kierling) */
const BBOX = { minLat: 48.105, maxLat: 48.335, minLon: 16.16, maxLon: 16.6 };
/** Nahverkehrszüge: S-Bahn, Regionalzug, Regionalexpress, Cityjet Xpress */
const RAIL_LINE = /^(S\d+|R\d+|REX\d+|CJX\d+)$/;
/** Bahn-Betreiber im Bahn-Datensatz: ÖBB, Raaberbahn */
const RAIL_AGENCIES = new Set(['01', '03']);

// ---------------------------------------------------------------- Ergänzungen zum „normalen“ Netz
// Der Referenztag (30.6.2026) hat bei einigen Linien Baustellen – geprüft gegen März, Mai, September, Oktober und
// November 2026.

/**
 * Diese Linien kommen von einem normalen Tag desselben Typs: 43 fuhr am 30.6. nur bis Dornbach (sonst Neuwaldegg),
 * 46 nur bis Josefstädter Straße (sonst Parlament/Volkstheater). 15./12./13.9.2026 sind bei beiden normal (an den
 * Oktober-Wochenenden fährt der 46 nach Hütteldorf).
 */
const NORMAL_DAYS: Record<string, string> = { wd: '20260915', sa: '20260912', su: '20260913' };
const FROM_NORMAL_DAY = new Set(['43', '46']);
/**
 * 18 bis Stadion: Strecke vom Referenztag (Burggasse – Gürtel – Hauptbahnhof – Schlachthausgasse), ab
 * Schlachthausgasse verlängert zum Stadion – Halte und Fahrzeiten der Verlängerung vom 15.9.2026 (ab September fährt
 * der 18 zum Stadion; sein Gürtel-Abschnitt ist dann allerdings Baustelle, deshalb nicht der ganze Tag).
 */
const EXTEND_18 = { line: '18', at: 'Schlachthausgasse', end: 'Stadion', sampleDay: '20260915' };
/**
 * S40 wieder ab Franz-Josefs-Bahnhof wie vor den Bauarbeiten (am Referenztag ab Heiligenstadt): Fahrzeiten aus dem
 * Fahrplan 2024 – Franz-Josefs-Bahnhof ab :07, Spittelau :09, Heiligenstadt :12.
 */
const S40_FJB: [string, number][] = [
  ['Franz-Josefs-Bahnhof', 0],
  ['Spittelau', 2],
  ['Heiligenstadt', 5],
];

// ---------------------------------------------------------------- CSV

function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') (cur += '"'), i++;
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') (out.push(cur), (cur = ''));
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachRow(file: string, fn: (row: Record<string, string>) => void) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let head: string[] | null = null;
  for await (const raw of rl) {
    if (!raw) continue;
    const cols = splitCsv(raw);
    if (!head) {
      head = cols.map((c) => c.replace(/^﻿/, '').trim());
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < head.length; i++) row[head[i]] = cols[i] ?? '';
    fn(row);
  }
}

// ---------------------------------------------------------------- Zeit

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const ymd = (d: string) => d.replace(/-/g, '');
function prevDay(d: string): string {
  const x = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10).replace(/-/g, '');
}
const WEEKDAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const weekday = (d: string) => WEEKDAY[new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00Z`).getUTCDay()];

// ---------------------------------------------------------------- Aufbau

interface Node {
  key: string;
  name: string;
  lat: number;
  lon: number;
  n: number;
}

/** „at:49:1040:0:3“ → „at:49:1040“ (Station statt Steig) */
const nodeKey = (stopId: string) => stopId.split(':').slice(0, 3).join(':');
const cleanName = (n: string) => n.replace(/^Wien,?\s+/, '').trim();
const inBox = (p: { lat: number; lon: number }) => p.lat >= BBOX.minLat && p.lat <= BBOX.maxLat && p.lon >= BBOX.minLon && p.lon <= BBOX.maxLon;

async function main() {
  const net = JSON.parse(readFileSync(NETWORK, 'utf8')) as NetworkData;
  const days = Object.fromEntries(Object.entries(net.regularDays).map(([k, v]) => [k, ymd(v.date)])) as Record<string, string>;
  const netLines = new Map(net.lines.map((l) => [l.id, l]));
  console.log('▶ Referenztage', days);

  const nodes = new Map<string, Node>();
  /** Linien: Name → [mode, mot] */
  const lines = new Map<string, { mode: Mode; mot: number }>();
  /** Fahrten je Tag: [Linie, Halte (Knoten-Keys), Zeiten (min)] */
  const out: Record<string, { line: string; stops: string[]; times: number[] }[]> = { wd: [], sa: [], su: [] };
  /** Ende der Gültigkeit (frühestes Ende der Datensätze) – danach laut Lizenz nicht mehr öffentlich verwenden */
  let validUntil = '99991231';
  /** Fahrten des 18 vom 15.9. – nur als Vorlage für die Verlängerung zum Stadion */
  const samples18: { stops: string[]; times: number[] }[] = [];

  for (const src of SOURCES) {
    if (!existsSync(src.dir)) throw new Error(`fehlt: ${src.dir} – GTFS von data.mobilitaetsverbuende.at herunterladen und entpacken`);
    console.log(`▶ ${src.kind}: ${src.dir}`);
    await eachRow(path.join(src.dir, 'feed_info.txt'), (r) => {
      if (r.feed_end_date && r.feed_end_date < validUntil) validUntil = r.feed_end_date;
    });
    for (const [k, d] of Object.entries(days)) if (d > validUntil) throw new Error(`Referenztag ${k}=${d} liegt nach dem Ende der Daten (${validUntil})`);
    // Halte → Knoten (Station)
    const stopNode = new Map<string, string>();
    await eachRow(path.join(src.dir, 'stops.txt'), (r) => {
      const lat = Number(r.stop_lat);
      const lon = Number(r.stop_lon);
      if (!Number.isFinite(lat)) return;
      const key = nodeKey(r.stop_id.startsWith('P') ? r.stop_id.slice(1) : r.stop_id);
      stopNode.set(r.stop_id, key);
      const n = nodes.get(key);
      if (n) {
        // Mittelpunkt aller Steige
        n.lat = (n.lat * n.n + lat) / (n.n + 1);
        n.lon = (n.lon * n.n + lon) / (n.n + 1);
        n.n++;
      } else nodes.set(key, { key, name: cleanName(r.stop_name), lat, lon, n: 1 });
    });

    // Linien
    const routeLine = new Map<string, string>();
    await eachRow(path.join(src.dir, 'routes.txt'), (r) => {
      const name = r.route_short_name.trim();
      if (src.kind === 'rail') {
        if (!RAIL_AGENCIES.has(r.agency_id) || !RAIL_LINE.test(name)) return;
        routeLine.set(r.route_id, name);
        lines.set(name, { mode: 'S', mot: 1 });
        return;
      }
      const known = netLines.get(name);
      if (!known || known.mode === 'S') return;
      const type = Number(r.route_type);
      const mode: Mode = type === 1 ? 'U' : type === 0 ? 'T' : name.startsWith('N') ? 'N' : 'B';
      if (mode !== known.mode) return;
      routeLine.set(r.route_id, name);
      lines.set(name, { mode, mot: mode === 'U' ? 2 : mode === 'T' ? 4 : 5 });
    });

    // Verkehrstage
    const cal = new Map<string, Record<string, string>>();
    await eachRow(path.join(src.dir, 'calendar.txt'), (r) => cal.set(r.service_id, r));
    const exc = new Map<string, Map<string, string>>();
    await eachRow(path.join(src.dir, 'calendar_dates.txt'), (r) => {
      const m = exc.get(r.service_id) ?? exc.set(r.service_id, new Map()).get(r.service_id)!;
      m.set(r.date, r.exception_type);
    });
    const runs = (sid: string, d: string) => {
      const e = exc.get(sid)?.get(d);
      if (e) return e === '1';
      const c = cal.get(sid);
      return !!c && c.start_date <= d && d <= c.end_date && c[weekday(d)] === '1';
    };

    // Fahrten: an welchen Referenztagen (und als Nachtfahrt vom Vortag)
    const tripInfo = new Map<string, { line: string; on: string[]; night: string[]; sample: boolean }>();
    await eachRow(path.join(src.dir, 'trips.txt'), (r) => {
      const line = routeLine.get(r.route_id);
      if (!line) return;
      const useDays = FROM_NORMAL_DAY.has(line) ? NORMAL_DAYS : days;
      const on = Object.entries(useDays).filter(([, d]) => runs(r.service_id, d)).map(([k]) => k);
      const night = Object.entries(useDays).filter(([, d]) => runs(r.service_id, prevDay(d))).map(([k]) => k);
      const sample = line === EXTEND_18.line && runs(r.service_id, EXTEND_18.sampleDay);
      if (on.length || night.length || sample) tripInfo.set(r.trip_id, { line, on, night, sample });
    });
    console.log(`  ${tripInfo.size} Fahrten an den Referenztagen`);

    // Haltezeiten
    const st = new Map<string, [number, string, number][]>();
    let rows = 0;
    await eachRow(path.join(src.dir, 'stop_times.txt'), (r) => {
      if (!tripInfo.has(r.trip_id)) return;
      const node = stopNode.get(r.stop_id);
      if (!node) return;
      const t = r.departure_time || r.arrival_time;
      if (!t) return;
      (st.get(r.trip_id) ?? st.set(r.trip_id, []).get(r.trip_id)!).push([Number(r.stop_sequence), node, toMin(t)]);
      if (++rows % 2_000_000 === 0) console.log(`  … ${rows} Haltezeiten`);
    });

    for (const [tid, list] of st) {
      const info = tripInfo.get(tid)!;
      list.sort((a, b) => a[0] - b[0]);
      // Abschnitte innerhalb der Box; derselbe Knoten hintereinander (Steigwechsel) nur einmal
      let seg: { stops: string[]; times: number[] } = { stops: [], times: [] };
      const segs: (typeof seg)[] = [];
      for (const [, node, t] of list) {
        if (!inBox(nodes.get(node)!)) {
          if (seg.stops.length > 1) segs.push(seg);
          seg = { stops: [], times: [] };
          continue;
        }
        if (seg.stops[seg.stops.length - 1] === node) {
          seg.times[seg.times.length - 1] = t;
          continue;
        }
        seg.stops.push(node);
        seg.times.push(t);
      }
      if (seg.stops.length > 1) segs.push(seg);
      if (info.sample) samples18.push(...segs.map((x) => ({ stops: [...x.stops], times: [...x.times] })));
      for (const s of segs) {
        for (const d of info.on) out[d].push({ line: info.line, stops: [...s.stops], times: [...s.times] });
        // nach Mitternacht vom Vortag (z.B. Samstag 2 Uhr = Freitagnacht): Zeiten um 24 h verschieben
        if (s.times[s.times.length - 1] >= 1440)
          for (const d of info.night) out[d].push({ line: info.line, stops: s.stops, times: s.times.map((x) => x - 1440) });
      }
    }
  }

  extend18(out, samples18, nodes);
  s40FromFjb(out, nodes);

  // ---------------------------------------------------------------- kompakt schreiben
  const usedNodes = new Set<string>();
  for (const d of Object.values(out)) for (const t of d) for (const s of t.stops) usedNodes.add(s);
  const nodeList = [...usedNodes].sort();
  const nodeIdx = new Map(nodeList.map((k, i) => [k, i]));
  const lineList = [...lines.keys()].sort();
  const lineIdx = new Map(lineList.map((k, i) => [k, i]));
  const patterns = new Map<string, number>();
  const patternList: [number, number[]][] = [];
  const trips: Record<string, number[][]> = {};
  for (const [day, list] of Object.entries(out)) {
    trips[day] = list
      .map((t) => {
        const stops = t.stops.map((s) => nodeIdx.get(s)!);
        const pk = `${t.line}|${stops.join(',')}`;
        let p = patterns.get(pk);
        if (p == null) {
          p = patternList.length;
          patterns.set(pk, p);
          patternList.push([lineIdx.get(t.line)!, stops]);
        }
        // [Muster, erste Zeit, Abstände …]
        return [p, t.times[0], ...t.times.slice(1).map((x, i) => x - t.times[i])];
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  const data = {
    source: 'Datenquelle: Mobilitätsverbünde Österreich OG – data.mobilitaetsverbuende.at (verarbeitet)',
    generatedAt: new Date().toISOString(),
    validUntil: `${validUntil.slice(0, 4)}-${validUntil.slice(4, 6)}-${validUntil.slice(6, 8)}`,
    days: Object.fromEntries(Object.entries(net.regularDays).map(([k, v]) => [k, v.date])),
    nodes: nodeList.map((k) => {
      const n = nodes.get(k)!;
      return [k, n.name, Math.round(n.lat * 1e5) / 1e5, Math.round(n.lon * 1e5) / 1e5];
    }),
    lines: lineList.map((l) => [l, lines.get(l)!.mode, lines.get(l)!.mot]),
    patterns: patternList,
    trips,
  };
  writeFileSync(OUT, JSON.stringify(data));
  console.log(
    `✔ data/timetable.json: ${nodeList.length} Halte, ${lineList.length} Linien, ${patternList.length} Muster, Fahrten ${Object.entries(trips)
      .map(([d, t]) => `${d}=${t.length}`)
      .join(' ')}`,
  );

  syncNetwork(net, data);
}

type Trips = Record<string, { line: string; stops: string[]; times: number[] }[]>;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** 18: Fahrten, die an der Schlachthausgasse enden/beginnen, bis zum Stadion verlängern (Vorlage vom 15.9.) */
function extend18(out: Trips, samples: { stops: string[]; times: number[] }[], nodes: Map<string, Node>) {
  const name = (k: string) => nodes.get(k)!.name;
  // häufigste Halte-Folge nach bzw. vor der Schlachthausgasse, je Halt der Median der Fahrzeit
  const template = (dir: 'out' | 'in') => {
    const found = new Map<string, number[][]>();
    for (const s of samples) {
      const i = s.stops.findIndex((k) => name(k) === EXTEND_18.at);
      if (i < 0) continue;
      const part = dir === 'out' ? s.stops.slice(i + 1) : s.stops.slice(0, i);
      if (!part.length || !part.some((k) => name(k) === EXTEND_18.end)) continue;
      const offs = dir === 'out' ? s.times.slice(i + 1).map((t) => t - s.times[i]) : s.times.slice(0, i).map((t) => s.times[i] - t);
      const key = part.join('|');
      (found.get(key) ?? found.set(key, []).get(key)!).push(offs);
    }
    const best = [...found.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (!best) throw new Error('18: keine Vorlage für die Verlängerung zum Stadion gefunden');
    const stops = best[0].split('|');
    return { stops, offs: stops.map((_, j) => median(best[1].map((o) => o[j]))) };
  };
  const outT = template('out');
  const inT = template('in');
  let n = 0;
  for (const list of Object.values(out))
    for (const t of list) {
      if (t.line !== EXTEND_18.line || t.stops.some((k) => name(k) === EXTEND_18.end)) continue;
      if (name(t.stops[t.stops.length - 1]) === EXTEND_18.at) {
        const end = t.times[t.times.length - 1];
        t.stops.push(...outT.stops);
        t.times.push(...outT.offs.map((o) => end + o));
        n++;
      } else if (name(t.stops[0]) === EXTEND_18.at) {
        const start = t.times[0];
        t.stops.unshift(...inT.stops);
        t.times.unshift(...inT.offs.map((o) => start - o));
        n++;
      }
    }
  console.log(`  18 bis ${EXTEND_18.end}: ${n} Fahrten verlängert (${outT.stops.map(name).join(' → ')}, +${outT.offs.at(-1)} min; zurück ${inT.stops.map(name).join(' → ')})`);
}

/** S40: Fahrten ab/bis Heiligenstadt wieder ab/bis Franz-Josefs-Bahnhof (über Spittelau) */
function s40FromFjb(out: Trips, nodes: Map<string, Node>) {
  // Knoten der Bahnhöfe so, wie sie die REX4 benutzt (gleiche Gleise)
  const keyOf = new Map<string, string>();
  for (const list of Object.values(out)) for (const t of list) if (t.line === 'REX4') for (const k of t.stops) keyOf.set(nodes.get(k)!.name, k);
  const keys = S40_FJB.map(([n]) => keyOf.get(n));
  if (keys.some((k) => !k)) throw new Error(`S40: Bahnhöfe nicht gefunden (${S40_FJB.map(([n]) => n).join(', ')})`);
  const [fjb, spittelau, heili] = keys as string[];
  const toSpittelau = S40_FJB[1][1];
  const toHeili = S40_FJB[2][1];
  let n = 0;
  for (const list of Object.values(out))
    for (const t of list) {
      if (t.line !== 'S40' || t.stops.includes(fjb)) continue;
      if (t.stops[0] === heili) {
        // stadtauswärts: FJB → Spittelau → Heiligenstadt → …
        const at = t.times[0];
        t.stops.unshift(fjb, spittelau);
        t.times.unshift(at - toHeili, at - toHeili + toSpittelau);
        n++;
      } else if (t.stops[t.stops.length - 1] === heili) {
        // stadteinwärts: … → Heiligenstadt → Spittelau → FJB
        const at = t.times[t.times.length - 1];
        t.stops.push(spittelau, fjb);
        t.times.push(at + (toHeili - toSpittelau), at + toHeili);
        n++;
      }
    }
  console.log(`  S40 ab Franz-Josefs-Bahnhof: ${n} Fahrten verlängert`);
}

/** Netz an den Fahrplan anpassen: Linien mit Ergänzungen (S40, 18, 43, 46) bekommen ihre regulären Haltefolgen */
function syncNetwork(net: NetworkData, data: { nodes: (string | number)[][]; lines: (string | number)[][]; patterns: [number, number[]][] }) {
  const efaToStation = new Map<string, string>();
  for (const [sid, ids] of Object.entries(net.efaIds)) for (const id of ids) efaToStation.set(id, sid);
  const stationOf = (key: string) => {
    const m = /^at:49:(\d+)$/.exec(key);
    return m ? (efaToStation.get(String(60200000 + Number(m[1]))) ?? null) : null;
  };
  /** Haltefolgen einer Linie aus dem Fahrplan als Station-IDs (ohne Teilstücke längerer Folgen) */
  const patternsOf = (li: number): string[][] => {
    const pats = new Set<string>();
    for (const [l, stops] of data.patterns) {
      if (l !== li) continue;
      const ids = stops.map((i) => stationOf(String(data.nodes[i][0]))).filter((x): x is string => !!x);
      const dedup = ids.filter((x, i) => x !== ids[i - 1]);
      if (dedup.length >= 2) pats.add(dedup.join(','));
    }
    const all = [...pats].map((p) => p.split(','));
    return all.filter((p) => !all.some((q) => q !== p && q.length > p.length && q.join(',').includes(p.join(','))));
  };
  // Regionalzüge sind keine eigenen Linien im Netz: in Wien fahren sie nur auf S-Bahn-Abschnitten mit und zählen dort
  // als S-Bahn (eine seltene R1 hätte im Routen-Baukasten sonst den Takt aller S-Bahnen). Früher eingetragene entfernen.
  net.lines = net.lines.filter((l) => !/^(R|REX|CJX)\d+$/.test(l.id));
  for (const s of net.stations) s.lines = s.lines.filter((l) => !/^(R|REX|CJX)\d+$/.test(l));
  // Linien mit Ergänzungen: reguläre Haltefolgen aus dem Fahrplan (aktuelle Haltefolgen der Auskunft bleiben)
  for (const name of ['S40', '18', ...FROM_NORMAL_DAY]) {
    const line = net.lines.find((l) => l.id === name);
    const li = data.lines.findIndex(([n]) => n === name);
    if (!line || li < 0) continue;
    const fresh = patternsOf(li);
    const patterns: string[][] = [];
    const nets: string[] = [];
    line.patterns.forEach((p, i) => {
      const c = line.nets[i].replace('r', '');
      if (c) (patterns.push(p), nets.push(c));
    });
    for (const p of fresh) {
      const i = patterns.findIndex((q) => q.join(',') === p.join(','));
      if (i >= 0) nets[i] = `${nets[i]}r`;
      else (patterns.push(p), nets.push('r'));
    }
    line.patterns = patterns;
    line.nets = nets;
    for (const id of new Set(fresh.flat())) {
      const st = net.stations.find((s) => s.id === id)!;
      if (!st.lines.includes(name)) st.lines.push(name);
    }
    console.log(`  ${name}: ${fresh.length} reguläre Haltefolgen, z.B. ${fresh[0].map((id) => net.stations.find((s) => s.id === id)!.name).join(' → ')}`);
  }
  writeFileSync(NETWORK, JSON.stringify(net));
  console.log('✔ data/network.json: reguläre Haltefolgen aktualisiert');
}

await main();
