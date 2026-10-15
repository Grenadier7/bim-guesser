// Lernmodus – Daten: Bereich (Gebiet/Linien), Linien-Steckbriefe, Lernstand
import type { LatLon, Line, Mode, Station } from '../../../shared/types.ts';
import { MODE_LABEL, linePatterns } from '../../../shared/rules.ts';
import { DEFAULT_LEARN } from '../../../shared/defaults.ts';
import { distM } from '../net.ts';
import { app } from '../store.ts';

// ---------------------------------------------------------------- Konfiguration & Speicher

export type ScopeKind = 'area' | 'lines' | 'all';
export type Exercise = 'locate' | 'stopLines' | 'lineShape' | 'nextStop';

export interface Config {
  kind: ScopeKind;
  areaType: 'district' | 'circle';
  district: number;
  circle: { lat: number; lon: number; radiusM: number } | null;
  lines: string[];
  modes: Mode[];
  exercises: Exercise[];
}

export const EXERCISES: Record<Exercise, { icon: string; label: string; hint: string }> = {
  locate: { icon: '📍', label: 'Wo liegt …?', hint: 'Station auf der leeren Karte antippen' },
  stopLines: { icon: '🚏', label: 'Welche Linien halten hier?', hint: 'alle richtigen Linien auswählen' },
  lineShape: { icon: '🔀', label: 'Welche Linie ist das?', hint: 'Linie am Verlauf erkennen' },
  nextStop: { icon: '➡️', label: 'Nächste Station', hint: 'welche Station kommt als nächstes?' },
};
export const ALL_EXERCISES = Object.keys(EXERCISES) as Exercise[];
export const AREA_MODES: Mode[] = ['U', 'S', 'T', 'B', 'N'];
export const RADII = [1000, 1500, 2500, 4000];

const CFG_KEY = 'oeffi-learn-config-v1';
const PROGRESS_KEY = 'oeffi-learn-progress-v1';

function load<T>(key: string, def: T): T {
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(key) ?? '{}') };
  } catch {
    return def;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* privater Modus */
  }
}

export function loadConfig(): Config {
  return load<Config>(CFG_KEY, { ...DEFAULT_LEARN, lines: [...DEFAULT_LEARN.lines], modes: [...DEFAULT_LEARN.modes], exercises: [...ALL_EXERCISES] });
}
export const saveConfig = (cfg: Config) => save(CFG_KEY, cfg);

/**
 * Lernstand: Schlüssel → Stufe 0–3.
 *  "line:<id>"        – Linie für Linie (Selbsteinschätzung)
 *  "<übung>:<id>"     – Wissen testen
 */
const progress: Record<string, number> = load(PROGRESS_KEY, {});
export const MASTERED = 3;
export const boxOf = (key: string) => progress[key] ?? 0;
export function setBox(key: string, box: number) {
  progress[key] = Math.max(0, Math.min(MASTERED, box));
  save(PROGRESS_KEY, progress);
}
export function resetBoxes(keys: string[]) {
  for (const k of keys) delete progress[k];
  save(PROGRESS_KEY, progress);
}

// ---------------------------------------------------------------- Hilfen

export function patternsOf(line: Line): string[][] {
  const reg = linePatterns(line, 'regular');
  return reg.length ? reg : linePatterns(line, 'current');
}

export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const pickRandom = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
export const fmtKm = (m: number) => `${(m / 1000).toLocaleString('de-AT')} km`;

/** Unterscheidbare Farben für den Netzplan (Bim und Bus hätten sonst alle dieselbe Farbe) */
export const PALETTE = ['#e3000f', '#1e6fbf', '#2f9e44', '#ee7d00', '#9c36b5', '#0c8599', '#9d6930', '#d6336c', '#364fc7', '#5c940d', '#e8590c', '#495057'];

// ---------------------------------------------------------------- Bereich

export interface Scope {
  label: string;
  stations: Station[];
  stationSet: Set<string>;
  lines: Line[];
  area: { rings?: LatLon[][]; circle?: { lat: number; lon: number; radiusM: number } } | null;
  /** Verkehrsmittel, die zählen (bei "Linien" alle) */
  modes: Set<Mode>;
}

const MODE_ORDER: Mode[] = ['U', 'S', 'T', 'B', 'N'];

export function computeScope(cfg: Config): Scope {
  const net = app.net;
  if (cfg.kind === 'lines') {
    const lines = cfg.lines.map((id) => net.lines.get(id)).filter((l): l is Line => !!l);
    const ids = new Set(lines.flatMap((l) => patternsOf(l).flat()));
    return {
      label: lines.length ? `Linien ${lines.map((l) => l.id).join(', ')}` : 'Keine Linie gewählt',
      stations: [...ids].map((id) => net.station(id)),
      stationSet: ids,
      lines,
      area: null,
      modes: new Set(AREA_MODES),
    };
  }
  const modes = new Set(cfg.modes);
  let stations = net.data.stations.filter((s) => s.modes.some((m) => modes.has(m)));
  let label = 'Ganz Wien';
  let area: Scope['area'] = null;
  if (cfg.kind === 'area') {
    if (cfg.areaType === 'district') {
      const d = net.data.districts.find((x) => x.id === cfg.district)!;
      stations = stations.filter((s) => s.district === d.id);
      label = `${d.id}. ${d.name}`;
      area = { rings: d.rings };
    } else if (cfg.circle) {
      const c = cfg.circle;
      stations = stations.filter((s) => distM(s, c) <= c.radiusM);
      const near = [...net.data.stations].sort((a, b) => distM(a, c) - distM(b, c))[0];
      label = `${fmtKm(c.radiusM)} um ${near?.name ?? 'den Punkt'}`;
      area = { circle: c };
    } else {
      stations = [];
      label = 'Kreis: tippe auf die Karte';
    }
  }
  const stationSet = new Set(stations.map((s) => s.id));
  const lines = net.data.lines
    .filter((l) => modes.has(l.mode) && [...new Set(patternsOf(l).flat())].filter((id) => stationSet.has(id)).length >= 2)
    .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode) || a.id.localeCompare(b.id, 'de', { numeric: true }));
  return { label, stations, stationSet, lines, area, modes };
}

/** Linien an einer Station, die im Bereich zählen */
export function linesAt(st: Station, scope: Scope): Line[] {
  return st.lines
    .map((id) => app.net.lines.get(id)!)
    .filter((l) => l && scope.modes.has(l.mode) && patternsOf(l).some((p) => p.includes(st.id)));
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
  /** Umstiege zu U-Bahn/S-Bahn */
  transfers: { station: Station; lines: Line[] }[];
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
  const transfers = main
    .map((id) => {
      const st = net.station(id);
      const rapid = st.lines.map((x) => net.lines.get(x)!).filter((l) => l && l.id !== line.id && (l.mode === 'U' || l.mode === 'S'));
      return { station: st, lines: rapid };
    })
    .filter((t) => t.lines.length);

  const prof: LineProfile = { line, main, waypoints, sentence, districts, transfers, stopCount: new Set(pats.flat()).size };
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

export const modeWord = (m: Mode) => MODE_LABEL[m];

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
