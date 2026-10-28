// Client für die offizielle Wiener-Linien-Routing-API (EFA, ogd_routing).
// Doku: https://www.wienerlinien.at/open-data
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './paths.ts';
import type { LatLon, Mode } from '../shared/types.ts';

const BASE = 'https://www.wienerlinien.at/ogd_routing';
const CACHE_DIR = path.join(STATE_DIR, 'cache');
const CACHE_TTL_MS = 3 * 24 * 3600 * 1000;
/** gleichzeitige Abfragen an die Auskunft – 6 hält einen Spielstart unter ~5 s, ohne die API zu überlasten */
const MAX_PARALLEL = 6;

// ---------------------------------------------------------------- Zeit
// Zeiten sind "naive" Wiener Lokalzeit in Minuten seit 1970 (ohne Zeitzone),
// damit Rechnen über Mitternacht einfach bleibt.

export function naiveMinutes(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi) / 60000;
}

export function fmtTime(min: number): string {
  const d = new Date(min * 60000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function efaDateParams(min: number): { itdDate: string; itdTime: string } {
  const d = new Date(min * 60000);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    itdDate: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    itdTime: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`,
  };
}

function parseEfaDateTime(dt: { date: string; time: string } | undefined): number | null {
  if (!dt?.date || !dt.time) return null;
  const [d, mo, y] = dt.date.split('.').map(Number);
  const [h, mi] = dt.time.split(':').map(Number);
  return naiveMinutes(y, mo, d, h, mi);
}

// ---------------------------------------------------------------- Verkehrsmittel

/** EFA "motType"/"code" -> unser Mode */
export function modeFromMot(mot: number, line: string | null): Mode {
  if (mot === 1) return 'S';
  if (mot === 2) return 'U';
  if (mot === 3 || mot === 4) return 'T';
  if (mot === 5 || mot === 6 || mot === 7 || mot === 10) return line?.startsWith('N') ? 'N' : 'B';
  if (mot === 0) return 'S';
  return 'W';
}

/** Welche EFA-Verkehrsmittel für welche Modes erlaubt werden */
export function motsForModes(modes: Mode[]): number[] {
  const mots = new Set<number>();
  for (const m of modes) {
    if (m === 'S') mots.add(1);
    if (m === 'U') mots.add(2);
    if (m === 'T') (mots.add(3), mots.add(4));
    if (m === 'B' || m === 'N') mots.add(5);
  }
  return [...mots];
}

/** Standard fürs Spiel: S-Bahn, U-Bahn, Bim/Lokalbahn, Stadtbus (keine Regionalzüge/-busse) */
export const GAME_MOTS = [1, 2, 3, 4, 5];

function exclusionParams(allowed: number[]): Record<string, string> {
  const p: Record<string, string> = { excludedMeans: 'checkbox' };
  for (let i = 0; i <= 19; i++) if (!allowed.includes(i)) p[`exclMOT_${i}`] = '1';
  return p;
}

// ---------------------------------------------------------------- HTTP + Cache

let running = 0;
const queue: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

/**
 * Antworten im Speicher (zuletzt benutzte zuerst behalten). Eine Antwort ist ~100 KB groß – 1500 Einträge ≈ 160 MB,
 * passt in den Container (mem_limit 768m). Vorher unbegrenzt bis 5000 ≈ 500 MB (Befund H-04).
 * Einstellbar über EFA_MEM_CACHE (Anzahl Antworten), z.B. kleiner bei wenig RAM.
 */
const MEM_MAX = Math.max(50, Number(process.env.EFA_MEM_CACHE) || 1500);
const memCache = new Map<string, Promise<any>>();
export const memCacheSize = () => memCache.size;
export let requestCount = 0;

/** abgelaufene Dateien im Auskunfts-Cache löschen (wächst sonst unbegrenzt, Befund M-05); liefert die Anzahl */
export async function cleanDiskCache(now = Date.now()): Promise<number> {
  let removed = 0;
  let files: string[];
  try {
    files = await readdir(CACHE_DIR);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(CACHE_DIR, f);
    try {
      if (now - (await stat(file)).mtimeMs > CACHE_TTL_MS) {
        await unlink(file);
        removed++;
      }
    } catch {
      /* gleichzeitig gelöscht o.ä. */
    }
  }
  return removed;
}

/** Fehlertext inkl. Ursache (fetch packt den eigentlichen Grund in .cause, z.B. ENOTFOUND, ECONNRESET) */
function errText(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return [err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(' – ');
}

/** Dieselbe Warnung höchstens alle 10 min ins Log schreiben */
const warned = new Map<string, number>();
function warnOnce(key: string, msg: string) {
  const now = Date.now();
  if ((warned.get(key) ?? 0) > now - 10 * 60 * 1000) return;
  warned.set(key, now);
  console.warn(`[${new Date().toISOString()}] ${msg}`);
}

async function efaGet(endpoint: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({
    outputFormat: 'JSON',
    coordOutputFormat: 'WGS84[dd.ddddd]',
    ...params,
  });
  const url = `${BASE}/${endpoint}?${qs}`;
  const hit = memCache.get(url);
  if (hit) {
    // als zuletzt benutzt ans Ende
    memCache.delete(url);
    memCache.set(url, hit);
    return hit;
  }

  const p = (async () => {
    const hash = createHash('sha1').update(url).digest('hex');
    const file = path.join(CACHE_DIR, `${hash}.json`);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (Date.now() - raw.t < CACHE_TTL_MS) return raw.data;
    } catch {
      /* kein Cache */
    }
    const data = await withSlot(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          requestCount++;
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error(`EFA ${endpoint}: HTTP ${res.status}`);
          return await res.json();
        } catch (e) {
          if (attempt >= 2) {
            warnOnce('fetch', `Wiener-Linien-Auskunft nicht erreichbar: ${errText(e)}`);
            throw e;
          }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    });
    // Cache ist nur eine Beschleunigung – ein Schreibfehler (z.B. fehlende Rechte am Volume) darf die Abfrage nicht kaputt machen
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify({ t: Date.now(), url, data }));
    } catch (e) {
      warnOnce('cache', `Cache ${CACHE_DIR} nicht beschreibbar (${errText(e)}) – läuft ohne Cache weiter`);
    }
    return data;
  })();
  memCache.set(url, p);
  p.catch(() => memCache.delete(url));
  while (memCache.size > MEM_MAX) memCache.delete(memCache.keys().next().value!);
  return p;
}

// ---------------------------------------------------------------- Parsing

export interface EfaPoint {
  id: string;
  name: string;
  place: string;
  lat: number;
  lon: number;
}

export interface EfaLeg {
  mode: Mode;
  line: string | null;
  from: EfaPoint;
  to: EfaPoint;
  dep: number;
  arr: number;
  path: LatLon[];
  stops: EfaPoint[];
}

export interface EfaTrip {
  legs: EfaLeg[];
  dep: number;
  arr: number;
}

export function cleanName(name: string): string {
  return name.replace(/^Wien,?\s+/, '').trim();
}

function parseCoords(s: string | undefined): LatLon | null {
  if (!s) return null;
  const [lon, lat] = s.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

function parsePoint(p: any): EfaPoint {
  const c = parseCoords(p.ref?.coords) ?? [0, 0];
  return {
    id: String(p.ref?.id ?? ''),
    name: cleanName(p.nameWO || p.name || ''),
    place: p.place ?? '',
    lat: c[0],
    lon: c[1],
  };
}

function parsePath(s: string | undefined): LatLon[] {
  if (!s) return [];
  const pts: LatLon[] = [];
  for (const pair of s.trim().split(/\s+/)) {
    const c = parseCoords(pair);
    if (c) pts.push(c);
  }
  return simplify(pts, 0.00012);
}

/** Radial-Distanz-Vereinfachung, hält Payload klein */
function simplify(pts: LatLon[], tol: number): LatLon[] {
  if (pts.length < 3) return pts;
  const out: LatLon[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.abs(pts[i][0] - l[0]) + Math.abs(pts[i][1] - l[1]) > tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
}

function parseLeg(l: any): EfaLeg | null {
  const [p0, p1] = l.points ?? [];
  if (!p0 || !p1) return null;
  const dep = parseEfaDateTime(p0.dateTime);
  const arr = parseEfaDateTime(p1.dateTime);
  if (dep == null || arr == null) return null;
  const mot = Number(l.mode?.code ?? -1);
  const line = l.mode?.number ? String(l.mode.number) : null;
  const mode = mot < 0 || mot >= 99 ? 'W' : modeFromMot(mot, line);
  const stops = Array.isArray(l.stopSeq) ? l.stopSeq.map(parsePoint) : [];
  return {
    mode,
    line: mode === 'W' ? null : line,
    from: parsePoint(p0),
    to: parsePoint(p1),
    dep,
    arr,
    path: parsePath(l.path),
    stops,
  };
}

function parseTrips(json: any): EfaTrip[] {
  const trips = Array.isArray(json?.trips) ? json.trips : json?.trips?.trip ? [json.trips.trip].flat() : [];
  const out: EfaTrip[] = [];
  for (const t of trips) {
    const legs = (t.legs ?? []).map(parseLeg).filter(Boolean) as EfaLeg[];
    if (!legs.length) continue;
    out.push({ legs, dep: legs[0].dep, arr: legs[legs.length - 1].arr });
  }
  return out;
}

// ---------------------------------------------------------------- Requests

export interface TripQuery {
  from: string; // EFA stop id
  to: string;
  time: number; // naive minutes
  mots?: number[];
  maxChanges?: number;
  count?: number;
  /** Zwischenhalt, über den die Fahrt führen muss (EFA stop id) – z.B. um eine bestimmte U-Bahn-Linie zu erzwingen */
  via?: string;
}

/** „coord:lon:lat“ (Adresse) oder EFA-Haltestellen-ID */
function place(id: string): { type: string; name: string } {
  if (id.startsWith('coord:')) {
    const [, lon, lat] = id.split(':');
    return { type: 'coord', name: `${lon}:${lat}:WGS84[dd.ddddd]` };
  }
  return { type: 'stopID', name: id };
}

export async function trip(q: TripQuery): Promise<EfaTrip[]> {
  const o = place(q.from);
  const d = place(q.to);
  const params: Record<string, string> = {
    type_origin: o.type,
    name_origin: o.name,
    type_destination: d.type,
    name_destination: d.name,
    itdTripDateTimeDepArr: 'dep',
    calcNumberOfTrips: String(q.count ?? 5),
    useRealtime: '0',
    ...efaDateParams(q.time),
    ...exclusionParams(q.mots ?? GAME_MOTS),
  };
  if (q.maxChanges != null) params.maxChanges = String(q.maxChanges);
  if (q.via) Object.assign(params, { type_via: 'stopID', name_via: q.via, dwellTime: '0' });
  return parseTrips(await efaGet('XML_TRIP_REQUEST2', params));
}

export interface ServingLine {
  line: string;
  mode: Mode;
  destination: string;
  destId: string;
}

export async function servingLines(stopId: string, time: number): Promise<ServingLine[]> {
  const json = await efaGet('XML_DM_REQUEST', {
    type_dm: 'stopID',
    name_dm: stopId,
    mode: 'direct',
    limit: '120',
    useRealtime: '0',
    ...efaDateParams(time),
  });
  const deps: any[] = Array.isArray(json?.departureList) ? json.departureList : [];
  const seen = new Map<string, ServingLine>();
  for (const d of deps) {
    const sl = d.servingLine;
    if (!sl) continue;
    const line = String(sl.number);
    const mode = modeFromMot(Number(sl.motType), line);
    const key = `${line}|${sl.destID}`;
    if (!seen.has(key)) seen.set(key, { line, mode, destination: cleanName(sl.direction ?? ''), destId: String(sl.destID) });
  }
  return [...seen.values()];
}

export async function findStop(name: string): Promise<EfaPoint | null> {
  const json = await efaGet('XML_STOPFINDER_REQUEST', { type_sf: 'stop', name_sf: name, anyObjFilter_sf: '2' });
  const p = json?.stopFinder?.points;
  const arr: any[] = Array.isArray(p) ? p : p?.point ? [p.point] : [];
  const best = arr[0];
  if (!best) return null;
  const c = parseCoords(best.ref?.coords) ?? [0, 0];
  return { id: String(best.ref?.id ?? best.stateless), name: cleanName(best.name), place: best.ref?.place ?? '', lat: c[0], lon: c[1] };
}
