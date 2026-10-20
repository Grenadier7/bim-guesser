// Lernmodus – Daten: meine Linien (⭐), Lern-Umfang, Linien-Steckbriefe, Lernstand
import type { LatLon, Line, Mode, Station } from '../../../shared/types.ts';
import { shuffle } from '../../../shared/random.ts';
import { isSpecialLine, regularPatterns } from '../../../shared/rules.ts';
import { distM } from '../../../shared/geo.ts';
import { app } from '../store.ts';
import { loadJson, saveJson } from '../storage.ts';

// ---------------------------------------------------------------- Speicher

const PROGRESS_KEY = 'oeffi-learn-progress-v1';
const MY_LINES_KEY = 'oeffi-my-lines-v1';


// ---------------------------------------------------------------- Meine Linien (⭐)

/** gemerkte Linien – das ist der Stoff für „Üben“ */
let mine: string[] = loadJson<string[]>(MY_LINES_KEY, []);
export const myLines = (): string[] => mine.filter((id) => app.net.lines.has(id));
export const isMine = (id: string) => mine.includes(id);
export function setMine(id: string, on: boolean) {
  mine = on ? [...new Set([...mine, id])] : mine.filter((x) => x !== id);
  saveJson(MY_LINES_KEY, mine);
}
/** kleiner ☆-Knopf zum Merken – überall einsetzbar, ein Klick-Handler in main.ts erledigt den Rest */
export const starMini = (id: string) =>
  app.net.lines.has(id)
    ? `<button class="star-mini ${isMine(id) ? 'on' : ''}" data-star-line="${id}" title="Linie für „Lernen → Üben“ merken">${isMine(id) ? '⭐' : '☆'}</button>`
    : '';
export function addMine(ids: string[]) {
  mine = [...new Set([...mine, ...ids])];
  saveJson(MY_LINES_KEY, mine);
}

/**
 * Lernstand: Schlüssel → Stufe 0–3.
 *  "line:<id>"        – Linie für Linie (Selbsteinschätzung)
 */
const progress: Record<string, number> = loadJson<Record<string, number>>(PROGRESS_KEY, {});
export const MASTERED = 3;
export const boxOf = (key: string) => progress[key] ?? 0;
export function setBox(key: string, box: number) {
  progress[key] = Math.max(0, Math.min(MASTERED, box));
  saveJson(PROGRESS_KEY, progress);
}
// ---------------------------------------------------------------- Hilfen

/** Haltefolgen im regulären Netz (Lernmodus und Kurse zeigen immer das reguläre Netz) */
export const patternsOf = regularPatterns;
export { isSpecialLine, shuffle };

// ---------------------------------------------------------------- Lern-Umfang

export interface Scope {
  label: string;
  stations: Station[];
  stationSet: Set<string>;
  lines: Line[];
  area: { rings?: LatLon[][]; circle?: { lat: number; lon: number; radiusM: number } } | null;
  /** Verkehrsmittel, die zählen */
  modes: Set<Mode>;
}

const MODE_ORDER: Mode[] = ['U', 'S', 'T', 'B', 'N'];

/** Lern-Umfang aus einer Linienliste (z.B. meine Linien) */
export function scopeOfLines(ids: string[], label: string): Scope {
  const net = app.net;
  const lines = ids
    .map((id) => net.lines.get(id))
    .filter((l): l is Line => !!l && patternsOf(l).length > 0)
    .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode) || a.id.localeCompare(b.id, 'de', { numeric: true }));
  const stationSet = new Set(lines.flatMap((l) => patternsOf(l).flat()));
  return { label, stations: [...stationSet].map((id) => net.station(id)), stationSet, lines, area: null, modes: new Set(MODE_ORDER) };
}

/** alle Verkehrsmittel außer Nachtbus – für „Von hier fährst du mit …“ */
export const DAY_SCOPE = (): Scope => ({ label: '', stations: [], stationSet: new Set(), lines: [], area: null, modes: new Set<Mode>(['U', 'S', 'T', 'B']) });


