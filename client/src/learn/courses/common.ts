// Lernmodus – Kurse: gemeinsame Typen, Farben und Helfer (Netz, Fragen, Tabellen)
import type { Line, Station } from '../../../../shared/types.ts';
import { CENTER, distM } from '../../../../shared/geo.ts';
import { NET_COLOR } from '../../netcolors.ts';
import type { NetView, Piece } from '../../netmap.ts';
import { app } from '../../store.ts';
import { esc, lineChip } from '../../ui.ts';
import { pick } from '../../../../shared/random.ts';
import { patternsOf, shuffle } from '../model.ts';
import type { Task, TaskGen } from './tasks.ts';

export interface Quiz {
  q: string;
  options: { id: string; html: string }[];
  correct: string;
  explain: string;
}

export interface Step {
  title: string;
  html: string;
  /** erklärte Linien – kräftig */
  lines?: string[];
  /** verbindende Linien – zurückgenommen */
  context?: string[];
  /** eigene Farben für diesen Schritt (z.B. Busse nach Zehnerstelle) */
  colors?: Record<string, string>;
  /** einzelne Abschnitte hervorheben (z.B. Ringstraße, Äste der Stammstrecke) */
  pieces?: Piece[];
  /** Konzept-Bänder (Ring, Gürtel, Vorortelinie) */
  bands?: Partial<NetView['bands']>;
  /** jede Linie auch auf Stadt-Zoom beschriften (einmal, am äußeren Ende) */
  allLabels?: boolean;
  /** Ausschnitt nur auf die markierten Stationen (statt auf die ganzen Linien) */
  fitMarks?: boolean;
  /** markierte Stationen (Name beim Drüberfahren, bei wenigen dauerhaft) */
  marks?: Station[];
  quiz?: Quiz;
  /** interaktive Aufgabe (Karte tippen, zeichnen, ordnen …) – ersetzt die Erklär-Karte */
  task?: Task;
}

export interface Course {
  id: string;
  icon: string;
  title: string;
  short: string;
  build: () => Step[];
  /** Aufgaben für die Abschlussprüfung (jede Erzeugung eine neue Variante); ohne: aus den Linien des Kurses */
  exam?: () => TaskGen[];
}

export { CENTER };
export const TRANSDANUBIEN = new Set([21, 22]);

// ---------------------------------------------------------------- Farben

/** einheitliche, ruhige Farbe je Verkehrsmittel (U-Bahn in ihren Linienfarben) – wie auf der Netzkarte */
export function colorOf(l: Line): string {
  if (l.id === 'BB') return NET_COLOR.BB;
  if (l.mode === 'U') return l.color;
  if (l.mode === 'S') return NET_COLOR.S;
  if (l.mode === 'T') return NET_COLOR.Tfocus;
  if (l.mode === 'N') return NET_COLOR.N;
  return NET_COLOR.B;
}
/** S-Bahn-Äste unterscheidbar */
export const S_BRANCH = { S1: NET_COLOR.S, S2: '#12b886', S34: '#7048e8', S7: '#f08c00', common: '#16325c' };
/** Busse nach Zehnerstelle */
export const DECADE = ['#495057', '#495057', '#1e6fbf', '#12b886', '#7048e8', '#f08c00', '#e03131', '#9c36b5', '#0c8599', '#5c940d'];

// ---------------------------------------------------------------- Netz-Helfer

