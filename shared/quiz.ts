// Quiz: Fragetypen, Erzeugung und Bewertung – läuft am Server (gemeinsame Fragen für alle Spieler).
import type { District, LatLon, Line, Mode, Station } from './types.ts';
import { DEFAULT_QUIZ_SETTINGS } from './defaults.ts';
import { distM } from './geo.ts';
import { pick, shuffle } from './random.ts';
import { isSpecialLine } from './rules.ts';

export { distM };

export type QuizType =
  | 'locate'
  | 'stopLines'
  | 'lineShape'
  | 'nextStop'
  | 'termini'
  | 'district'
  | 'transfer'
  | 'direct'
  | 'draw'
  | 'uCross'
  | 'uLink'
  | 'towards'
  | 'busArea';

export const QUIZ_TYPES: Record<QuizType, { icon: string; label: string; hint: string }> = {
  locate: { icon: '📍', label: 'Wo liegt …?', hint: 'Station auf der leeren Karte antippen' },
  direct: { icon: '🎯', label: 'Direktverbindung', hint: 'Welche Linie fährt ohne Umsteigen von A nach B?' },
  towards: { icon: '🧭', label: 'Richtung', hint: 'Welche Linie fährt von dieser Station zu einem bestimmten Ziel?' },
  transfer: { icon: '🔀', label: 'Umstieg', hint: 'Wo kann man von Linie X in Linie Y umsteigen?' },
  uCross: { icon: '🚇', label: 'U-Bahn-Kreuzung', hint: 'An welcher U-Bahn-Station kreuzt eine Linie die U-Bahn?' },
  uLink: { icon: '🔗', label: 'Querverbindung', hint: 'Welche Linie verbindet zwei U-Bahn-Linien miteinander?' },
  stopLines: { icon: '🚏', label: 'Linien an der Station', hint: 'Welche Linien halten hier? (mehrere)' },
  termini: { icon: '↔️', label: 'Endstationen', hint: 'Zwischen welchen Endstationen fährt die Linie?' },
  lineShape: { icon: '〰️', label: 'Linie erkennen', hint: 'Welche Linie hat diesen Verlauf?' },
  draw: { icon: '✏️', label: 'Linie zeichnen', hint: 'Verlauf einer Linie von Anfang bis Ende nachzeichnen' },
  district: { icon: '🏘️', label: 'Bezirk', hint: 'In welchem Bezirk liegt die Station?' },
  nextStop: { icon: '➡️', label: 'Nächste Station', hint: 'Welche Station kommt als nächstes?' },
  busArea: { icon: '🔢', label: 'Busnummer', hint: 'In welchem Bezirk fährt ein Bus? (nur mit Bussen)' },
};
export const QUIZ_TYPE_ORDER = Object.keys(QUIZ_TYPES) as QuizType[];

/** Häufigkeit je Fragetyp: 1 = gar nicht · 4 = normal · 7 = sehr häufig */
export type Frequency = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const FREQUENCY_LABELS = ['', 'Gar nicht', 'Sehr selten', 'Selten', 'Normal', 'Oft', 'Häufig', 'Sehr häufig'];
const FREQUENCY_WEIGHT = [0, 0, 0.5, 1, 2, 3, 4.5, 6];

export interface QuizSettings {
  questions: number;
  timeSec: number;
  /** 0 = ganz Wien, sonst Bezirk */
  area: number;
  modes: Mode[];
  weights: Record<QuizType, Frequency>;
}

export const QUIZ_QUESTION_COUNTS = [5, 10, 15, 20];
export const QUIZ_TIMES = [10, 15, 20, 30, 45];

// Standardwerte: shared/defaults.ts
export { DEFAULT_QUIZ_SETTINGS } from './defaults.ts';