/** Linien an einer Station, die im Bereich zählen (ohne Sonderlinien) */
export function linesAt(st: Station, scope: Scope): Line[] {
  return st.lines
    .map((id) => app.net.lines.get(id)!)
    .filter((l) => l && scope.modes.has(l.mode) && !isSpecialLine(l) && patternsOf(l).some((p) => p.includes(st.id)));
}

let servedCache: Set<string> | null = null;
/** Stationen, an denen im regulären Netz tagsüber etwas fährt (ohne Sonderführungen aus dem aktuellen Fahrplan) */
export function servedStations(): Set<string> {
  servedCache ??= new Set(app.net.data.lines.filter((l) => l.mode !== 'N' && !isSpecialLine(l)).flatMap((l) => patternsOf(l).flat()));
  return servedCache;
}

// ---------------------------------------------------------------- Linien-Steckbrief

/** Wie wichtig ist eine Station als Orientierungspunkt (Umstieg zu U/S, viele Linien)? */
function importance(st: Station, self: Line): number {
  let score = 0;
  for (const id of st.lines) {
    if (id === self.id) continue;
    const l = app.net.lines.get(id);
    if (!l) continue;
    // U-/S-Bahn-Umstiege sind die besten Orientierungspunkte
    score += l.mode === 'U' ? 10 : l.mode === 'S' ? 6 : l.mode === 'T' ? 1.5 : l.mode === 'B' ? 0.5 : 0;
  }
  return score;
}

export interface LineProfile {
  line: Line;
  /** längste Haltefolge */
  main: string[];
  /** Endstationen + 2–4 markante Punkte dazwischen, in Fahrtrichtung */
  waypoints: string[];
  sentence: string;
  districts: { id: number; name: string }[];
  /** Umstiege zu U-Bahn/S-Bahn (je Station einmal) */
  transfers: { station: Station; lines: Line[] }[];
  /** Bims, die man unterwegs irgendwo trifft (ohne die Linie selbst) */
  trams: Line[];
  /** je Station der Hauptstrecke die Umstiege zu Bim und Bus */
  local: Map<string, { trams: Line[]; buses: Line[] }>;
  stopCount: number;
}

const profileCache = new Map<string, LineProfile>();