export const net = () => app.net;
/** Linie, sofern es sie im regulären Netz gibt */
export const L = (id: string): Line | undefined => {
  const l = net().lines.get(id);
  return l && patternsOf(l).length ? l : undefined;
};
export const have = (ids: string[]) => ids.filter((id) => L(id));
/** Haltestellen der Linie entlang der längsten Haltefolge */
export function mainOf(id: string): Station[] {
  const pats = patternsOf(L(id)!);
  const main = pats.reduce((a, b) => (b.length > a.length ? b : a));
  return main.map((s) => net().station(s));
}
/** alle Haltestellen der Linie (alle Haltefolgen) */
export function stationsOf(id: string): Station[] {
  return [...new Set(patternsOf(L(id)!).flat())].map((s) => net().station(s));
}
export const ends = (id: string): [Station, Station] => {
  const m = mainOf(id);
  return [m[0], m[m.length - 1]];
};
/** Endstation, die weiter vom Zentrum weg ist */
export const farEnd = (id: string) => {
  const [a, b] = ends(id);
  return distM(a, CENTER) > distM(b, CENTER) ? a : b;
};
export const nearEnd = (id: string) => {
  const [a, b] = ends(id);
  return distM(a, CENTER) > distM(b, CENTER) ? b : a;
};
/** Wo trifft Linie a auf Linie b? (gleiche Station oder < 250 m), in Fahrtrichtung von a */
export function crossings(a: string, b: string): Station[] {
  const B = stationsOf(b);
  const out: Station[] = [];
  for (const s of mainOf(a)) {
    const t = B.find((x) => x.id === s.id || distM(x, s) < 250);
    if (t && !out.some((o) => o.name === t.name)) out.push(t);
  }
  return out;
}
export const stationByName = (name: string) => net().data.stations.find((s) => s.name === name);
/** Stück der Hauptstrecke zwischen zwei Stationen (nach Namen) */
export function segment(id: string, from: string, to: string): Station[] {
  const m = mainOf(id);
  const i = m.findIndex((s) => s.name === from);
  const j = m.findIndex((s) => s.name === to);
  if (i < 0 || j < 0) return [];
  return i <= j ? m.slice(i, j + 1) : m.slice(j, i + 1).reverse();
}

/** Liniennummer – im Kurstext antippbar (öffnet den Steckbrief, ohne den Kurs zu verlassen) */
export const chip = (id: string, colors?: Record<string, string>) => {
  const l = net().lines.get(id);
  return l ? `<span class="chip-link" data-line="${esc(l.id)}">${lineChip(l.mode, l.id, colors?.[id] ?? colorOf(l))}</span>` : esc(id);
};
export const chips = (ids: string[], colors?: Record<string, string>) => ids.map((id) => chip(id, colors)).join(' ');
export const districtName = (d: number) => {
  const x = net().data.districts.find((z) => z.id === d);
  return x ? `${d}. ${x.name}` : `${d}.`;
};
export const route = (id: string) => `${esc(ends(id)[0].name)} ↔ ${esc(ends(id)[1].name)}`;

// ---------------------------------------------------------------- Fragen

/** Frage mit einer richtigen und bis zu drei falschen Antworten (Texte, doppelte fallen weg) */
export function quiz(q: string, right: string, wrong: string[], explain: string, html = (x: string) => esc(x)): Quiz | null {
  const others = shuffle([...new Set(wrong.filter((w) => w !== right))]).slice(0, 3);
  if (others.length < 2) return null;
  return { q, options: shuffle([right, ...others]).map((x) => ({ id: x, html: html(x) })), correct: right, explain };
}
export const lineQuiz = (q: string, right: string, wrong: string[], explain: string) => quiz(q, right, wrong, explain, (x) => chip(x));
export { pick };
export const ask = (qz: Quiz | null): Step[] => (qz ? [{ title: 'Frage', html: '', quiz: qz }] : []);
/** interaktive Aufgabe als Kursschritt (null = mit diesen Daten nicht möglich → kein Schritt) */
export const taskStep = (t: Task | null): Step[] => (t ? [{ title: 'Aufgabe', html: '', task: t }] : []);

export function table(rows: [string, string][]): string {
  return `<table class="course-table">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
}

// ---------------------------------------------------------------- Linienlisten, die mehrere Kurse teilen

export const RADIAL_FAMILY = ['37', '38', '40', '41', '42', '43', '44'];
export const RADIAL_OTHER = ['31', '49', '62', 'BB', '71'];
export const DIAMETRAL = ['U1', 'U3', 'U4', 'D', '1', '2'];
export const RING_LINES = ['1', '2', '71', 'D'];
export const GUERTEL = ['U6', '18', '6'];
export const OUTER = ['S45', '10'];
export const TANGENTIAL = ['5', '6', '9', '10', '12', '18'];
export const GUERTEL_RADIAL = ['46', '52', '60'];
export const TRANS_TANGENTIAL = ['25', '26', '27'];
export const U_LINES = ['U1', 'U2', 'U3', 'U4', 'U6'];