export function sanitizeQuizSettings(s: Partial<QuizSettings> | undefined, base: QuizSettings = DEFAULT_QUIZ_SETTINGS): QuizSettings {
  const out: QuizSettings = { ...base, weights: { ...base.weights }, modes: [...base.modes] };
  if (!s || typeof s !== 'object') return out;
  if (QUIZ_QUESTION_COUNTS.includes(Number(s.questions))) out.questions = Number(s.questions);
  if (QUIZ_TIMES.includes(Number(s.timeSec))) out.timeSec = Number(s.timeSec);
  if (Number.isInteger(s.area) && s.area! >= 0 && s.area! <= 23) out.area = s.area!;
  if (Array.isArray(s.modes)) {
    const m = s.modes.filter((x): x is Mode => ['U', 'S', 'T', 'B', 'N'].includes(x as string));
    if (m.length) out.modes = [...new Set(m)];
  }
  // alte Einstellungen (Skala 0–3, ohne "Linie zeichnen") ignorieren statt falsch umzudeuten
  if (s.weights && typeof s.weights === 'object' && 'draw' in s.weights)
    for (const t of QUIZ_TYPE_ORDER) {
      const v = Number((s.weights as Record<string, unknown>)[t]);
      if (Number.isInteger(v) && v >= 1 && v <= 7) out.weights[t] = v as Frequency;
    }
  if (QUIZ_TYPE_ORDER.every((t) => out.weights[t] === 1)) out.weights.locate = 4;
  return out;
}

// ---------------------------------------------------------------- Fragen

export interface QuizOption {
  id: string;
  label: string;
  /** Linien-Chip statt Text */
  lineId?: string;
}

/** Was alle Spieler vor dem Antworten sehen */
export interface QuizQuestionPublic {
  type: QuizType;
  prompt: string;
  /** Station, die auf der Karte markiert wird (nicht bei "Wo liegt …?") */
  stationId?: string;
  /** Linie, die neutral auf der Karte gezeichnet wird */
  drawLineId?: string;
  /** Linien, die in ihrer Farbe (ohne Beschriftung) gezeichnet werden */
  drawLines?: string[];
  /** eigenes Zeitlimit dieser Frage (z.B. Linie zeichnen) */
  timeSec?: number;
  /** zusätzlich markierte Stationen (z.B. A und B bei Direktverbindung) */
  markers?: string[];
  /** Linien als Kontext (z.B. bei "Wo liegt …?") */
  chips?: string[];
  options?: QuizOption[];
  multi?: boolean;
}

export type QuizCorrect = string | string[] | LatLon | LatLon[];

export interface QuizQuestion extends QuizQuestionPublic {
  correct: QuizCorrect;
  /** für die Auflösung */
  explanation: string;
  /** Station/Linie, die nach der Auflösung gezeigt wird */
  revealStationId?: string;
  revealLineId?: string;
  /** Linie zeichnen: Toleranz in Metern */
  tolM?: number;
}

export function publicQuestion(q: QuizQuestion): QuizQuestionPublic {
  // drawLines zeigt die Lösung (z.B. „Querverbindung“) – kommt erst mit der Auflösung (Befund H-06)
  const { correct: _c, explanation: _e, revealStationId: _s, revealLineId: _l, tolM: _t, drawLines: _d, ...pub } = q;
  return pub;
}

// ---------------------------------------------------------------- Netz-Zugriff (Server und Client)

export interface QuizNet {
  stations: Station[];
  station(id: string): Station;
  line(id: string): Line | undefined;
  lines: Line[];
  districts: District[];
  patterns(line: Line): string[][];
}



interface QuizScope {
  stations: Station[];
  stationSet: Set<string>;
  lines: Line[];
  modes: Set<Mode>;
}


export function quizScope(net: QuizNet, s: QuizSettings): QuizScope {
  const modes = new Set(s.modes);
  const candidates = net.lines.filter((l) => modes.has(l.mode) && !isSpecialLine(l) && net.patterns(l).length);
  // nur Stationen, an denen im regulären Netz eine dieser Linien hält (keine Halte aus Sonderführungen)
  const served = new Set(candidates.flatMap((l) => net.patterns(l).flat()));
  let stations = net.stations.filter((st) => served.has(st.id));
  if (s.area) stations = stations.filter((st) => st.district === s.area);
  const stationSet = new Set(stations.map((st) => st.id));
  const lines = candidates.filter((l) => [...new Set(net.patterns(l).flat())].filter((id) => stationSet.has(id)).length >= 2);
  return { stations, stationSet, lines, modes };
}

function linesAt(net: QuizNet, st: Station, scope: QuizScope): Line[] {
  return st.lines.map((id) => net.line(id)!).filter((l) => l && scope.modes.has(l.mode) && !isSpecialLine(l) && net.patterns(l).some((p) => p.includes(st.id)));
}

