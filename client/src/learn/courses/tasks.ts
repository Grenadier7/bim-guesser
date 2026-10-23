// Lernmodus – interaktive Aufgaben für die Kurse: auf der Karte tippen (Station, Gegend), Linie zeichnen,
// Stationen ordnen, mehrere Linien wählen, Linie auf der Karte erkennen. Hier nur Logik (ohne Browser testbar):
// Aufgaben erzeugen, bewerten, Prüfungsablauf mit Wiederholung. Die Ansicht steckt in index.ts.
import type { LatLon, Station } from '../../../../shared/types.ts';
import { distM } from '../../../../shared/geo.ts';
import { lineProfile, shuffle } from '../model.ts';
import { app } from '../../store.ts';
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
  const km = (dist / 1000).toLocaleString('de-AT', { maximumFractionDigits: 1 });
  const note = dist <= 300 ? 'genau getroffen' : dist <= t.tolM ? `ungefähr richtig (${km} km daneben)` : `${km} km daneben`;
  return { ok: dist <= t.tolM, nearest, dist, note };
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
  // bei 3 richtigen darf eine fehlen – aber nichts Falsches gewählt sein
  const enough = want.size >= 3 ? hits >= want.size - 1 : hits === want.size;
  return { ok: enough && wrong === 0, note: `${hits} von ${want.size} richtig${wrong ? `, ${wrong} falsch gewählt` : ''}` };
}

