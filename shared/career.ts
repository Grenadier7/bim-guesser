// Spielerfortschritt – für Gäste im Browser und für Accounts am Server gleich gerechnet:
// XP & Level, Serie (mit Joker-Tag), Wochenziel, Sammelkarte „Mein Wien“ und Medaillen in Stufen.
import type { LevelInfo, MedalPublic } from './types.ts';

// ---------------------------------------------------------------- Gespeicherter Stand (Browser, mit Account synchronisiert)

export const CAREER_KEY = 'oeffi-career-v1';

export interface CareerCounters {
  games: number;
  wins: number;
  rounds: number;
  /** Runden mit 1000+ Routenpunkten (so schnell wie die beste Verbindung) */
  perfect: number;
  /** schneller als die beste Verbindung */
  beat: number;
  quiz: number;
  quizAce: number;
  trainings: number;
  /** Runden zwischen 0 und 5 Uhr (Spielzeit) */
  night: number;
  /** Volltreffer im Blindflug (ohne Karte) */
  blindPerfect: number;
  /** Strecken des Tages */
  daily: number;
  /** nach Mitternacht (echte Uhrzeit) gespielt */
  lateNight: number;
}

export interface Career {
  /** XP aus Spielen ohne Account (mit Account zählt der Server; beim Anmelden werden sie übernommen) */
  xp: number;
  /** Aktivität je Tag (YYYY-MM-DD → Anzahl Spiele/Strecken), die letzten ~120 Tage */
  acts: Record<string, number>;
  /** längste Serie (Tage) */
  best: number;
  /** benutzte Linien und Stationen (eigene, gültige Routen) – Sammelkarte „Mein Wien“ */
  lines: string[];
  stations: string[];
  c: Partial<CareerCounters>;
}

export const emptyCareer = (): Career => ({ xp: 0, acts: {}, best: 0, lines: [], stations: [], c: {} });

// ---------------------------------------------------------------- XP & Level

/** XP je Ereignis – Server (Accounts) und Browser (Gäste) rechnen gleich */
export const XP = {
  round: (points: number) => 5 + points / 20,
  game: (won: boolean) => 20 + (won ? 30 : 0),
  quiz: (points: number, won: boolean) => 10 + points / 50 + (won ? 20 : 0),
  training: (good: boolean) => (good ? 20 : 10),
  daily: (points: number) => 15 + points / 20,
  course: 40,
  mastered: 60,
  tutorial: 50,
};

/** XP bis zum nächsten Level: 100, 150, 200, … */
export function levelOf(xp: number): LevelInfo {
  let level = 1;
  let start = 0;
  for (let need = 100; xp >= start + need; need += 50) {
    start += need;
    level++;
  }
  return { level, xp: Math.round(xp), levelXp: start, nextXp: start + 100 + 50 * (level - 1) };
}

// ---------------------------------------------------------------- Tage, Serie, Wochenziel

/** Datum in Wien als YYYY-MM-DD */
export const viennaDay = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' });

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Montag der Woche (ISO) */
export function weekStart(day: string): string {
  const wd = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return shift(day, -wd);
}

/** ein Joker je 7 Tage überbrückt einen verpassten Tag – so reißt eine lange Serie nicht wegen eines Tages */
export const JOKER_DAYS = 7;
/** Wochenziel: so viele Spiele/Strecken von Montag bis Sonntag */
export const WEEK_GOAL = 5;

export interface StreakInfo {
  /** Tage in Folge gespielt (Joker-Tage zählen nicht mit, halten die Serie aber) */
  days: number;
  /** heute schon gespielt? */
  today: boolean;
  /** Joker gerade verfügbar */
  jokerReady: boolean;
  /** an diesen Tagen hat der Joker die Serie gerettet */
  jokers: string[];
}