function mainPattern(net: QuizNet, l: Line): string[] {
  return [...net.patterns(l)].sort((a, b) => b.length - a.length)[0];
}

function overlap(net: QuizNet, a: Line, b: Line): number {
  const sa = new Set(net.patterns(a).flat());
  const sb = new Set(net.patterns(b).flat());
  let n = 0;
  for (const id of sa) if (sb.has(id)) n++;
  return n / sa.size;
}

/** Fährt die Linie ohne Umsteigen zwischen a und b (egal welche Richtung)? */
function connects(net: QuizNet, l: Line, a: string, b: string): boolean {
  return net.patterns(l).some((p) => {
    const i = p.indexOf(a);
    const j = p.indexOf(b);
    return i >= 0 && j >= 0 && i !== j;
  });
}

function terminiLabel(net: QuizNet, l: Line): string {
  const p = mainPattern(net, l);
  return [net.station(p[0]).name, net.station(p[p.length - 1]).name].sort((x, y) => x.localeCompare(y, 'de')).join(' ↔ ');
}

const lineOpt = (l: Line): QuizOption => ({ id: l.id, label: l.id, lineId: l.id });
const stationOpt = (s: Station): QuizOption => ({ id: s.id, label: s.name });

type Gen = (net: QuizNet, scope: QuizScope) => QuizQuestion | null;

