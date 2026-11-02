// Strecke des Tages: für alle dieselbe Strecke, einmal am Tag (Wiener Zeit). Gewertet wie die Route in der
// Routenjagd (0–1300, ohne Zeitbonus). Mit Account: einmal spielen, Rangliste für Tag und Woche (auch nur Freunde).
// Die gezogene Strecke wird je Tag gespeichert, damit nach einem Neustart dieselbe gilt.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DailyBoard, DailyResult, DailyRound, GameSettings, RouteOption, Station, StationRef } from '../shared/types.ts';
import { isWellKnownLine, scoreRoute } from '../shared/rules.ts';
import { viennaDay, weekStart } from '../shared/career.ts';
import type { Accounts } from './accounts.ts';
import { GameError } from './lobby.ts';
import type { Network } from './network.ts';
import { STATE_DIR } from './paths.ts';
import { EfaUnavailableError, evaluateUserRoute, topRoutes, type RouteQuery } from './routing.ts';
import { cleanLegs, sanitizeSettings } from './settings.ts';
import { describeSlotDate, slotTime } from './timeslots.ts';

/** Nr. 1 = erster Tag */
const FIRST_DAY = '2026-11-02';

/**
 * Kriterien – nicht einfach zufällig:
 * 1. Start und Ziel sind U-Bahn- oder S-Bahn-Stationen, 3–12 km auseinander.
 * 2. Die schnellste Verbindung hat mindestens einen Umstieg.
 * 3. Perfekt ist nicht offensichtlich: Nur mit bekannten Linien (U-Bahn, S-Bahn-Stammstrecke, S45, S80 – siehe
 *    isWellKnownLine) gibt es höchstens RAIL_MAX Punkte – die beste Verbindung nimmt also eine Bim, einen Bus oder eine
 *    wenig bekannte S-Bahn, oder eine geschickte Kombination ist klar schneller.
 * 4. Trotzdem machbar: Nur mit bekannten Linien gibt es mindestens RAIL_MIN Punkte.
 * 5. Abwechslung: Start und Ziel waren in den letzten 7 Tagen nicht schon dran.
 * Erfüllt nach vielen Versuchen keine Strecke alles, gilt die, die den Kriterien am nächsten kommt.
 */
export const RAIL_MIN = 350;
export const RAIL_MAX = 800;
const ATTEMPTS = 60;
const VARIETY_DAYS = 7;

/** Abstand zu den Kriterien 3 und 4 (0 = erfüllt) */
export function dailyPenalty(railPoints: number | null): number {
  if (railPoints == null) return 2000; // nur mit U + S gar nicht erreichbar
  if (railPoints > RAIL_MAX) return railPoints - RAIL_MAX;
  if (railPoints < RAIL_MIN) return RAIL_MIN - railPoints;
  return 0;
}

export interface DailyAttempt {
  from: string;
  to: string;
  bestMin: number | null;
  /** Fahrten der besten Verbindung (2 = ein Umstieg) */
  legs: number;
  railMin: number | null;
  railPoints: number | null;
  penalty: number | null;
  result: string;
}

export interface DailyPreview {
  day: string;
  from: StationRef;
  to: StationRef;
  when: string;
  routes: RouteOption[];
  rail: RouteOption | null;
  railPoints: number | null;
  criteriaMet: boolean;
  attempts: DailyAttempt[];
  /** an diesem Tag gespeicherte Strecke (die echte) */
  saved: { from: string; to: string } | null;
  rules: { railMin: number; railMax: number; varietyDays: number; attempts: number };
}

interface Today {
  day: string;
  from: Station;
  to: Station;
  time: number;
  settings: GameSettings;
  routes: RouteOption[];
  /** schnellste Verbindung nur mit U-Bahn und S-Bahn */
  railMin: number | null;
}