export function lineProfile(line: Line): LineProfile {
  const hit = profileCache.get(line.id);
  if (hit) return hit;
  const net = app.net;
  const pats = patternsOf(line);
  const main = [...pats].sort((a, b) => b.length - a.length)[0];
  const n = main.length;
  const maxPicks = n <= 6 ? 1 : n <= 12 ? 2 : n <= 20 ? 3 : 4;
  const minGap = Math.max(2, Math.floor(n / (maxPicks + 2)));
  const ranked = main
    .slice(1, -1)
    .map((id, i) => ({ id, i: i + 1, score: importance(net.station(id), line) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked: { id: string; i: number }[] = [];
  for (const c of ranked) {
    if (picked.length >= maxPicks) break;
    if (c.i < minGap / 2 || n - 1 - c.i < minGap / 2) continue;
    if (picked.some((p) => Math.abs(p.i - c.i) < minGap)) continue;
    picked.push(c);
  }
  picked.sort((a, b) => a.i - b.i);
  const waypoints = [main[0], ...picked.map((p) => p.id), main[n - 1]];
  const name = (id: string) => net.station(id).name;
  const via = picked.map((p) => name(p.id));
  const viaText = via.length > 1 ? `${via.slice(0, -1).join(', ')} und ${via[via.length - 1]}` : via[0];
  const sentence = `${line.mode === 'U' || line.mode === 'S' ? `Die ${line.id}` : `Die Linie ${line.id}`} fährt von ${name(main[0])}${via.length ? ` über ${viaText}` : ''} nach ${name(main[n - 1])}.`;

  const districts: { id: number; name: string }[] = [];
  for (const id of main) {
    const d = net.station(id).district;
    if (districts[districts.length - 1]?.id !== d) {
      const info = net.data.districts.find((x) => x.id === d);
      if (info && !districts.some((x) => x.id === d)) districts.push({ id: d, name: info.name });
    }
  }
  const day: Scope = { label: '', stations: [], stationSet: new Set(), lines: [], area: null, modes: new Set<Mode>(['U', 'S', 'T', 'B']) };
  const others = (id: string) => linesAt(net.station(id), day).filter((l) => l.id !== line.id);
  // je Station nur einmal – manche Linien fahren eine Schleife und kommen zweimal an derselben Station vorbei
  const seenNames = new Set<string>();
  const transfers = main
    .filter((id) => !seenNames.has(net.station(id).name) && seenNames.add(net.station(id).name))
    .map((id) => ({ station: net.station(id), lines: others(id).filter((l) => l.mode === 'U' || l.mode === 'S') }))
    .filter((t) => t.lines.length);
  const local = new Map(main.map((id) => [id, { trams: others(id).filter((l) => l.mode === 'T'), buses: others(id).filter((l) => l.mode === 'B') }]));
  const trams = [...new Map([...local.values()].flatMap((x) => x.trams).map((l) => [l.id, l])).values()].sort((a, b) =>
    a.id.localeCompare(b.id, 'de', { numeric: true }),
  );

  const prof: LineProfile = { line, main, waypoints, sentence, districts, transfers, trams, local, stopCount: new Set(pats.flat()).size };
  profileCache.set(line.id, prof);
  return prof;
}

/** "Von hier aus": je Linie die Richtungen ab einer Station, mit dem nächsten markanten Punkt */
export function departuresFrom(st: Station, scope: Scope): { line: Line; dirs: { to: string; via: string | null }[] }[] {
  const net = app.net;
  const out: { line: Line; dirs: { to: string; via: string | null }[] }[] = [];
  for (const line of linesAt(st, scope)) {
    const prof = lineProfile(line);
    const marks = new Set(prof.waypoints);
    const dirs = new Map<string, string | null>();
    for (const p of patternsOf(line)) {
      const i = p.indexOf(st.id);
      if (i < 0 || i === p.length - 1) continue;
      const to = net.station(p[p.length - 1]).name;
      if (dirs.has(to)) continue;
      const rest = p.slice(i + 1, -1);
      const viaId = rest.find((id) => marks.has(id)) ?? rest.find((id) => importance(net.station(id), line) >= 4);
      dirs.set(to, viaId ? net.station(viaId).name : null);
    }
    if (dirs.size) out.push({ line, dirs: [...dirs.entries()].map(([to, via]) => ({ to, via })) });
  }
  return out;
}


// ---------------------------------------------------------------- Nachzeichnen auswerten

function toXY(p: { lat: number; lon: number }, lat0: number): [number, number] {
  return [p.lon * 111_320 * Math.cos((lat0 * Math.PI) / 180), p.lat * 111_320];
}

function distToPath(p: { lat: number; lon: number }, path: LatLon[]): number {
  const lat0 = p.lat;
  const [px, py] = toXY(p, lat0);
  let best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const [ax, ay] = toXY({ lat: path[i][0], lon: path[i][1] }, lat0);
    if (path.length === 1) return Math.hypot(px - ax, py - ay);
    if (i === path.length - 1) break;
    const [bx, by] = toXY({ lat: path[i + 1][0], lon: path[i + 1][1] }, lat0);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

export interface SketchResult {
  /** Anteil der Stationen nahe an der Zeichnung */
  coverage: number;
  /** Anteil der gezeichneten Punkte nahe am echten Verlauf */
  precision: number;
  missed: Station[];
}

export function evaluateSketch(prof: LineProfile, sketch: LatLon[]): SketchResult {
  const net = app.net;
  const tol = prof.line.mode === 'U' || prof.line.mode === 'S' ? 600 : 350;
  const inner = prof.main.slice(1, -1).map((id) => net.station(id));
  const missed = inner.filter((s) => distToPath(s, sketch) > tol);
  const real: LatLon[] = prof.main.map((id) => [net.station(id).lat, net.station(id).lon]);
  const taps = sketch.slice(1, -1);
  const good = taps.filter(([lat, lon]) => distToPath({ lat, lon }, real) <= tol * 1.5).length;
  return {
    coverage: inner.length ? 1 - missed.length / inner.length : 1,
    precision: taps.length ? good / taps.length : 0,
    missed,
  };
}

/** Farben für den Linienvergleich (höchstens so viele Linien) */
const CMP = ['#e8590c', '#7048e8', '#0ca678', '#d6336c', '#1c7ed6', '#a07400'];

export const COMPARE_MAX = CMP.length;

/** Vergleichsfarben: U-Bahnen in ihrer echten Farbe, alle anderen Linien bekommen eine freie Farbe aus CMP */
export function compareColors(lines: Pick<Line, 'id' | 'mode' | 'color'>[]): Record<string, string> {
  const out: Record<string, string> = {};
  const free = [...CMP];
  for (const l of lines) if (l.mode === 'U') out[l.id] = l.color;
  for (const l of lines) if (l.mode !== 'U') out[l.id] = free.shift() ?? '#495057';
  return out;
}

/** „alle 4 min“, „alle 2,5 min“, „1× pro Stunde“ */
export function fmtHeadway(min: number): string {
  if (min >= 45) return `${Math.round(60 / min)}× pro Stunde`;
  return `alle ${min.toLocaleString('de-AT')} min`;
}

/**
 * Ø-Takt für den Steckbrief, z.B. „Mo–Fr alle 4 min (früh alle 2,5, abends alle 5) · Sa alle 5 · So alle 5 min“.
 * null, wenn es keine Takt-Daten gibt (data/headways.json fehlt oder Linie unbekannt).
 */
export function headwayText(lineId: string, data: Record<string, Record<string, number | null>> | undefined = app.net?.data.headways): string | null {
  const h = data?.[lineId];
  if (!h) return null;
  const n = (v: number | null | undefined) => (v == null ? null : v.toLocaleString('de-AT'));
  const parts: string[] = [];
  if (h.wd12 != null) {
    const extra = [h.wd7 != null && h.wd7 !== h.wd12 ? `früh alle ${n(h.wd7)}` : '', h.wd20 != null && h.wd20 !== h.wd12 ? `abends alle ${n(h.wd20)}` : ''].filter(Boolean);
    parts.push(`Mo–Fr ${fmtHeadway(h.wd12)}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  } else if (h.wd7 != null || h.wd20 != null) parts.push(`Mo–Fr ${h.wd7 != null ? `früh ${fmtHeadway(h.wd7)}` : `abends ${fmtHeadway(h.wd20!)}`}`);
  if (h.sa12 != null) parts.push(`Sa ${fmtHeadway(h.sa12)}`);
  if (h.su12 != null) parts.push(`So ${fmtHeadway(h.su12)}`);
  return parts.length ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------- Linien einer Gegend (N-1)

export type AreaPick = { kind: 'district'; id: number } | { kind: 'circle'; lat: number; lon: number; radiusM: number };

/** Stationen in der Gegend: Bezirk oder Kreis */
export function stationsInArea(area: AreaPick, stations: Station[] = app.net.data.stations): Station[] {
  return area.kind === 'district' ? stations.filter((s) => s.district === area.id) : stations.filter((s) => distM(s, area) <= area.radiusM);
}

/**
 * Linien, die in der Gegend halten – sortiert nach Anzahl der Halte dort (die Linien, die die Gegend wirklich
 * erschließen, zuerst), dann Verkehrsmittel und Nummer. Sonderlinien (71E …) bleiben draußen.
 */
export function linesInArea(area: AreaPick, modes: Set<Mode>, lines: Line[] = app.net.data.lines, stations: Station[] = app.net.data.stations): { line: Line; stops: number }[] {
  const inside = new Set(stationsInArea(area, stations).map((s) => s.id));
  const out: { line: Line; stops: number }[] = [];
  for (const l of lines) {
    if (!modes.has(l.mode) || isSpecialLine(l)) continue;
    const stops = new Set(regularPatterns(l).flat().filter((id) => inside.has(id))).size;
    if (stops) out.push({ line: l, stops });
  }
  return out.sort(
    (a, b) => b.stops - a.stops || MODE_ORDER.indexOf(a.line.mode) - MODE_ORDER.indexOf(b.line.mode) || a.line.id.localeCompare(b.line.id, 'de', { numeric: true }),
  );
}
