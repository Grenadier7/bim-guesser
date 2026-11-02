// Strecke des Tages: für alle dieselbe Strecke, einmal am Tag (Wiener Zeit). Gewertet wie die Route in der
// Routenjagd (0–1300, ohne Zeitbonus). Mit Account: einmal spielen, Rangliste für Tag und Woche (auch nur Freunde).
// Die gezogene Strecke wird je Tag gespeichert, damit nach einem Neustart dieselbe gilt.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DailyBoard, DailyResult, DailyRound, GameSettings, RouteOption, Station } from '../shared/types.ts';
import { scoreRoute } from '../shared/rules.ts';
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
 * 1. Start und Ziel sind U-Bahn- oder S-Bahn-Stationen, 3–12 km auseinander → mit U + S kommt jeder hin.
 * 2. Die schnellste Verbindung hat mindestens einen Umstieg.
 * 3. Perfekt ist nicht offensichtlich: Nur mit U-Bahn und S-Bahn gibt es höchstens RAIL_MAX Punkte – die beste
 *    Verbindung nimmt also eine Bim oder einen Bus, oder eine geschickte Kombination ist klar schneller.
 * 4. Trotzdem machbar: Nur mit U-Bahn und S-Bahn gibt es mindestens RAIL_MIN Punkte.
 * 5. Abwechslung: Start und Ziel waren in den letzten 7 Tagen nicht schon dran.
 * Erfüllt nach vielen Versuchen keine Strecke alles, gilt die, die den Kriterien am nächsten kommt.
 */
export const RAIL_MIN = 350;
export const RAIL_MAX = 900;
const ATTEMPTS = 30;
const VARIETY_DAYS = 7;

/** Abstand zu den Kriterien 3 und 4 (0 = erfüllt) */
export function dailyPenalty(railPoints: number | null): number {
  if (railPoints == null) return 2000; // nur mit U + S gar nicht erreichbar
  if (railPoints > RAIL_MAX) return railPoints - RAIL_MAX;
  if (railPoints < RAIL_MIN) return RAIL_MIN - railPoints;
  return 0;
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

  /** schnellste Verbindung nur mit U-Bahn und S-Bahn (null = so nicht erreichbar) */
  private async railMin(from: string, to: string, time: number, q: RouteQuery): Promise<number | null> {
    const r = await topRoutes(this.net, from, to, time, { ...q, onlyModes: ['U', 'S'] });
    const best = r.find((x) => x.key !== 'walk');
    return best ? best.medianMin : null;
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
    // Abwechslung: Stationen der letzten Tage auslassen
    const recent = new Set(
      Object.entries(all)
        .filter(([d]) => d < day && d >= shift(day, -VARIETY_DAYS))
        .flatMap(([, p]) => [p.from, p.to]),
    );
    let best: (Today & { penalty: number }) | null = null;
    for (let attempt = 0; attempt < ATTEMPTS && !(best && best.penalty === 0); attempt++) {
      const [from, to] = this.net.randomPair(settings, recent, []);
      const routes = await topRoutes(this.net, from.id, to.id, time, { ...q, minTransfers: 1 });
      if (!routes.length || routes[0].key === 'walk') continue;
      if (routes[0].legs.filter((l) => l.mode !== 'W').length < 2) continue;
      const railMin = await this.railMin(from.id, to.id, time, q);
      const penalty = dailyPenalty(railMin == null ? null : scoreRoute(railMin, routes[0].medianMin));
      if (!best || penalty < best.penalty) best = { day, from, to, time, settings, routes, railMin, penalty };
    }
    if (!best) throw new GameError('Heute konnte keine Strecke gefunden werden – bitte später nochmal.', 502);
    this.save(day, best.from.id, best.to.id);
    const { penalty: _p, ...today } = best;
    return today;
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
