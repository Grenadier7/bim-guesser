// Trainingsmodus: einzelne Strecken ohne Lobby, ohne Punkte – mit Top-Verbindungen für den Coach.
import { randomBytes } from 'node:crypto';
import type { GameSettings, RouteOption, Station, TrainingResult, TrainingRound } from '../shared/types.ts';
import { GameError } from './game.ts';
import { cleanLegs, sanitizeSettings } from './settings.ts';
import { NoPairError, type Network, type PastPair } from './network.ts';
import { EfaUnavailableError, evaluateUserRoute, topRoutes, type RouteQuery } from './routing.ts';
import { describeSlotDate, slotTime } from './timeslots.ts';

interface Stored {
  from: Station;
  to: Station;
  time: number;
  settings: GameSettings;
  routes: RouteOption[];
  created: number;
  /** gewählte Linien schon für die Statistik gezählt (nur der erste gültige Versuch je Strecke) */
  counted?: boolean;
}

const MAX_ROUNDS = 2000;
const TTL_MS = 3 * 3600 * 1000;

export class TrainingService {
  private rounds = new Map<string, Stored>();
  /** zuletzt gezogene Strecken (für Abwechslung) */
  private recent: PastPair[] = [];
  private net: Network;
  /** Statistik der Admin-Seite: gewählte Linien */
  onLines?: (lines: string[]) => void;

  constructor(net: Network) {
    this.net = net;
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
  }

  private query(s: GameSettings): RouteQuery {
    return { countWait: s.countWait, avgWait: s.avgWait, restriction: null };
  }

  /** Neue Trainingsstrecke; optional ein bestimmtes Paar (Wiederholung) */
  async create(rawSettings: Partial<GameSettings> | undefined, pair?: { from?: unknown; to?: unknown }): Promise<TrainingRound> {
    try {
      return await this.createInner(rawSettings, pair);
    } catch (e) {
      if (e instanceof EfaUnavailableError) throw new GameError('Die Strecke konnte gerade nicht geladen werden – bitte gleich nochmal.', 503);
      if (e instanceof NoPairError) throw new GameError(e.message, 422);
      throw e;
    }
  }

  private async createInner(rawSettings: Partial<GameSettings> | undefined, pair?: { from?: unknown; to?: unknown }): Promise<TrainingRound> {
    const settings = sanitizeSettings(rawSettings);
    const time = slotTime(settings.slot, settings.network, this.net.data.regularDays);
    let from: Station | undefined;
    let to: Station | undefined;
    let routes: RouteOption[] = [];

    const fixed = pair && this.net.stations.get(String(pair.from)) && this.net.stations.get(String(pair.to));
    if (fixed) {
      from = this.net.station(String(pair!.from));
      to = this.net.station(String(pair!.to));
      if (from.id === to.id) throw new GameError('Start und Ziel sind dieselbe Station.');
      routes = await topRoutes(this.net, from.id, to.id, time, this.query(settings));
    } else {
      for (let attempt = 0; attempt < 14 && !routes.length; attempt++) {
        [from, to] = this.net.randomPair(settings, new Set(), this.recent);
        // wie im Spiel: Paare ohne genug Umstiege schon nach den Stichproben verwerfen
        const minTransfers = attempt < 12 ? settings.minTransfers : 0;
        const r = await topRoutes(this.net, from.id, to.id, time, { ...this.query(settings), minTransfers });
        if (!r.length || r[0].key === 'walk') continue;
        if (r[0].legs.filter((l) => l.mode !== 'W').length - 1 < settings.minTransfers && attempt < 12) continue;
        routes = r;
      }
    }
    if (!from || !to || !routes.length) throw new GameError('Keine passende Strecke gefunden – bitte nochmal versuchen.', 502);
    if (!fixed) {
      this.recent = [...this.recent.slice(-5), { a: from, b: to }];
      this.net.markUsed(from.id, to.id);
    }

    if (this.rounds.size >= MAX_ROUNDS) this.cleanup(true);
    const id = randomBytes(9).toString('base64url');
    this.rounds.set(id, { from, to, time, settings, routes, created: Date.now() });
    return { id, from: this.net.ref(from.id), to: this.net.ref(to.id), when: describeSlotDate(time), settings, routes };
  }

  /** beste Reisezeit der Strecke (für die Statistik) */
  bestMin(id: string): number | null {
    return this.rounds.get(String(id))?.routes[0]?.medianMin ?? null;
  }

  async evaluate(id: string, legs: unknown): Promise<TrainingResult> {
    const r = this.rounds.get(String(id));
    if (!r) throw new GameError('Trainingsrunde abgelaufen – bitte neue Strecke starten.', 404);
    let res;
    const clean = cleanLegs(legs);
    try {
      res = await evaluateUserRoute(this.net, clean, r.from.id, r.to.id, r.time, r.settings.network, this.query(r.settings), r.routes);
    } catch {
      throw new GameError('Die Route konnte gerade nicht ausgewertet werden – bitte gleich nochmal.', 503);
    }
    if (!res.error && !r.counted) {
      r.counted = true;
      try {
        this.onLines?.(clean.map((l) => l.line));
      } catch {
        /* Statistik darf nie stören */
      }
    }
    return { route: res.route, durationMin: res.durationMin, matchedRank: res.matchedRank, error: res.error };
  }

  private cleanup(force = false) {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, r] of this.rounds) if (r.created < cutoff) this.rounds.delete(id);
    if (force)
      for (const id of [...this.rounds.keys()].slice(0, Math.floor(MAX_ROUNDS / 4))) this.rounds.delete(id);
  }
}
