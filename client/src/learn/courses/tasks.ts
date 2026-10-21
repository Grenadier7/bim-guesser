// Lernmodus – interaktive Aufgaben für die Kurse: auf der Karte tippen (Station, Gegend), Linie zeichnen,
// Stationen ordnen, mehrere Linien wählen, Linie auf der Karte erkennen. Hier nur Logik (ohne Browser testbar):
// Aufgaben erzeugen, bewerten, Prüfungsablauf mit Wiederholung. Die Ansicht steckt in index.ts.
import type { LatLon, Station } from '../../../../shared/types.ts';
import { distM } from '../../../../shared/geo.ts';
import { shuffle } from '../model.ts';
import { chip, crossings, ends, have, L, mainOf, pick, stationsOf, U_LINES } from './common.ts';

export interface ChoiceTask {
  kind: 'choice';
  q: string;
  options: { id: string; html: string }[];
  correct: string;
  explain: string;
  /** Linie(n) neutral auf der Karte zeigen (z.B. „Welche Linie ist das?“) */
  show?: { lines: string[]; neutral?: boolean };
}
export interface TapStationTask {
  kind: 'tapStation';
  q: string;
  /** jede davon zählt als richtig */
  targets: Station[];
  /** so weit daneben zählt noch (m) */
  tolM: number;
  /** Linien als Orientierung (ohne Namen) */
  show?: string[];
  explain: string;
}
export interface TapAreaTask {
  kind: 'tapArea';
  q: string;
  /** Haltestellen der Gegend – richtig ist alles in ihrer Hülle oder nahe einer davon */
  stations: Station[];
  /** werden in der Auflösung gezeigt */
  lines: string[];
  color: string;
  explain: string;
}
export interface DrawTask {
  kind: 'draw';
  q: string;
  line: string;
  from: Station;
  to: Station;
  explain: string;
}
export interface OrderTask {
  kind: 'order';
  q: string;
  /** in der richtigen Reihenfolge */
  items: { id: string; label: string }[];
  explain: string;
  show?: string[];
}
export interface MultiTask {
  kind: 'multi';
  q: string;
  options: { id: string; html: string }[];
  correct: string[];
  explain: string;
}
export type Task = ChoiceTask | TapStationTask | TapAreaTask | DrawTask | OrderTask | MultiTask;

/** Aufgabe neu erzeugen (für Wiederholungen eine andere Variante); null = geht mit diesen Daten nicht */
export type TaskGen = () => Task | null;

export const TASK_ICON: Record<Task['kind'], string> = { choice: '❓', tapStation: '📍', tapArea: '🗺', draw: '✏️', order: '🔢', multi: '☑️' };

// ---------------------------------------------------------------- Geometrie

/** konvexe Hülle (Andrew) – Punkte als [lat, lon] */
export function convexHull(points: LatLon[]): LatLon[] {
  const p = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  if (p.length < 3) return p;
  const cross = (o: LatLon, a: LatLon, b: LatLon) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower: LatLon[] = [];
  for (const x of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], x) <= 0) lower.pop();
    lower.push(x);
  }
  const upper: LatLon[] = [];
  for (const x of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], x) <= 0) upper.pop();
    upper.push(x);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function insidePolygon([lat, lon]: LatLon, poly: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ai, bi] = poly[i];
    const [aj, bj] = poly[j];
    if (bi > lon !== bj > lon && lat < ((aj - ai) * (lon - bi)) / (bj - bi) + ai) inside = !inside;
  }
  return inside;
}

const ll = (s: { lat: number; lon: number }): LatLon => [s.lat, s.lon];

// ---------------------------------------------------------------- Bewerten

export interface Grade {
  ok: boolean;
  /** kurze Rückmeldung, z.B. „350 m daneben“ */
  note: string;
}

export function gradeTapStation(t: TapStationTask, tap: LatLon): Grade & { nearest: Station; dist: number } {
  const p = { lat: tap[0], lon: tap[1] };
  const nearest = t.targets.reduce((a, b) => (distM(p, a) <= distM(p, b) ? a : b));
  const dist = Math.round(distM(p, nearest));
  return { ok: dist <= t.tolM, nearest, dist, note: dist <= 60 ? 'genau getroffen' : `${dist.toLocaleString('de-AT')} m daneben` };
}

/** Hülle der Gegend (für Bewertung und Anzeige) */
export const areaHull = (t: TapAreaTask) => convexHull(t.stations.map(ll));
/** so weit außerhalb der Hülle zählt noch, wenn eine Haltestelle der Gegend so nah ist */
export const AREA_TOL_M = 500;

export function gradeTapArea(t: TapAreaTask, tap: LatLon): Grade {
  const p = { lat: tap[0], lon: tap[1] };
  if (insidePolygon(tap, areaHull(t))) return { ok: true, note: 'mitten in der Gegend' };
  const d = Math.min(...t.stations.map((s) => distM(p, s)));
  return d <= AREA_TOL_M ? { ok: true, note: 'am Rand der Gegend' } : { ok: false, note: `${(d / 1000).toLocaleString('de-AT', { maximumFractionDigits: 1 })} km daneben` };
}