const dayNumber = (day: string) => Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${FIRST_DAY}T12:00:00Z`)) / 86_400_000) + 1;

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export class DailyService {
  private current: Promise<Today> | null = null;
  private currentDay = '';
  private file: string;
  private net: Network;
  private accounts: Accounts | null;

  constructor(net: Network, accounts: Accounts | null, opts: { file?: string; now?: () => number } = {}) {
    this.net = net;
    this.accounts = accounts;
    this.file = opts.file ?? path.join(STATE_DIR, 'daily.json');
    if (opts.now) this.now = opts.now;
  }

  private now = () => Date.now();

  /** Start/Ziel an U- und S-Bahn-Stationen, 3–12 km, Standard-Uhrzeit, Wartezeit am Start zählt */
  private settings(): GameSettings {
    return sanitizeSettings({ difficulty: 'medium', stations: ['U', 'S'], distance: 'medium', minTransfers: 1 });
  }

  /**
   * schnellste Verbindung nur mit bekannten Linien – U-Bahn, S-Bahn-Stammstrecke, S45, S80 (null = so nicht erreichbar).
   * Wenig bekannte S-Bahnen (S40, S50, S60 …) zählen wie eine Bim: Insiderwissen.
   */
  private async railRoute(from: string, to: string, time: number, q: RouteQuery): Promise<RouteOption | null> {
    const obscure = [...this.net.lines.values()].filter((l) => l.mode === 'S' && !isWellKnownLine(l)).map((l) => l.id);
    const r = await topRoutes(this.net, from, to, time, { ...q, onlyModes: ['U', 'S'], banned: obscure });
    return r.find((x) => x.key !== 'walk' && x.legs.every((l) => l.mode === 'W' || !l.line || l.line.split('/').some((id) => !obscure.includes(id)))) ?? null;
  }

  private async railMin(from: string, to: string, time: number, q: RouteQuery): Promise<number | null> {
    return (await this.railRoute(from, to, time, q))?.medianMin ?? null;
  }

  private query(s: GameSettings): RouteQuery {
    return { countWait: s.countWait, avgWait: s.avgWait, restriction: null };
  }

  private load(): Record<string, { from: string; to: string }> {
    try {
      return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    } catch {
      return {};
    }
  }

  private save(day: string, from: string, to: string) {
    const all = this.load();
    all[day] = { from, to };
    // nur die letzten Wochen behalten
    const keep = Object.fromEntries(Object.entries(all).filter(([d]) => d >= shift(day, -30)));
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(keep));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.warn('Strecke des Tages nicht gespeichert:', (e as Error).message);
    }
  }

  /** Strecke von heute (beim ersten Aufruf des Tages gezogen bzw. aus der Datei) */
  private today(): Promise<Today> {
    const day = viennaDay(this.now());
    if (this.current && this.currentDay === day) return this.current;
    this.currentDay = day;
    this.current = this.make(day).catch((e) => {
      this.current = null;
      if (e instanceof EfaUnavailableError) throw new GameError('Die Strecke des Tages konnte gerade nicht geladen werden – bitte gleich nochmal.', 503);
      throw e;
    });
    return this.current;
  }

  private async make(day: string): Promise<Today> {
    const settings = this.settings();
    const time = slotTime(settings.slot, settings.network, this.net.data.regularDays);
    const q = this.query(settings);
    const all = this.load();
    const saved = all[day];
    if (saved && this.net.stations.has(saved.from) && this.net.stations.has(saved.to)) {
      const routes = await topRoutes(this.net, saved.from, saved.to, time, q);
      if (routes.length)
        return { day, from: this.net.station(saved.from), to: this.net.station(saved.to), time, settings, routes, railMin: await this.railMin(saved.from, saved.to, time, q) };
    }
    const best = await this.draw(day, all, settings, time, q);
    if (!best) throw new GameError('Heute konnte keine Strecke gefunden werden – bitte später nochmal.', 502);
    this.save(day, best.from.id, best.to.id);
    const { penalty: _p, ...today } = best;
    return today;
  }

  /**
   * Strecke nach den Kriterien ziehen (siehe oben). `log` sammelt jeden Versuch – für das Testwerkzeug.
   */
  private async draw(day: string, all: Record<string, { from: string; to: string }>, settings: GameSettings, time: number, q: RouteQuery, log?: DailyAttempt[]) {
    // Abwechslung: Stationen der letzten Tage auslassen
    const recent = new Set(
      Object.entries(all)
        .filter(([d]) => d < day && d >= shift(day, -VARIETY_DAYS))
        .flatMap(([, p]) => [p.from, p.to]),
    );
    let best: (Today & { penalty: number }) | null = null;
    for (let attempt = 0; attempt < ATTEMPTS && !(best && best.penalty === 0); attempt++) {
      const [from, to] = this.net.randomPair(settings, recent, []);
      const entry: DailyAttempt = { from: from.name, to: to.name, bestMin: null, legs: 0, railMin: null, railPoints: null, penalty: null, result: '' };
      log?.push(entry);
      const routes = await topRoutes(this.net, from.id, to.id, time, { ...q, minTransfers: 1 });
      if (!routes.length || routes[0].key === 'walk') {
        entry.result = 'keine Verbindung';
        continue;
      }
      entry.bestMin = routes[0].medianMin;
      entry.legs = routes[0].legs.filter((l) => l.mode !== 'W').length;
      if (entry.legs < 2) {
        entry.result = 'ohne Umstieg';
        continue;
      }
      const railMin = await this.railMin(from.id, to.id, time, q);
      const railPoints = railMin == null ? null : scoreRoute(railMin, routes[0].medianMin);
      const penalty = dailyPenalty(railPoints);
      Object.assign(entry, { railMin, railPoints, penalty });
      entry.result =
        railPoints == null ? 'mit bekannten Linien nicht erreichbar' : railPoints > RAIL_MAX ? 'zu leicht (bekannte Linien fast perfekt)' : railPoints < RAIL_MIN ? 'zu schwer (bekannte Linien kaum Punkte)' : 'passt ✓';
      if (!best || penalty < best.penalty) best = { day, from, to, time, settings, routes, railMin, penalty };
    }
    return best;
  }

  /** Testwerkzeug (nur lokal mit --dev): neu ziehen, ohne zu speichern – mit allen Versuchen */
  async preview(dayIn?: string): Promise<DailyPreview> {
    const day = dayIn && /^\d{4}-\d{2}-\d{2}$/.test(dayIn) ? dayIn : viennaDay(this.now());
    const settings = this.settings();
    const time = slotTime(settings.slot, settings.network, this.net.data.regularDays);
    const q = this.query(settings);
    const all = this.load();
    const attempts: DailyAttempt[] = [];
    const best = await this.draw(day, all, settings, time, q, attempts);
    if (!best) throw new GameError('Keine Strecke gefunden.', 502);
    const saved = all[day];
    return {
      day,
      from: this.net.ref(best.from.id),
      to: this.net.ref(best.to.id),
      when: describeSlotDate(time),
      routes: best.routes.slice(0, 4),
      rail: await this.railRoute(best.from.id, best.to.id, time, q),
      railPoints: best.railMin == null ? null : scoreRoute(best.railMin, best.routes[0].medianMin),
      criteriaMet: best.penalty === 0,
      attempts,
      saved: saved && this.net.stations.has(saved.from) && this.net.stations.has(saved.to) ? { from: this.net.station(saved.from).name, to: this.net.station(saved.to).name } : null,
      rules: { railMin: RAIL_MIN, railMax: RAIL_MAX, varietyDays: VARIETY_DAYS, attempts: ATTEMPTS },
    };
  }

  async round(userId: number | null): Promise<DailyRound> {
    const t = await this.today();
    return {
      day: t.day,
      number: dayNumber(t.day),
      from: this.net.ref(t.from.id),
      to: this.net.ref(t.to.id),
      when: describeSlotDate(t.time),
      settings: t.settings,
      played: userId != null ? this.stored(t, userId) : null,
    };
  }

  private stored(t: Today, userId: number): DailyResult | null {
    const r = this.accounts?.dailyResult(userId, t.day);
    if (!r) return null;
    const d = r.data as Partial<DailyResult>;
    return {
      day: t.day,
      number: dayNumber(t.day),
      points: r.points,
      durationMin: r.minutes,
      bestMin: t.routes[0].medianMin,
      route: (d.route as RouteOption | null) ?? null,
      routes: t.routes.slice(0, 4),
      matchedRank: d.matchedRank ?? null,
      error: d.error ?? null,
      railMin: t.railMin,
      ...this.rankOf(t.day, userId),
    };
  }

  private rankOf(day: string, userId: number): { rank: number | null; players: number } {
    if (!this.accounts) return { rank: null, players: 0 };
    const b = this.accounts.dailyBoard([day], userId, false, 100_000);
    const me = b.rows.find((r) => r.me) ?? b.mine;
    return { rank: me?.rank ?? null, players: b.rows.length };
  }

  /** Route abgeben – mit Account nur einmal am Tag (danach kommt das gespeicherte Ergebnis) */
  async submit(rawLegs: unknown, userId: number | null): Promise<DailyResult> {
    const t = await this.today();
    if (userId != null) {
      const done = this.stored(t, userId);
      if (done) return done;
    }
    const legs = cleanLegs(rawLegs);
    if (!legs.length) throw new GameError('Gib mindestens eine Linie an.');
    let res;
    try {
      res = await evaluateUserRoute(this.net, legs, t.from.id, t.to.id, t.time, t.settings.network, this.query(t.settings), t.routes);
    } catch {
      throw new GameError('Die Route konnte gerade nicht ausgewertet werden – bitte gleich nochmal.', 503);
    }
    const best = t.routes[0].medianMin;
    const points = res.durationMin != null && !res.error ? scoreRoute(res.durationMin, best) : 0;
    const minutes = res.durationMin == null ? null : Math.round(res.durationMin);
    if (userId != null) this.accounts?.recordDaily(userId, t.day, points, minutes, { route: res.route, matchedRank: res.matchedRank, error: res.error }, legs, !res.error);
    return {
      day: t.day,
      number: dayNumber(t.day),
      points,
      durationMin: res.durationMin,
      bestMin: best,
      route: res.route,
      routes: t.routes.slice(0, 4),
      matchedRank: res.matchedRank,
      error: res.error,
      railMin: t.railMin,
      ...(userId != null ? this.rankOf(t.day, userId) : { rank: null, players: 0 }),
    };
  }

  board(scope: 'day' | 'week', friends: boolean, userId: number | null): DailyBoard {
    const today = viennaDay(this.now());
    const from = scope === 'week' ? weekStart(today) : today;
    const days: string[] = [];
    for (let d = from; d <= today; d = shift(d, 1)) days.push(d);
    const b = this.accounts ? this.accounts.dailyBoard(days, userId, friends && userId != null) : { rows: [], mine: null };
    return { scope, friends: friends && userId != null, from, ...b };
  }
}
