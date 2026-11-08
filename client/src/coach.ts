// Kurs-Tipp nach der Routenjagd: Aus den eigenen Runden lernen, welche Art Linie die schnelle Verbindung öfter
// gebraucht hätte (Busse, S-Bahn, Bims ins Zentrum …), und ab und zu den passenden Kurs vorschlagen. Wer insgesamt
// noch schwer tut und keinen Kurs gemacht hat, bekommt das Angebot, mit dem Lernpfad anzufangen.
//
// Wann: frühestens nach 2 Spielen, danach höchstens alle 3 Spiele und nicht öfter als einmal in 20 Stunden;
// ein mit „Später“ weggeklickter Kurs kommt 7 Tage lang nicht wieder. Nur Routenjagd ohne Tages-Challenge.
import type { Mode, RoundReveal } from '../../shared/types.ts';
import { GUERTEL, GUERTEL_RADIAL, OUTER, RADIAL_FAMILY, RADIAL_OTHER, RING_LINES, TANGENTIAL, TRANS_TANGENTIAL } from './learn/courses/common.ts';
import { loadJson, saveJson } from './storage.ts';

export const COACH_KEY = 'oeffi-coach-v1';
const KEEP_GAMES = 8;
const MIN_GAMES = 2;
const EVERY_GAMES = 3;
const PAUSE_MS = 20 * 3600_000;
const SNOOZE_MS = 7 * 24 * 3600_000;
/** unter diesen Routenpunkten (von 1000) war die Runde „daneben“ */
const POOR = 700;

export interface CoachGame {
  id: string;
  /** Ø Routenpunkte / 1000 */
  share: number;
  /** Kurs → Gewicht (wie oft die schnelle Verbindung Linien dieser Art brauchte, die man nicht nahm) */
  cats: Record<string, number>;
  /** Beispiel-Linien je Kurs */
  lines: Record<string, string[]>;
}
export interface CoachState {
  games: CoachGame[];
  sincePrompt: number;
  lastPrompt: number;
  snoozed: Record<string, number>;
}
export type CourseInfo = { id: string; done: boolean; mastered: boolean };
export type Suggestion = { kind: 'course'; course: string; lines: string[] } | { kind: 'start'; course: string };

const empty = (): CoachState => ({ games: [], sincePrompt: 0, lastPrompt: 0, snoozed: {} });
export const loadCoach = () => ({ ...empty(), ...loadJson<Partial<CoachState>>(COACH_KEY, {}) });
export const saveCoach = (s: CoachState) => saveJson(COACH_KEY, s);

/** Netz-Infos, die die Zuordnung braucht (im Browser aus NetIndex, in Tests von Hand) */
export interface LineLookup {
  mode(id: string): Mode | null;
  district(stationId: string): number | null;
}

/** Zu welchem Kurs gehört diese Linie? (Fahrt ab `from` – entscheidet bei Bims über die Gegend) */
export function courseOfLine(id: string, from: string | null, net: LineLookup): string | null {
  const mode = net.mode(id);
  if (!mode || mode === 'W') return null;
  if (mode === 'N' || /^N\d/.test(id)) return 'night';
  if (mode === 'U') return 'ubahn';
  if (mode === 'S') return 'sbahn';
  if (mode === 'B') return 'busnr';
  if (TRANS_TANGENTIAL.includes(id)) return 'danube';
  if (RADIAL_FAMILY.includes(id) || RADIAL_OTHER.includes(id)) return 'radial';
  if ([...RING_LINES, ...GUERTEL, ...OUTER, ...TANGENTIAL, ...GUERTEL_RADIAL].includes(id)) return 'ring';
  const d = from ? net.district(from) : null;
  if (d === 21 || d === 22) return 'danube';
  if (d === 10 || d === 11 || d === 12 || d === 23) return 'south';
  return 'radial';
}