/** Zeichnen: grob richtig reicht – die Hälfte der Stationen in der Nähe, nicht zu viel daneben */
export function gradeSketch(coverage: number, precision: number): Grade {
  const pct = Math.round(coverage * 100);
  return { ok: coverage >= 0.5 && precision >= 0.4, note: `${pct} % der Stationen getroffen${precision < 0.5 ? ', viele Striche daneben' : ''}` };
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
//
// Maßstab für jede Aufgabe (Zielgruppe: Leute, die das Netz gerade erst kennenlernen):
//  • Nutzen: übt sie das Konzept des Kapitels (wo kreuzt was, wohin fährt eine Linie, welche Gegend)?
//  • Schaffbar: ungefähres Wissen reicht – Orte großzügig bewerten, nur markante Stationen, wenige Elemente.

const name = (s: Station) => s.name;
const isRapid = (id: string) => L(id)?.mode === 'U' || L(id)?.mode === 'S';
/** „ungefähr dort“ reicht: Schnellbahnen haben weite Stationsabstände, Bim/Bus enge */
const nearTol = (id: string) => (isRapid(id) ? 1500 : 1000);

/** „Tippe, wo die A die B kreuzt“ – nur A wird gezeigt, ungefähr richtig reicht */
export function crossingTask(a: string, b: string): TapStationTask | null {
  const xs = crossings(a, b);
  if (!xs.length || !L(a) || !L(b)) return null;
  return {
    kind: 'tapStation',
    q: `Tippe ungefähr dorthin, wo die ${a} die ${b} kreuzt.`,
    targets: xs,
    tolM: Math.max(nearTol(a), nearTol(b)),
    show: [a],
    explain: `${a} und ${b} treffen sich bei ${xs.map(name).join(' und ')}.`,
  };
}

/** „Wohin fährt die X?“ – andere Endstation ungefähr antippen (Linie nicht eingezeichnet) */
export function terminalTask(id: string): TapStationTask | null {
  if (!L(id)) return null;
  const [a, b] = ends(id);
  const [known, target] = Math.random() < 0.5 ? [a, b] : [b, a];
  return {
    kind: 'tapStation',
    q: `Die ${id} startet in ${known.name}. Wohin fährt sie? Tippe ungefähr auf ihr anderes Ende.`,
    targets: [target],
    tolM: 2000,
    explain: `Die ${id} fährt ${known.name} ↔ ${target.name}.`,
  };
}

/** Linie zeichnen – nur U-/S-Bahn (bei Bim/Bus zu kleinteilig für Einsteiger) */
export function drawTask(id: string): DrawTask | null {
  if (!L(id) || !isRapid(id)) return null;
  const [from, to] = ends(id);
  return { kind: 'draw', q: `Zeichne grob, wie die ${id} von ${from.name} nach ${to.name} fährt.`, line: id, from, to, explain: `So fährt die ${id}.` };
}

/**
 * Reihenfolge – nur markante Stationen einer U-/S-Bahn (die aus dem Steckbrief-Satz), höchstens 4, die erste ist
 * vorgegeben und die Linie eingezeichnet. Zufällige kleine Stationen wären für Einsteiger nicht lösbar.
 */
export function orderTask(id: string): OrderTask | null {
  if (!L(id) || !isRapid(id)) return null;
  const seen = new Set<string>();
  const marks = lineProfile(L(id)!)
    .waypoints.map((sid) => app.net.station(sid))
    .filter((s) => !seen.has(s.name) && seen.add(s.name));
  if (marks.length < 3) return null;
  const inner = marks.slice(1, -1);
  const mid = inner.length > 2 ? shuffle([...inner]).slice(0, 2).sort((x, y) => marks.indexOf(x) - marks.indexOf(y)) : inner;
  const picks = [marks[0], ...mid, marks[marks.length - 1]];
  return {
    kind: 'order',
    q: `Die ${id} startet in ${picks[0].name}. In welcher Reihenfolge kommen die anderen Stationen?`,
    items: picks.map((s) => ({ id: s.id, label: s.name })),
    explain: `${id}: ${picks.map(name).join(' → ')}.`,
    show: [id],
  };
}

/** Wie verschieden zwei Linien verlaufen (Endstationen weit auseinander → auf der Karte unterscheidbar) */
function distinct(a: string, b: string): boolean {
  const [a1, a2] = ends(a);
  const [b1, b2] = ends(b);
  const far = (x: Station, y: Station) => distM(x, y) > 2500;
  return (far(a1, b1) || far(a2, b2)) && (far(a1, b2) || far(a2, b1));
}

/** „Welche Linie ist das?“ – Linie neutral auf der Karte; Auswahl nur aus deutlich anders verlaufenden Linien */
export function identifyTask(id: string, pool: string[]): ChoiceTask | null {
  if (!L(id)) return null;
  const wrong = shuffle(have(pool).filter((x) => x !== id && distinct(id, x))).slice(0, 3);
  if (wrong.length < 2) return null;
  return {
    kind: 'choice',
    q: 'Welche Linie ist auf der Karte eingezeichnet?',
    options: shuffle([id, ...wrong]).map((x) => ({ id: x, html: chip(x) })),
    correct: id,
    explain: `Das ist die ${id}: ${ends(id).map(name).join(' ↔ ')}.`,
    show: { lines: [id], neutral: true },
  };
}

/** „Welche dieser Linien halten bei …?“ – höchstens 3 richtige unter 5 */
export function servesTask(station: Station, pool: string[]): MultiTask | null {
  const at = shuffle(have(pool).filter((id) => stationsOf(id).some((s) => s.name === station.name))).slice(0, 3);
  const others = shuffle(have(pool).filter((id) => !at.includes(id))).slice(0, 5 - at.length);
  if (!at.length || others.length < 2) return null;
  return {
    kind: 'multi',
    q: `Welche dieser Linien halten bei ${station.name}? (alle richtigen wählen)`,
    options: shuffle([...at, ...others]).map((x) => ({ id: x, html: chip(x) })),
    correct: at,
    explain: `Bei ${station.name}: ${at.join(', ')}.`,
  };
}

/** Gegend einer Liniengruppe antippen (z.B. „Wo fahren die 80er-Busse?“) */
export function areaTask(q: string, ids: string[], color: string, explain: string): TapAreaTask | null {
  const lines = have(ids);
  const stations = [...new Map(lines.flatMap(stationsOf).map((s) => [s.id, s])).values()];
  if (stations.length < 3) return null;
  return { kind: 'tapArea', q, stations, lines, color, explain };
}

/** Aufgaben-Erzeuger zu den Linien eines Kurses (null, wenn eine Art mit diesen Linien keinen Sinn ergibt) */
export function lineTaskGens(lines: string[]) {
  const ls = have(lines).filter((id) => mainOf(id).length >= 4);
  if (!ls.length) return null;
  const any = () => pick(ls);
  const rapid = ls.filter(isRapid);
  const us = have(U_LINES);
  // Kreuzung mit einer U-Bahn ist das wichtigste Orientierungswissen; sonst zwischen den Kurslinien
  const withU = ls.flatMap((a) => us.filter((u) => u !== a && crossings(a, u).length === 1).map((u) => [a, u] as const));
  const inner = ls.flatMap((a) => ls.filter((b) => a < b && crossings(a, b).length === 1).map((b) => [a, b] as const));
  const pairs = withU.length ? withU : inner;
  const multiStops = ls.flatMap((id) => mainOf(id)).filter((s) => ls.filter((id) => stationsOf(id).some((x) => x.name === s.name)).length >= 2);
  const idPool = [...new Set([...ls, ...us])];
  const gen = (f: TaskGen | null) => f;
  return {
    cross: gen(pairs.length ? () => crossingTask(...(pick(pairs) as [string, string])) : null),
    terminal: gen(() => terminalTask(any())),
    identify: gen(() => identifyTask(any(), idPool)),
    serves: gen(multiStops.length ? () => servesTask(pick(multiStops), ls) : null),
    order: gen(rapid.length ? () => orderTask(pick(rapid)) : null),
    draw: gen(rapid.length ? () => drawTask(pick(rapid)) : null),
  };
}

/** zwei bis drei Aufgaben mitten im Kurs – nur die leichten (ungefähr antippen, Linie erkennen) */
export function practiceTasks(lines: string[]): Task[] {
  const g = lineTaskGens(lines);
  if (!g) return [];
  return [g.cross?.() ?? null, g.terminal?.() ?? null, g.identify?.() ?? null].filter((t): t is Task => !!t).slice(0, 3);
}

/**
 * Standard-Prüfung aus den Linien eines Kurses: jede Art, die mit diesen Linien Sinn ergibt; eigene Aufgaben
 * eines Kurses (z.B. Gegenden der Busnummern) kommen zuerst.
 */
export function defaultExam(lines: string[], extra: TaskGen[] = [], size = 6): TaskGen[] {
  const g = lineTaskGens(lines);
  if (!g) return extra;
  const gens = [g.cross, g.terminal, g.identify, g.serves, g.order, g.draw, g.cross, g.terminal].filter((x): x is TaskGen => !!x);
  return [...extra, ...gens].slice(0, Math.max(size, extra.length));
}