const GENERATORS: Record<QuizType, Gen> = {
  locate(net, scope) {
    if (scope.stations.length < 3) return null;
    const st = pick(scope.stations);
    return {
      type: 'locate',
      prompt: `Wo liegt ${st.name}?`,
      chips: linesAt(net, st, scope).map((l) => l.id),
      correct: [st.lat, st.lon],
      explanation: `${st.name} liegt im ${st.district}. Bezirk.`,
      revealStationId: st.id,
    };
  },

  stopLines(net, scope) {
    const cands = scope.stations.filter((s) => linesAt(net, s, scope).length);
    if (!cands.length) return null;
    const st = pick(cands);
    const correct = linesAt(net, st, scope);
    const near = net.stations
      .filter((x) => x.id !== st.id && distM(x, st) < 1500)
      .flatMap((x) => linesAt(net, x, scope))
      .filter((l) => !correct.includes(l));
    const distractors = shuffle([...new Map(near.map((l) => [l.id, l])).values()]).slice(0, Math.max(3, 8 - correct.length));
    if (!distractors.length) return null;
    return {
      type: 'stopLines',
      prompt: `Welche Linien halten bei ${st.name}?`,
      stationId: st.id,
      options: shuffle([...correct, ...distractors]).map(lineOpt),
      multi: true,
      correct: correct.map((l) => l.id),
      explanation: `Bei ${st.name} halten: ${correct.map((l) => l.id).join(', ')}.`,
    };
  },

  lineShape(net, scope) {
    if (scope.lines.length < 2) return null;
    const line = pick(scope.lines);
    const distinct = (l: Line) => l !== line && overlap(net, line, l) < 0.5 && overlap(net, l, line) < 0.5;
    const pool = [...shuffle(scope.lines.filter((l) => distinct(l) && l.mode === line.mode)), ...shuffle(scope.lines.filter((l) => distinct(l) && l.mode !== line.mode)), ...shuffle(net.lines.filter((l) => distinct(l) && l.mode === line.mode && net.patterns(l).length))];
    const chosen: Line[] = [];
    for (const l of pool) {
      if (chosen.length >= 3) break;
      if (chosen.includes(l) || chosen.some((c) => overlap(net, c, l) >= 0.5 || overlap(net, l, c) >= 0.5)) continue;
      chosen.push(l);
    }
    if (chosen.length < 2) return null;
    return {
      type: 'lineShape',
      prompt: 'Welche Linie fährt diese Strecke?',
      drawLineId: line.id,
      options: shuffle([line, ...chosen]).map(lineOpt),
      correct: line.id,
      explanation: `Das ist die ${line.id}: ${terminiLabel(net, line)}.`,
      revealLineId: line.id,
    };
  },

  nextStop(net, scope) {
    const cands = scope.lines.filter((l) => net.patterns(l).some((p) => p.length >= 4));
    if (!cands.length) return null;
    const line = pick(cands);
    const pattern = pick(net.patterns(line).filter((p) => p.length >= 4));
    const inScope = pattern.slice(0, -1).map((id, i) => (scope.stationSet.has(id) ? i : -1)).filter((i) => i >= 0);
    const idx = inScope.length ? pick(inScope) : Math.floor(Math.random() * (pattern.length - 1));
    const cur = net.station(pattern[idx]);
    const next = net.station(pattern[idx + 1]);
    const names = new Set([cur.name, next.name]);
    const wrong = shuffle([...new Set(net.patterns(line).flat())].map((id) => net.station(id)))
      .filter((s) => !names.has(s.name) && (names.add(s.name), true))
      .slice(0, 3);
    if (wrong.length < 2) return null;
    return {
      type: 'nextStop',
      prompt: `${line.id} Richtung ${net.station(pattern[pattern.length - 1]).name}: Nach ${cur.name} kommt …?`,
      drawLineId: line.id,
      stationId: cur.id,
      options: shuffle([next, ...wrong]).map(stationOpt),
      correct: next.id,
      explanation: `Nach ${cur.name} kommt ${next.name}.`,
      revealLineId: line.id,
    };
  },

  termini(net, scope) {
    if (!scope.lines.length) return null;
    const line = pick(scope.lines);
    const label = terminiLabel(net, line);
    const others = shuffle(net.lines.filter((l) => l !== line && l.mode === line.mode && net.patterns(l).length))
      .map((l) => terminiLabel(net, l))
      .filter((x, i, arr) => x !== label && arr.indexOf(x) === i)
      .slice(0, 3);
    if (others.length < 2) return null;
    return {
      type: 'termini',
      prompt: `Zwischen welchen Endstationen fährt die ${line.id}?`,
      chips: [line.id],
      options: shuffle([label, ...others]).map((x) => ({ id: x, label: x })),
      correct: label,
      explanation: `Die ${line.id} fährt ${label}.`,
      revealLineId: line.id,
    };
  },

  district(net, scope) {
    if (!scope.stations.length || !net.districts.length) return null;
    const st = pick(scope.stations);
    const own = net.districts.find((d) => d.id === st.district);
    if (!own) return null;
    // Nachbarbezirke als falsche Antworten – sonst wäre es zu leicht
    const center = (d: District) => {
      const sts = net.stations.filter((x) => x.district === d.id);
      return { lat: sts.reduce((a, x) => a + x.lat, 0) / sts.length, lon: sts.reduce((a, x) => a + x.lon, 0) / sts.length };
    };
    const others = net.districts
      .filter((d) => d.id !== own.id)
      .sort((a, b) => distM(center(a), st) - distM(center(b), st))
      .slice(0, 3);
    return {
      type: 'district',
      prompt: `In welchem Bezirk liegt ${st.name}?`,
      options: shuffle([own, ...others]).map((d) => ({ id: String(d.id), label: `${d.id}. ${d.name}` })),
      correct: String(own.id),
      explanation: `${st.name} liegt im ${own.id}. Bezirk (${own.name}).`,
      revealStationId: st.id,
    };
  },

  transfer(net, scope) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const line = pick(scope.lines);
      if (!line) return null;
      const main = mainPattern(net, line);
      // alle gemeinsamen Stationen je anderer Linie sammeln
      const byLine = new Map<string, Set<string>>();
      for (const id of main) {
        for (const other of net.station(id).lines) {
          const o = net.line(other);
          if (!o || o.id === line.id || !scope.modes.has(o.mode) || isSpecialLine(o) || !net.patterns(o).length || overlap(net, line, o) > 0.5) continue;
          byLine.set(o.id, (byLine.get(o.id) ?? new Set()).add(id));
        }
      }
      // nur eindeutige Umstiege (genau eine gemeinsame Station), bevorzugt zu U-/S-Bahn
      const unique = [...byLine.entries()].filter(([, ids]) => ids.size === 1).map(([o, ids]) => [o, [...ids]] as [string, string[]]);
      const rapid = unique.filter(([o]) => ['U', 'S'].includes(net.line(o)!.mode));
      if (!unique.length) continue;
      const choice = rapid.length && Math.random() < 0.7 ? rapid : unique;
      const [otherId, [stId]] = pick(choice);
      const other = net.line(otherId)!;
      // falsche Antworten von BEIDEN Linien – sonst verrät die Linie, die man kennt, die Lösung
      const uniqueByName = (ids: string[], seen: Set<string>) =>
        shuffle(ids)
          .map((id) => net.station(id))
          .filter((x) => !seen.has(x.name) && (seen.add(x.name), true));
      const seenNames = new Set([net.station(stId).name]);
      const xOnly = uniqueByName(main.filter((id) => !net.station(id).lines.includes(otherId)), seenNames);
      const yOnly = uniqueByName(mainPattern(net, other).filter((id) => !net.station(id).lines.includes(line.id)), seenNames);
      const nx = Math.random() < 0.5 ? 1 : 2;
      const wrong = [...xOnly.slice(0, nx), ...yOnly.slice(0, 3 - nx)];
      for (const extra of [...xOnly.slice(nx), ...yOnly.slice(3 - nx)]) if (wrong.length < 3) wrong.push(extra);
      if (wrong.length < 3) continue;
      const st = net.station(stId);
      return {
        type: 'transfer',
        prompt: `Wo kannst du von der ${line.id} in die ${other.id} umsteigen?`,
        chips: [line.id, other.id],
        drawLines: [line.id, other.id],
        options: shuffle([st, ...wrong]).map(stationOpt),
        correct: st.id,
        explanation: `Bei ${st.name} kreuzen sich ${line.id} und ${other.id}.`,
        revealLineId: line.id,
        revealStationId: st.id,
      };
    }
    return null;
  },

  draw(net, scope) {
    const cands = scope.lines.filter((l) => mainPattern(net, l).length >= 5);
    // bevorzugt U-Bahn, S-Bahn und Bim – 90 Buslinien nachzeichnen wäre zäh
    const rail = cands.filter((l) => l.mode === 'U' || l.mode === 'S' || l.mode === 'T');
    const line = pick(rail.length && Math.random() < 0.8 ? rail : cands);
    if (!line) return null;
    const main = mainPattern(net, line);
    const a = net.station(main[0]);
    const b = net.station(main[main.length - 1]);
    return {
      type: 'draw',
      prompt: `Zeichne die ${line.id} von ${a.name} nach ${b.name}`,
      chips: [line.id],
      markers: [a.id, b.id],
      correct: main.map((id) => [net.station(id).lat, net.station(id).lon] as LatLon),
      tolM: line.mode === 'U' || line.mode === 'S' ? 600 : 350,
      explanation: `So fährt die ${line.id}: ${a.name} → ${b.name} (${main.length} Stationen).`,
      revealLineId: line.id,
    };
  },

  uCross(net, scope) {
    const us = scope.lines.filter((l) => l.mode === 'U');
    const others = scope.lines.filter((l) => l.mode !== 'U' && l.mode !== 'N');
    if (!us.length || !others.length) return null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const u = pick(us);
      const line = pick(others);
      const uMain = mainPattern(net, u);
      const byName = new Map(uMain.map((id) => [net.station(id).name, id]));
      const lineNames = new Set(net.patterns(line).flat().map((id) => net.station(id).name));
      // genau eine gemeinsame Station – sonst gäbe es mehrere richtige Antworten
      const shared = [...lineNames].filter((n) => byName.has(n));
      if (shared.length !== 1) continue;
      const st = net.station(byName.get(shared[0])!);
      // falsche Antworten: andere Stationen derselben U-Bahn in der Nähe, an denen die Linie nicht hält
      const idx = uMain.indexOf(st.id);
      const wrong = shuffle(uMain.filter((id, i) => id !== st.id && Math.abs(i - idx) <= 5 && !lineNames.has(net.station(id).name)))
        .slice(0, 3)
        .map((id) => net.station(id));
      if (wrong.length < 3) continue;
      return {
        type: 'uCross',
        prompt: `An welcher ${u.id}-Station kreuzt die ${line.id}?`,
        chips: [line.id, u.id],
        drawLineId: u.id,
        drawLines: [u.id, line.id],
        options: shuffle([st, ...wrong]).map(stationOpt),
        correct: st.id,
        explanation: `Die ${line.id} trifft die ${u.id} bei ${st.name}.`,
        revealStationId: st.id,
      };
    }
    return null;
  },

  uLink(net, scope) {
    const uIds = new Set(scope.lines.filter((l) => l.mode === 'U').map((l) => l.id));
    if (uIds.size < 2) return null;
    // je Linie: welche U-Bahnen sie trifft (erste Station je U-Bahn)
    const touches = (l: Line) => {
      const out = new Map<string, Station>();
      for (const id of mainPattern(net, l))
        for (const u of net.station(id).lines) if (uIds.has(u) && !out.has(u) && net.patterns(net.line(u)!).some((p) => p.includes(id))) out.set(u, net.station(id));
      return out;
    };
    const cands = scope.lines.filter((l) => l.mode !== 'U' && l.mode !== 'N');
    for (let attempt = 0; attempt < 40; attempt++) {
      const line = pick(cands);
      if (!line) return null;
      const t = touches(line);
      const pairs = [...t.keys()].flatMap((a, i, arr) => arr.slice(i + 1).map((b) => [a, b] as const)).filter(([a, b]) => t.get(a)!.name !== t.get(b)!.name);
      if (!pairs.length) continue;
      const [a, b] = pick(pairs);
      const [sa, sb] = [t.get(a)!, t.get(b)!];
      // falsche Antworten: Linien, die nur eine der beiden U-Bahnen treffen
      const wrong = shuffle(
        cands.filter((x) => {
          if (x === line) return false;
          const tx = touches(x);
          return (tx.has(a) || tx.has(b)) && !(tx.has(a) && tx.has(b));
        }),
      ).slice(0, 3);
      if (wrong.length < 3) continue;
      return {
        type: 'uLink',
        prompt: `Welche Linie verbindet die ${a} (${sa.name}) mit der ${b} (${sb.name})?`,
        markers: [sa.id, sb.id],
        drawLines: [a, b, line.id],
        options: shuffle([line, ...wrong]).map(lineOpt),
        correct: line.id,
        explanation: `Die ${line.id} fährt von ${sa.name} (${a}) bis ${sb.name} (${b}) – ohne Umweg über eine andere U-Bahn.`,
        revealLineId: line.id,
      };
    }
    return null;
  },

  towards(net, scope) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const st = pick(scope.stations);
      if (!st) return null;
      const here = linesAt(net, st, scope).filter((l) => l.mode !== 'N');
      if (here.length < 2) continue;
      const line = pick(here);
      // nur Hauptrichtungen (keine Kurzführungen), und die Station darf nicht schon Endstation sein
      const longest = Math.max(...net.patterns(line).map((p) => p.length));
      const pats = net.patterns(line).filter((p) => p.length >= longest * 0.75 && p.indexOf(st.id) >= 0 && p.indexOf(st.id) < p.length - 3);
      if (!pats.length) continue;
      const term = net.station(pick(pats).at(-1)!);
      /** fährt die Linie von hier (in irgendeiner Richtung) bis zum Ziel? */
      const reaches = (x: Line) =>
        net.patterns(x).some((p) => {
          const i = p.indexOf(st.id);
          return i >= 0 && p.slice(i + 1).some((id) => net.station(id).name === term.name);
        });
      const near = net.stations.filter((x) => x.id !== st.id && distM(x, st) < 500).flatMap((x) => linesAt(net, x, scope));
      const wrong = [...new Map([...shuffle(here), ...shuffle(near)].filter((x) => x !== line && x.mode !== 'N' && !reaches(x)).map((x) => [x.id, x])).values()].slice(0, 3);
      if (wrong.length < 2) continue;
      return {
        type: 'towards',
        prompt: `Du stehst bei ${st.name}. Welche Linie fährt von hier Richtung ${term.name}?`,
        stationId: st.id,
        options: shuffle([line, ...wrong]).map(lineOpt),
        correct: line.id,
        explanation: `Die ${line.id} fährt von ${st.name} nach ${term.name}.`,
        revealLineId: line.id,
      };
    }
    return null;
  },

  busArea(net, scope) {
    const buses = scope.lines.filter((l) => l.mode === 'B' && /^\d+[AB]$/.test(l.id) && parseInt(l.id, 10) >= 20);
    if (buses.length < 4 || !net.districts.length) return null;
    /** Bezirk mit den meisten Stationen dieser Linien */
    const topDistrict = (ls: Line[]) => {
      const c = new Map<number, number>();
      for (const l of ls) for (const id of new Set(net.patterns(l).flat())) c.set(net.station(id).district, (c.get(net.station(id).district) ?? 0) + 1);
      return [...c].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    const decade = (l: Line) => Math.floor(parseInt(l.id, 10) / 10);
    const line = pick(buses);
    const own = topDistrict([line]);
    const groupTop = topDistrict(buses.filter((b) => decade(b) === decade(line)));
    // falsche Antworten: die Hauptbezirke der anderen Zehnergruppen
    const decades = [...new Set(buses.map(decade))].filter((g) => g !== decade(line));
    const wrongIds = shuffle([...new Set(decades.map((g) => topDistrict(buses.filter((b) => decade(b) === g))))].filter((d) => d != null && d !== own)).slice(0, 3);
    if (own == null || wrongIds.length < 2) return null;
    const label = (id: number) => `${id}. ${net.districts.find((d) => d.id === id)?.name ?? ''}`;
    return {
      type: 'busArea',
      prompt: `In welchem Bezirk fährt der ${line.id} vor allem?`,
      chips: [line.id],
      options: shuffle([own, ...wrongIds]).map((id) => ({ id: String(id), label: label(id) })),
      correct: String(own),
      explanation:
        `Der ${line.id} fährt vor allem im ${label(own)}.` +
        (groupTop != null ? ` Faustregel: Die ${decade(line)}0er-Busse fahren meist im ${label(groupTop)}.` : ''),
      revealLineId: line.id,
    };
  },

  direct(net, scope) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const line = pick(scope.lines);
      if (!line) return null;
      const p = pick(net.patterns(line));
      if (p.length < 5) continue;
      const idxs = p.map((id, i) => (scope.stationSet.has(id) ? i : -1)).filter((i) => i >= 0);
      const i = pick(idxs.length ? idxs : p.map((_, k) => k));
      const j = Math.min(p.length - 1, i + 3 + Math.floor(Math.random() * Math.max(1, p.length / 3)));
      if (j - i < 3) continue;
      const a = net.station(p[i]);
      const b = net.station(p[j]);
      // falsche Antworten: Linien an A oder B, die NICHT direkt zwischen A und B fahren
      const near = [...new Set([...a.lines, ...b.lines])]
        .map((id) => net.line(id)!)
        .filter((l) => l && scope.modes.has(l.mode) && !connects(net, l, a.id, b.id));
      const fill = shuffle(scope.lines.filter((l) => !connects(net, l, a.id, b.id) && !near.includes(l)));
      const wrong = [...shuffle(near), ...fill].slice(0, 3);
      if (wrong.length < 3) continue;
      // keine andere Antwort darf ebenfalls passen
      if (wrong.some((l) => connects(net, l, a.id, b.id))) continue;
      return {
        type: 'direct',
        prompt: `Welche Linie fährt ohne Umsteigen von ${a.name} nach ${b.name}?`,
        markers: [a.id, b.id],
        options: shuffle([line, ...wrong]).map(lineOpt),
        correct: line.id,
        explanation: `Die ${line.id} fährt direkt von ${a.name} nach ${b.name} (${j - i} Stationen).`,
        revealLineId: line.id,
      };
    }
    return null;
  },
};