/** Ein Spiel auswerten: Routenpunkte und welche Linien-Arten die schnelle Verbindung brauchte, die man ausließ */
export function analyzeGame(id: string, reveals: RoundReveal[], me: string, net: LineLookup): CoachGame | null {
  const cats: Record<string, number> = {};
  const lines: Record<string, string[]> = {};
  const shares: number[] = [];
  for (const rv of reveals) {
    if (rv.cancelled || !rv.routes[0]) continue;
    const ev = rv.evaluations.find((e) => e.playerId === me);
    if (!ev) continue;
    const pts = ev.route ? ev.score.route : 0;
    shares.push(pts / 1000);
    if (pts >= POOR) continue;
    const mine = new Set(ev.legs.map((l) => l.line));
    // nicht abgegeben: zählt halb (vielleicht nur die Zeit)
    const w = ev.route ? 1 : 0.5;
    const seen = new Set<string>();
    for (const leg of rv.routes[0].legs) {
      if (!leg.line || leg.mode === 'W') continue;
      const ids = leg.line.split('/');
      if (ids.some((x) => mine.has(x))) continue;
      const c = courseOfLine(ids[0], leg.fromStation, net);
      if (!c || seen.has(c)) continue;
      seen.add(c);
      cats[c] = (cats[c] ?? 0) + w;
      (lines[c] ??= []).includes(ids[0]) || lines[c].push(ids[0]);
    }
  }
  if (!shares.length) return null;
  return { id, share: shares.reduce((a, b) => a + b, 0) / shares.length, cats, lines };
}

/** Spiel merken (einmal je Spiel) – false, wenn es schon drin war */
export function addGame(s: CoachState, g: CoachGame): boolean {
  if (s.games.some((x) => x.id === g.id)) return false;
  s.games = [...s.games, g].slice(-KEEP_GAMES);
  s.sincePrompt++;
  return true;
}

/** Jetzt etwas vorschlagen? Kurse in Lernpfad-Reihenfolge */
export function suggest(s: CoachState, courses: CourseInfo[], now = Date.now()): Suggestion | null {
  if (s.games.length < MIN_GAMES) return null;
  if (s.lastPrompt && (s.sincePrompt < EVERY_GAMES || now - s.lastPrompt < PAUSE_MS)) return null;
  const free = (id: string) => now - (s.snoozed[id] ?? 0) >= SNOOZE_MS;
  // insgesamt schwach und noch kein Kurs gemacht → mit dem Lernpfad anfangen
  const recent = s.games.slice(-5);
  const avg = recent.reduce((a, g) => a + g.share, 0) / recent.length;
  const first = courses.find((c) => !c.done);
  if (avg < 0.45 && !courses.some((c) => c.done) && first && free(first.id)) return { kind: 'start', course: first.id };
  // sonst: die Art Linie, die zuletzt am öftesten gefehlt hat
  const weight: Record<string, number> = {};
  const lines: Record<string, string[]> = {};
  for (const g of s.games.slice(-6))
    for (const [c, w] of Object.entries(g.cats)) {
      weight[c] = (weight[c] ?? 0) + w;
      for (const l of g.lines[c] ?? []) (lines[c] ??= []).includes(l) || lines[c].push(l);
    }
  const pick = Object.entries(weight)
    .filter(([c, w]) => {
      const info = courses.find((x) => x.id === c);
      // gemachte Kurse nur, wenn es weiter deutlich hapert (und nie gemeisterte)
      return info && !info.mastered && free(c) && w >= (info.done ? 4 : 2);
    })
    .sort((a, b) => b[1] - a[1])[0];
  return pick ? { kind: 'course', course: pick[0], lines: (lines[pick[0]] ?? []).slice(-3).reverse() } : null;
}

/** Vorschlag gezeigt: Pause beginnt; „Später“ legt diesen Kurs eine Woche weg */
export function prompted(s: CoachState, course: string, later: boolean, now = Date.now()) {
  s.lastPrompt = now;
  s.sincePrompt = 0;
  if (later) s.snoozed[course] = now;
}

/** wofür der Kurs hilft – für den Tipp-Text */
export const TOPIC: Record<string, string> = {
  ubahn: 'die U-Bahn und ihre Umstiege',
  sbahn: 'die S-Bahn',
  radial: 'die Straßenbahnen ins Zentrum',
  ring: 'die Bims rund um die Stadt',
  danube: 'die Wege über die Donau',
  south: 'den Süden Wiens',
  busnr: 'die Busse',
  night: 'die Nachtlinien',
};