export function gradeOrder(t: OrderTask, answer: string[]): Grade {
  const want = t.items.map((x) => x.id);
  const right = answer.filter((id, i) => id === want[i]).length;
  return { ok: right === want.length && answer.length === want.length, note: `${right} von ${want.length} an der richtigen Stelle` };
}

export function gradeMulti(t: MultiTask, picked: string[]): Grade {
  const want = new Set(t.correct);
  const hits = picked.filter((id) => want.has(id)).length;
  const wrong = picked.length - hits;
  return { ok: hits === want.size && wrong === 0, note: `${hits} von ${want.size} richtig${wrong ? `, ${wrong} zu viel` : ''}` };
}

/** Zeichnen: genug Stationen abgedeckt und kaum Striche daneben (wie beim Üben) */
export function gradeSketch(coverage: number, precision: number): Grade {
  const pct = Math.round(coverage * 100);
  return { ok: coverage >= 0.6 && precision >= 0.5, note: `${pct} % der Stationen getroffen${precision < 0.5 ? ', viele Striche daneben' : ''}` };
}

// ---------------------------------------------------------------- Prüfung

/**
 * Abschlussprüfung eines Kurses: jede Aufgabe einmal; falsch beantwortete kommen als neue Variante ans Ende
 * (höchstens zweimal je Aufgabe). Gezählt wird der erste Versuch – „gemeistert“ ab 80 %.
 */
export class ExamRun {
  readonly total: number;
  private queue: { gen: TaskGen; task: Task; first: boolean; tries: number }[] = [];
  private firstRight = 0;
  private index = 0;
  static readonly PASS = 0.8;
  static readonly MAX_TRIES = 3;

  constructor(gens: TaskGen[]) {
    for (const gen of gens) {
      const task = gen();
      if (task) this.queue.push({ gen, task, first: true, tries: 1 });
    }
    this.total = this.queue.length;
  }

  get current(): Task | null {
    return this.queue[this.index]?.task ?? null;
  }
  get isRetry(): boolean {
    return !!this.queue[this.index] && !this.queue[this.index].first;
  }
  get position(): { done: number; left: number } {
    return { done: this.index, left: this.queue.length - this.index };
  }
  get score(): number {
    return this.firstRight;
  }
  get passed(): boolean {
    return this.total > 0 && this.firstRight / this.total >= ExamRun.PASS;
  }

  /** Ergebnis der aktuellen Aufgabe melden, dann weiter */
  answer(ok: boolean) {
    const cur = this.queue[this.index];
    if (!cur) return;
    if (cur.first && ok) this.firstRight++;
    if (!ok && cur.tries < ExamRun.MAX_TRIES) {
      // neue Variante derselben Art – nicht einfach dieselbe Frage auswendig wiederholen
      const again = cur.gen() ?? cur.task;
      this.queue.push({ gen: cur.gen, task: again, first: false, tries: cur.tries + 1 });
    }
    this.index++;
  }
}

// ---------------------------------------------------------------- Aufgaben aus Linien erzeugen

const name = (s: Station) => s.name;

/** „Tippe, wo die A die B kreuzt“ – nur A wird gezeigt */
export function crossingTask(a: string, b: string): TapStationTask | null {
  const xs = crossings(a, b);
  if (!xs.length || !L(a) || !L(b)) return null;
  return {
    kind: 'tapStation',
    q: `Tippe auf der Karte: Wo kreuzt die ${a} die ${b}?`,
    targets: xs,
    tolM: 450,
    show: [a],
    explain: `${a} und ${b} treffen sich bei ${xs.map(name).join(' und ')}.`,
  };
}

/** „Tippe auf die Endstation der X Richtung …“ – die Linie ist nicht eingezeichnet */
export function terminalTask(id: string): TapStationTask | null {
  if (!L(id)) return null;
  const [a, b] = ends(id);
  const [known, target] = Math.random() < 0.5 ? [a, b] : [b, a];
  return {
    kind: 'tapStation',
    q: `Die ${id} fährt von ${known.name} weg – tippe auf ihre andere Endstation.`,
    targets: [target],
    tolM: 700,
    explain: `Die ${id} fährt ${known.name} ↔ ${target.name}.`,
  };
}

/** Linie aus dem Gedächtnis zeichnen (von Endstation zu Endstation) */
export function drawTask(id: string): DrawTask | null {
  if (!L(id)) return null;
  const [from, to] = ends(id);
  return { kind: 'draw', q: `Zeichne die ${id} von ${from.name} nach ${to.name}.`, line: id, from, to, explain: `So fährt die ${id}.` };
}