export function streakOf(acts: Record<string, number>, today = viennaDay()): StreakInfo {
  const active = (d: string) => (acts[d] ?? 0) > 0;
  const jokers: string[] = [];
  let days = 0;
  // heute noch nicht gespielt: die Serie lebt bis Mitternacht weiter
  let d = active(today) ? today : shift(today, -1);
  for (let guard = 0; guard < 800; guard++) {
    if (active(d)) {
      days++;
      d = shift(d, -1);
      continue;
    }
    const lastJoker = jokers.at(-1);
    const jokerFree = !lastJoker || dayDiff(d, lastJoker) >= JOKER_DAYS;
    if (days > 0 && jokerFree && active(shift(d, -1))) {
      jokers.push(d);
      d = shift(d, -1);
      continue;
    }
    // gestern verpasst, vorgestern gespielt: Joker hält die Serie, bis heute gespielt wird
    if (days === 0 && d === shift(today, -1) && active(shift(d, -1))) {
      jokers.push(d);
      d = shift(d, -1);
      continue;
    }
    break;
  }
  const recent = jokers.find((j) => dayDiff(j, today) < JOKER_DAYS);
  return { days, today: active(today), jokerReady: !recent, jokers };
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** Spiele/Strecken in dieser Woche (Mo–So) */
export function weekCount(acts: Record<string, number>, today = viennaDay()): number {
  const start = weekStart(today);
  let n = 0;
  for (let i = 0; i < 7; i++) n += acts[shift(start, i)] ?? 0;
  return n;
}

/** alte Tage weglassen (die Serie zählt `best` mit) */
export function trimActs(acts: Record<string, number>, today = viennaDay(), keep = 120): Record<string, number> {
  const min = shift(today, -keep);
  return Object.fromEntries(Object.entries(acts).filter(([d]) => d >= min));
}

// ---------------------------------------------------------------- Medaillen

/** Kennzahlen, aus denen die Medaillen berechnet werden */
export interface MedalStats {
  games: number;
  wins: number;
  perfect: number;
  beat: number;
  quizAce: number;
  trainings: number;
  /** Kurse geschafft + gemeistert (0–18) */
  courses: number;
  tutorial: number;
  friends: number;
  level: number;
  streak: number;
  stations: number;
  tramLines: number;
  tramTotal: number;
  night: number;
  daily: number;
  blindPerfect: number;
  lateNight: number;
}

interface MedalDef {
  id: string;
  icon: string;
  title: string;
  /** Text je Stufe (Ziel n) */
  text: (n: number) => string;
  /** Ziele für Bronze, Silber, Gold (eine Zahl = eine Stufe) */
  tiers: (s: MedalStats) => number[];
  value: (s: MedalStats) => number;
  /** erst sichtbar, wenn erreicht */
  hidden?: boolean;
}

const n = (x: number, one: string, many: string) => `${x.toLocaleString('de-AT')} ${x === 1 ? one : many}`;

export const MEDALS: MedalDef[] = [
  { id: 'games', icon: '🎫', title: 'Stammgast', text: (x) => `${n(x, 'Routenjagd', 'Routenjagden')} zu Ende gespielt`, tiers: () => [1, 10, 50], value: (s) => s.games },
  { id: 'perfect', icon: '🎯', title: 'Volltreffer', text: (x) => `${n(x, 'Runde', 'Runden')} so schnell wie die beste Verbindung`, tiers: () => [1, 10, 50], value: (s) => s.perfect },
  { id: 'beat', icon: '🧠', title: 'Schlauer als die Auskunft', text: (x) => `${n(x, 'Route', 'Routen')} schneller als die beste Verbindung`, tiers: () => [1, 5, 20], value: (s) => s.beat },
  { id: 'wins', icon: '🏆', title: 'Sieger', text: (x) => `${n(x, 'Spiel', 'Spiele')} gegen andere gewonnen`, tiers: () => [1, 10, 50], value: (s) => s.wins },
  { id: 'quiz-ace', icon: '🥇', title: 'Quiz-Ass', text: (x) => `${n(x, 'Quiz', 'Quiz-Spiele')} ohne Fehler`, tiers: () => [1, 5, 20], value: (s) => s.quizAce },
  { id: 'trainer', icon: '🏋', title: 'Trainingsfleißig', text: (x) => `${n(x, 'Trainingsstrecke', 'Trainingsstrecken')}`, tiers: () => [10, 50, 200], value: (s) => s.trainings },
  { id: 'courses', icon: '📚', title: 'Netzkenner', text: (x) => (x <= 9 ? `${n(x, 'Kurs', 'Kurse')} im Lernpfad geschafft` : `alle Kurse geschafft und ${x - 9} gemeistert`), tiers: () => [3, 9, 18], value: (s) => s.courses },
  { id: 'streak', icon: '🔥', title: 'Dranbleiber', text: (x) => `${x} Tage in Folge gespielt`, tiers: () => [3, 7, 30], value: (s) => s.streak },
  { id: 'daily', icon: '📅', title: 'Strecke des Tages', text: (x) => `an ${n(x, 'Tag', 'Tagen')} die Strecke des Tages gefahren`, tiers: () => [1, 7, 30], value: (s) => s.daily },
  { id: 'explorer', icon: '🗺️', title: 'Entdecker', text: (x) => `${n(x, 'Station', 'Stationen')} auf eigenen Routen benutzt`, tiers: () => [25, 100, 300], value: (s) => s.stations },
  {
    id: 'tram',
    icon: '🚋',
    title: 'Bim-Fan',
    text: (x) => `${n(x, 'Bim-Linie', 'Bim-Linien')} benutzt`,
    tiers: (s) => [5, 15, Math.max(16, s.tramTotal)],
    value: (s) => s.tramLines,
  },
  { id: 'night', icon: '🦉', title: 'Nachteule', text: (x) => `${n(x, 'Nachtrunde', 'Nachtrunden')} (0–5 Uhr) gespielt`, tiers: () => [1, 10, 50], value: (s) => s.night },
  { id: 'friends', icon: '🤝', title: 'Gesellig', text: (x) => n(x, 'Freund', 'Freunde'), tiers: () => [1, 3, 10], value: (s) => s.friends },
  { id: 'level', icon: '🚀', title: 'Aufsteiger', text: (x) => `Level ${x} erreicht`, tiers: () => [5, 10, 20], value: (s) => s.level },
  { id: 'tutorial', icon: '🎓', title: 'Angekommen', text: () => 'Tutorial geschafft', tiers: () => [1], value: (s) => s.tutorial },
  { id: 'blind', icon: '🙈', title: 'Blindflug', text: () => 'Volltreffer ganz ohne Karte', tiers: () => [1], value: (s) => s.blindPerfect, hidden: true },
  { id: 'late', icon: '🌙', title: 'Geisterstunde', text: () => 'nach Mitternacht eine Runde gespielt', tiers: () => [1], value: (s) => s.lateNight, hidden: true },
];

export const TIER_NAMES = ['Bronze', 'Silber', 'Gold'];

/** Medaillen mit erreichter Stufe; `got` = Zeitpunkte erreichter Stufen ("id:stufe" → ms) */
export function medalList(s: MedalStats, got: Map<string, number> = new Map()): MedalPublic[] {
  return MEDALS.map((m) => {
    const tiers = m.tiers(s);
    const value = m.value(s);
    const tier = tiers.filter((t) => value >= t).length;
    const next = tier < tiers.length ? tiers[tier] : null;
    return {
      id: m.id,
      icon: m.icon,
      title: m.title,
      text: m.text(next ?? tiers[tiers.length - 1]),
      tier,
      tiers: tiers.length,
      value,
      next,
      hidden: !!m.hidden,
      at: tier ? (got.get(`${m.id}:${tier}`) ?? null) : null,
    };
  });
}

/** erreichte Stufen als Schlüssel ("id:stufe") – für „neu erreicht“-Meldungen und die Datenbank */
export const reachedKeys = (ms: MedalPublic[]) => ms.flatMap((m) => Array.from({ length: m.tier }, (_, i) => `${m.id}:${i + 1}`));