/** Fragen für ein ganzes Quiz – Typen nach eingestellter Häufigkeit, ohne direkte Wiederholungen */
export function generateQuiz(net: QuizNet, s: QuizSettings): QuizQuestion[] {
  const scope = quizScope(net, s);
  const types = QUIZ_TYPE_ORDER.filter((t) => FREQUENCY_WEIGHT[s.weights[t]] > 0);
  const out: QuizQuestion[] = [];
  const seenPrompts = new Set<string>();
  for (let guard = 0; out.length < s.questions && guard < s.questions * 30; guard++) {
    const total = types.reduce((a, t) => a + FREQUENCY_WEIGHT[s.weights[t]], 0);
    let r = Math.random() * total;
    let type = types[0];
    for (const t of types) if ((r -= FREQUENCY_WEIGHT[s.weights[t]]) <= 0) {
      type = t;
      break;
    }
    // nicht dreimal hintereinander derselbe Typ
    if (types.length > 1 && out.length >= 2 && out[out.length - 1].type === type && out[out.length - 2].type === type) continue;
    const q = GENERATORS[type](net, scope);
    if (!q) continue;
    // Wiederholung erkennen – auch bei gleichem Fragetext (z.B. „Welche Linie fährt diese Strecke?“ mit anderer Linie)
    const key = [q.prompt, q.drawLineId, q.stationId, q.markers?.join()].join('|');
    if (seenPrompts.has(key)) continue;
    seenPrompts.add(key);
    if (q.type === 'draw') q.timeSec = Math.max(s.timeSec * 2, 40);
    out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------- Bewertung

/** volle Punkte bis 250 m – wie „Wo liegt das?“ in der Routenjagd (Befund L-08) */
const LOCATE_FULL_M = 250;
const LOCATE_ZERO_M = 3000;

function toXY(p: LatLon, lat0: number): [number, number] {
  return [p[1] * 111_320 * Math.cos((lat0 * Math.PI) / 180), p[0] * 111_320];
}

/** Abstand eines Punkts zu einem Linienzug (Meter) */
export function distToPath(p: LatLon, path: LatLon[]): number {
  const [px, py] = toXY(p, p[0]);
  if (path.length === 1) {
    const [ax, ay] = toXY(path[0], p[0]);
    return Math.hypot(px - ax, py - ay);
  }
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = toXY(path[i], p[0]);
    const [bx, by] = toXY(path[i + 1], p[0]);
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/**
 * Linie zeichnen: Wie viele Stationen liegen nahe der Zeichnung (gemessen daran, was eine gerade
 * Linie Anfang→Ende schon "geschenkt" bekäme) – und liegen die getippten Punkte auf der Linie?
 */
export function gradeSketch(stations: LatLon[], taps: LatLon[], tolM: number): number {
  if (!taps.length) return 0;
  const a = stations[0];
  const b = stations[stations.length - 1];
  const inner = stations.slice(1, -1);
  if (!inner.length) return 1;
  const cover = (path: LatLon[]) => inner.filter((s) => distToPath(s, path) <= tolM).length / inner.length;
  const coverage = cover([a, ...taps, b]);
  const straight = cover([a, b]);
  // fast gerade Linie: dann ist die gerade Zeichnung eben richtig
  const shape = straight >= 0.9 ? coverage : Math.max(0, (coverage - straight) / (1 - straight));
  const precision = taps.filter((t) => distToPath(t, stations) <= tolM * 1.5).length / taps.length;
  return Math.max(0, Math.min(1, Math.min(shape, precision)));
}

/** Anteil richtig (0–1) */
export function gradeQuiz(q: QuizQuestion, answer: unknown): number {
  if (answer == null) return 0;
  if (q.type === 'draw') {
    if (!Array.isArray(answer)) return 0;
    return gradeSketch(q.correct as LatLon[], answer as LatLon[], q.tolM ?? 400);
  }
  if (q.type === 'locate') {
    if (!Array.isArray(answer) || answer.length !== 2) return 0;
    const [lat, lon] = answer.map(Number);
    const [clat, clon] = q.correct as LatLon;
    const d = distM({ lat, lon }, { lat: clat, lon: clon });
    return Math.max(0, Math.min(1, (LOCATE_ZERO_M - d) / (LOCATE_ZERO_M - LOCATE_FULL_M)));
  }
  if (q.multi) {
    if (!Array.isArray(answer)) return 0;
    const correct = new Set(q.correct as string[]);
    const picked = new Set(answer.map(String));
    let hits = 0;
    let wrong = 0;
    for (const id of picked) correct.has(id) ? hits++ : wrong++;
    return Math.max(0, (hits - wrong) / correct.size);
  }
  return String(answer) === q.correct ? 1 : 0;
}

/** Punkte: bis 1000; wer schneller richtig antwortet, bekommt mehr (mind. die Hälfte) */
export function quizPoints(base: number, elapsedMs: number, limitMs: number): number {
  const speed = Math.max(0, 1 - elapsedMs / limitMs);
  return Math.round(1000 * base * (0.5 + 0.5 * speed));
}