/** 4–5 markante Stationen einer Linie in die richtige Reihenfolge bringen */
export function orderTask(id: string, n = 5): OrderTask | null {
  if (!L(id)) return null;
  const main = mainOf(id);
  const seen = new Set<string>();
  const uniq = main.filter((s) => !seen.has(s.name) && seen.add(s.name));
  if (uniq.length < 4) return null;
  const k = Math.min(n, uniq.length);
  // gleichmäßig verteilt, Endstationen dabei
  const picks = Array.from({ length: k }, (_, i) => uniq[Math.round((i * (uniq.length - 1)) / (k - 1))]);
  return {
    kind: 'order',
    q: `Bring die Stationen der ${id} in die richtige Reihenfolge – von ${picks[0].name} aus.`,
    items: picks.map((s) => ({ id: s.id, label: s.name })),
    explain: `${id}: ${picks.map(name).join(' → ')}.`,
  };
}

/** „Welche Linie ist das?“ – Linie neutral auf der Karte, Auswahl aus ähnlichen Linien */
export function identifyTask(id: string, pool: string[]): ChoiceTask | null {
  const wrong = shuffle(have(pool).filter((x) => x !== id)).slice(0, 3);
  if (!L(id) || wrong.length < 2) return null;
  return {
    kind: 'choice',
    q: 'Welche Linie ist auf der Karte eingezeichnet?',
    options: shuffle([id, ...wrong]).map((x) => ({ id: x, html: chip(x) })),
    correct: id,
    explain: `Das ist die ${id}: ${ends(id).map(name).join(' ↔ ')}.`,
    show: { lines: [id], neutral: true },
  };
}

/** „Welche dieser Linien halten bei …?“ (mehrere richtig) */
export function servesTask(station: Station, pool: string[]): MultiTask | null {
  const at = new Set(have(pool).filter((id) => stationsOf(id).some((s) => s.name === station.name)));
  const others = shuffle(have(pool).filter((id) => !at.has(id))).slice(0, Math.max(2, 5 - at.size));
  if (!at.size || others.length < 2) return null;
  const correct = [...at].slice(0, 4);
  return {
    kind: 'multi',
    q: `Welche dieser Linien halten bei ${station.name}? (alle richtigen wählen)`,
    options: shuffle([...correct, ...others]).map((x) => ({ id: x, html: chip(x) })),
    correct,
    explain: `Bei ${station.name}: ${correct.join(', ')}.`,
  };
}

/** Gegend einer Liniengruppe antippen (z.B. „Wo fahren die 80er-Busse?“) */
export function areaTask(q: string, ids: string[], color: string, explain: string): TapAreaTask | null {
  const lines = have(ids);
  const stations = [...new Map(lines.flatMap(stationsOf).map((s) => [s.id, s])).values()];
  if (stations.length < 3) return null;
  return { kind: 'tapArea', q, stations, lines, color, explain };
}

/**
 * Aufgaben-Erzeuger zu den Linien eines Kurses: wo kreuzt sie eine U-Bahn, Stationen ordnen, andere Endstation
 * finden, Linie auf der Karte erkennen, wer hält wo, Linie zeichnen.
 */
export function lineTaskGens(lines: string[]): { cross: TaskGen; order: TaskGen; terminal: TaskGen; identify: TaskGen; serves: TaskGen; draw: TaskGen } | null {
  const ls = have(lines).filter((id) => mainOf(id).length >= 4);
  if (!ls.length) return null;
  const any = () => pick(ls);
  const us = have(U_LINES);
  // zuerst Kreuzungen mit einer U-Bahn (am lehrreichsten), sonst zwischen den Kurslinien
  const withU = ls.flatMap((a) => us.filter((u) => u !== a && crossings(a, u).length === 1).map((u) => [a, u] as const));
  const inner = ls.flatMap((a) => ls.filter((b) => a < b && crossings(a, b).length).map((b) => [a, b] as const));
  const pairs = withU.length ? withU : inner;
  const multiStops = ls.flatMap((id) => mainOf(id)).filter((s) => ls.filter((id) => stationsOf(id).some((x) => x.name === s.name)).length >= 2);
  return {
    cross: () => (pairs.length ? crossingTask(...(pick(pairs) as [string, string])) : terminalTask(any())),
    order: () => orderTask(any()),
    terminal: () => terminalTask(any()),
    identify: () => identifyTask(any(), ls.length >= 3 ? ls : [...ls, ...us]),
    serves: () => (multiStops.length ? servesTask(pick(multiStops), ls) : orderTask(any())),
    draw: () => drawTask(any()),
  };
}

/** drei Aufgaben für mitten im Kurs (nach den Erklärungen) */
export function practiceTasks(lines: string[]): Task[] {
  const g = lineTaskGens(lines);
  if (!g) return [];
  return [g.cross(), g.order(), pick([g.terminal, g.identify])()].filter((t): t is Task => !!t);
}

/**
 * Standard-Prüfung aus den Linien eines Kurses (jede Art einmal); Kurse geben eigene Aufgaben dazu
 * (z.B. Gegenden der Busnummern), die zuerst kommen.
 */
export function defaultExam(lines: string[], extra: TaskGen[] = [], size = 6): TaskGen[] {
  const g = lineTaskGens(lines);
  if (!g) return extra;
  return [...extra, ...shuffle([g.draw, g.order, g.terminal, g.identify, g.cross, g.serves])].slice(0, Math.max(size, extra.length));
}
