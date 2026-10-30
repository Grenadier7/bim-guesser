// Routenjagd – Spiellogik komplett serverseitig. Jedes Spiel ist eine Lobby mit Code;
// Singleplayer ist einfach eine Lobby mit einem Spieler.
import type {
  Evaluation,
  GameSettings,
  GameState,
  NetMode,
  Guesses,
  Restriction,
  RoundPublic,
  RoundReveal,
  RouteOption,
  Station,
  TipKind,
  TipResult,
  UserLeg,
} from '../shared/types.ts';
import {
  RESTRICTION_CHANCE,
  roundLimitSec,
  baseLimitSec,
  TIPS,
  computeScore,
  routeCost,
  routeCostOf,
  sortRoutes,
  transfersOf,
  difficultyMultiplier,
  scoreRoute,
  linePatterns,
} from '../shared/rules.ts';
import { distM, NoPairError, type Network, type PastPair } from './network.ts';
import { EfaUnavailableError, evaluateUserRoute, topRoutes, type RouteQuery } from './routing.ts';
import { DEADLINE_GRACE_MS, GameError, Lobby } from './lobby.ts';
import { describeSlotDate, slotTime } from './timeslots.ts';
import { cleanLegs, sanitizeSettings, validLatLon } from './settings.ts';

export { GameError };

interface Submission {
  legs: UserLeg[];
  guesses: Guesses | null;
  elapsedSec: number;
}

interface Round {
  index: number;
  from: Station | null;
  to: Station | null;
  time: number;
  restriction: Restriction | null;
  bannedLines: string[];
  limitSec: number | null;
  ready: Promise<RouteOption[]>;
  routes: RouteOption[] | null;
  status: 'preparing' | 'open' | 'revealed';
  submissions: Map<string, Submission>;
  tips: Map<string, Set<TipKind>>;
  reveal: RoundReveal | null;
  startedAt: number | null;
  deadline: number | null;
  timer: NodeJS.Timeout | null;
  /** Pause durch den Host */
  pausedAt: number | null;
  pausedTotalMs: number;
}

export class Game extends Lobby {
  readonly mode = 'route' as const;
  settings: GameSettings;
  currentRound = -1;
  private rounds: Round[] = [];
  private usedStations = new Set<string>();
  /** bisherige Strecken dieses Spiels – neue sollen woanders liegen */
  private pastPairs: PastPair[] = [];
  private generation = 0;
  private net: Network;
  /** Netz zur Netz-Auswahl (Netzpläne der Admin-Seite) – gewählt beim Spielstart */
  private netFor: (mode: NetMode) => Network;

  constructor(id: string, net: Network | ((mode: NetMode) => Network), settings: Partial<GameSettings> | undefined) {
    super(id);
    this.netFor = typeof net === 'function' ? net : () => net;
    this.settings = sanitizeSettings(settings);
    this.net = this.netFor(this.settings.network);
  }

  protected onPresenceChange() {
    const round = this.rounds[this.currentRound];
    if (round?.status === 'open') this.background(this.maybeReveal(round));
  }

  // -------------------------------------------------------------- Lobby

  updateSettings(token: string, s: unknown) {
    this.requireHost(token);
    if (this.phase !== 'lobby') throw new GameError('Einstellungen nur in der Lobby änderbar.');
    this.settings = sanitizeSettings(s as Partial<GameSettings>, this.settings);
    this.touch();
    this.emitState();
  }

  backToLobby(token: string) {
    this.requireHost(token);
    for (const r of this.rounds) if (r.timer) clearTimeout(r.timer);
    this.generation++;
    this.phase = 'lobby';
    this.currentRound = -1;
    this.rounds = [];
    this.usedStations.clear();
    this.pastPairs = [];
    for (const p of this.players.values()) p.score = 0;
    this.touch();
    this.emitState();
  }

  // -------------------------------------------------------------- Ablauf

  async start(token: string): Promise<void> {
    this.requireHost(token);
    if (this.phase !== 'lobby') return;
    this.net = this.netFor(this.settings.network);
    this.phase = 'playing';
    for (const p of this.players.values()) p.score = 0;
    const gen = ++this.generation;
    const restrictions = this.pickRestrictions();
    // Runden nacheinander im Hintergrund vorbereiten (schont die API)
    let chain: Promise<unknown> = Promise.resolve();
    for (let i = 0; i < this.settings.rounds; i++) {
      const round = this.createRound(i, restrictions[i]);
      this.rounds.push(round);
      round.ready = chain.then(() => this.prepare(round, gen));
      round.ready.catch(() => {});
      chain = round.ready.catch(() => {});
    }
    this.emitState();
    await this.openRound(0, gen);
  }

  private pickRestrictions(): (Restriction | null)[] {
    const n = this.settings.rounds;
    const out: (Restriction | null)[] = Array(n).fill(null);
    if (this.settings.restrictions === 'never') return out;
    // "Linie gesperrt" doppelt gewichtet – die ist am abwechslungsreichsten
    const kinds: Restriction[] = ['noU', 'noBus', 'oneTransfer', 'banLines', 'banLines'];
    const pick = () => kinds[Math.floor(Math.random() * kinds.length)];
    if (this.settings.restrictions === 'always') return out.map(() => pick());
    for (let i = 0; i < n; i++) if (Math.random() < RESTRICTION_CHANCE) out[i] = pick();
    if (!out.some(Boolean)) out[Math.floor(Math.random() * n)] = pick();
    return out;
  }

  async next(token: string): Promise<void> {
    this.requireHost(token);
    const cur = this.rounds[this.currentRound];
    if (this.phase !== 'playing' || !cur || cur.status !== 'revealed') throw new GameError('Runde ist noch nicht aufgelöst.');
    if (this.currentRound + 1 >= this.rounds.length) {
      this.finishGame();
      this.touch();
      this.emitState();
      return;
    }
    await this.openRound(this.currentRound + 1, this.generation);
  }

  private createRound(index: number, restriction: Restriction | null): Round {
    return {
      index,
      from: null,
      to: null,
      time: slotTime(this.settings.slot, this.settings.network, this.net.data.regularDays),
      restriction,
      bannedLines: [],
      limitSec: roundLimitSec(baseLimitSec(this.settings), restriction),
      ready: Promise.resolve([]),
      routes: null,
      status: 'preparing',
      submissions: new Map(),
      tips: new Map(),
      reveal: null,
      startedAt: null,
      deadline: null,
      timer: null,
      pausedAt: null,
      pausedTotalMs: 0,
    };
  }

  private query(round: Round): RouteQuery {
    return { countWait: this.settings.countWait, avgWait: this.settings.avgWait, restriction: round.restriction, banned: round.bannedLines };
  }

  /** Für "Linie gesperrt": eine Linie der schnellsten Verbindung sperren (U-Bahn bevorzugt) */
  private pickBan(best: RouteOption): string[] {
    const pt = best.legs.filter((l) => l.mode !== 'W' && l.line);
    const order = ['U', 'S', 'T', 'B', 'N'];
    const leg = [...pt].sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode))[0];
    if (!leg) return [];
    const ids = new Set(leg.line!.split('/').filter((id) => this.net.lines.has(id)));
    // bei gleichwertigen Linien alle sperren – auch die, die in der Stichprobe zufällig nicht vorkamen
    // (S1 und S2 fahren beide Siemensstraße → Matzleinsdorfer Platz: nur die S2 zu sperren wäre keine Einschränkung)
    if (leg.mode !== 'U' && leg.fromStation && leg.toStation)
      for (const l of this.net.lines.values()) {
        if (l.mode !== leg.mode) continue;
        if (linePatterns(l, this.settings.network).some((p) => p.indexOf(leg.fromStation!) >= 0 && p.indexOf(leg.toStation!) > p.indexOf(leg.fromStation!))) ids.add(l.id);
      }
    return [...ids];
  }

  /** Mindest-Umstiege, die mit der Einschränkung überhaupt gehen („max. 1 Umstieg“ verträgt keine 2) */
  private minTransfersFor(round: Round): number {
    return round.restriction === 'oneTransfer' ? Math.min(1, this.settings.minTransfers) : this.settings.minTransfers;
  }

  /** Stationspaar ziehen und Top-Verbindungen sampeln; ungeeignete Paare werden verworfen */
  private async prepare(round: Round, gen: number): Promise<RouteOption[]> {
    const wanted = this.minTransfersFor(round);
    for (let attempt = 0; attempt < 14; attempt++) {
      if (gen !== this.generation) return [];
      let a: Station, b: Station;
      try {
        [a, b] =
          this.settings.endpoints === 'addresses' && this.net.hasAddresses
            ? this.net.randomAddressPair(this.settings, this.pastPairs)
            : this.net.randomPair(this.settings, this.usedStations, this.pastPairs);
      } catch (e) {
        if (e instanceof NoPairError) throw new GameError(e.message, 422);
        throw e;
      }
      let routes: RouteOption[];
      try {
        if (round.restriction === 'banLines') {
          // erst normal rechnen, dann eine Linie der schnellsten Verbindung sperren und neu rechnen
          round.bannedLines = [];
          const free = await topRoutes(this.net, a.id, b.id, round.time, { ...this.query(round), sampleOnly: true });
          if (!free.length || free[0].key === 'walk') continue;
          round.bannedLines = this.pickBan(free[0]);
          if (!round.bannedLines.length) continue;
          // nur sperren, wenn es in der Stichprobe eine Verbindung ohne die gesperrten Linien gibt –
          // sonst findet die zweite Rechnung nichts (früher häufiger Grund für „Keine passende Strecke“)
          const banned = new Set(round.bannedLines);
          if (!free.some((r) => r.key !== 'walk' && !r.legs.some((l) => l.line?.split('/').some((x) => banned.has(x))))) continue;
        }
        // bei "beste Route" nach Zeit + Umstiegen sortieren – routes[0] ist dann die beste (auch für Tipps)
        // Mindest-Umstiege schon nach den Stichproben prüfen (nach vielen Versuchen gelockert, siehe unten)
        const minTransfers = attempt < 12 ? wanted : 0;
        routes = sortRoutes(await topRoutes(this.net, a.id, b.id, round.time, { ...this.query(round), minTransfers }), this.settings);
      } catch (e) {
        if (e instanceof EfaUnavailableError) throw new GameError('Die Runde konnte gerade nicht vorbereitet werden – bitte in einer Minute nochmal starten.', 503);
        throw e;
      }
      if (!routes.length || routes[0].key === 'walk') continue;
      const ptLegs = routes[0].legs.filter((l) => l.mode !== 'W').length;
      // beste Verbindung muss mindestens so viele Umstiege haben (nach vielen Versuchen gelockert)
      if (ptLegs - 1 < wanted && attempt < 12) continue;
      this.usedStations.add(a.id).add(b.id);
      this.pastPairs.push({ a, b });
      if (!this.net.isAddress(a.id)) this.net.markUsed(a.id, b.id);
      round.from = a;
      round.to = b;
      round.routes = routes;
      return routes;
    }
    throw new GameError('Keine passende Strecke gefunden – bitte nochmal starten oder die Einstellungen ändern.', 502);
  }

  private async openRound(i: number, gen: number) {
    this.currentRound = i;
    const round = this.rounds[i];
    this.emitState();
    try {
      await round.ready;
    } catch {
      // ein zweiter Versuch (z.B. kurzer Aussetzer der Auskunft)
      if (gen !== this.generation) return;
      round.ready = this.prepare(round, gen);
      try {
        await round.ready;
      } catch (e) {
        if (gen !== this.generation) return;
        if (i === 0) {
          // noch nichts gespielt: zurück in die Lobby
          this.phase = 'lobby';
          this.rounds = [];
          this.currentRound = -1;
        } else {
          // gespielte Runden und Punkte behalten: Spiel endet nach der letzten aufgelösten Runde (Befund H-02)
          this.generation++; // Vorbereitung weiterer Runden im Hintergrund abbrechen
          this.rounds = this.rounds.slice(0, i);
          this.currentRound = i - 1;
          this.finishGame();
          this.touch();
        }
        this.emitState();
        if (i > 0 && e instanceof GameError) throw new GameError(`${e.message} Das Spiel endet deshalb nach Runde ${i}.`, e.status);
        throw e;
      }
    }
    if (gen !== this.generation) return;
    round.status = 'open';
    round.startedAt = Date.now();
    const limit = round.limitSec;
    if (limit) {
      round.deadline = round.startedAt + limit * 1000;
      this.armTimer(round);
    }
    this.touch();
    this.emitState();
  }

  private armTimer(round: Round) {
    if (round.timer) clearTimeout(round.timer);
    round.timer = null;
    if (!round.deadline) return;
    round.timer = setTimeout(() => {
      if (round.status === 'open' && !round.pausedAt) this.background(this.reveal(round));
    }, Math.max(0, round.deadline - Date.now()) + DEADLINE_GRACE_MS);
    round.timer.unref();
  }

  // -------------------------------------------------------------- Host-Steuerung

  /** Zeit anhalten: Countdown steht, Abgaben und Tipps sind gesperrt */
  pause(token: string) {
    this.requireHost(token);
    const round = this.openRoundAt(this.currentRound);
    if (round.pausedAt) return;
    round.pausedAt = Date.now();
    if (round.timer) clearTimeout(round.timer);
    round.timer = null;
    this.touch();
    this.emitState();
  }

  resume(token: string) {
    this.requireHost(token);
    const round = this.openRoundAt(this.currentRound);
    if (!round.pausedAt) return;
    const paused = Date.now() - round.pausedAt;
    round.pausedTotalMs += paused;
    if (round.deadline) round.deadline += paused;
    round.pausedAt = null;
    this.armTimer(round);
    this.touch();
    this.emitState();
  }

  /** Runde abbrechen: Lösung wird gezeigt, niemand bekommt Punkte */
  cancelRound(token: string) {
    this.requireHost(token);
    const round = this.openRoundAt(this.currentRound);
    if (round.timer) clearTimeout(round.timer);
    round.timer = null;
    round.pausedAt = null;
    round.reveal = { index: round.index, routes: round.routes ?? [], evaluations: [], cancelled: true };
    round.status = 'revealed';
    this.revealing.set(`${this.generation}:${round.index}`, Promise.resolve(round.reveal));
    this.touch();
    this.emitEvent({ type: 'revealed', reveal: round.reveal });
    this.emitState();
  }

  // -------------------------------------------------------------- Tipps

  async tip(token: string, roundIdx: number, kind: TipKind): Promise<TipResult> {
    const playerId = this.auth(token).id;
    if (this.settings.tips === 'off') throw new GameError('Tipps sind in dieser Lobby deaktiviert.');
    const round = this.openRoundAt(roundIdx);
    if (typeof kind !== 'string' || !Object.hasOwn(TIPS, kind)) throw new GameError('Unbekannter Tipp');
    if (round.pausedAt) throw new GameError('Die Runde ist gerade pausiert.', 409);
    if (round.submissions.has(playerId)) throw new GameError('Schon abgegeben');
    const used = round.tips.get(playerId) ?? new Set();
    used.add(kind);
    round.tips.set(playerId, used);
    this.touch();
    return this.tipResult(round, kind);
  }

  /** Bereits genutzte Tipps (z.B. nach Neuladen der Seite) */
  tipResults(token: string, roundIdx: number): TipResult[] {
    const playerId = this.auth(token).id;
    const round = this.rounds[roundIdx];
    if (!round?.routes) return [];
    return [...(round.tips.get(playerId) ?? [])].map((k) => this.tipResult(round, k));
  }

  private tipResult(round: Round, kind: TipKind): TipResult {
    const best = round.routes![0];
    const pt = best.legs.filter((l) => l.mode !== 'W');
    if (kind === 'modeChain') return { kind, modes: pt.map((l) => l.mode), transfers: Math.max(0, pt.length - 1), medianMin: best.medianMin };
    if (kind === 'transfers') {
      // X-treme "ohne Namen": keine Stationsnamen – nur von welcher in welche Linie umgestiegen wird
      const hide = this.settings.xtreme === 'noNames';
      const tipLine = (l: (typeof pt)[number]) => ({ id: l.line ?? '?', mode: l.mode, color: l.color });
      const stops = pt.slice(0, -1).map((l, i) => {
        const st = l.toStation ? this.net.station(l.toStation) : null;
        const p = l.path[l.path.length - 1];
        return { name: hide ? '' : (st?.name ?? l.toName), lat: st?.lat ?? p[0], lon: st?.lon ?? p[1], from: tipLine(l), to: tipLine(pt[i + 1]) };
      });
      return { kind, stops };
    }
    const station = kind === 'startLines' ? round.from! : round.to!;
    // Nachtlinien nur bei der Nacht-Uhrzeit – tagsüber fahren sie nicht (Befund L-13)
    const night = this.settings.slot === 'sa02';
    const lines = this.net
      .linesAt(station.id, this.settings.network)
      .filter((l) => night || l.mode !== 'N')
      .map((l) => ({ id: l.id, mode: l.mode, color: l.color }));
    return { kind, station: this.settings.xtreme === 'noNames' ? '' : station.name, lines };
  }

  // -------------------------------------------------------------- Abgabe & Auflösung

  async submit(token: string, roundIdx: number, legs: unknown, guesses: Guesses | null): Promise<RoundReveal | null> {
    const playerId = this.auth(token).id;
    const round = this.openRoundAt(roundIdx);
    if (round.submissions.has(playerId)) throw new GameError('Schon abgegeben');
    if (this.revealing.has(`${this.generation}:${round.index}`)) throw new GameError('Die Runde wird gerade ausgewertet.', 409);
    const now = Date.now();
    if (round.deadline && now > round.deadline + DEADLINE_GRACE_MS) throw new GameError('Zeit abgelaufen');
    if (round.pausedAt) throw new GameError('Die Runde ist gerade pausiert.', 409);
    // benötigte Zeit ohne Pausen, höchstens das Zeitlimit
    const elapsedMs = Math.min(now - round.startedAt! - round.pausedTotalMs, (round.limitSec ?? Infinity) * 1000);
    round.submissions.set(playerId, {
      legs: cleanLegs(legs),
      guesses: guesses && typeof guesses === 'object' ? { from: validLatLon(guesses.from), to: validLatLon(guesses.to) } : null,
      elapsedSec: Math.round(elapsedMs / 100) / 10,
    });
    this.touch();
    this.emitEvent({ type: 'submitted', round: roundIdx, playerId });
    this.emitState();
    return this.maybeReveal(round);
  }

  /** Host löst die Runde vorzeitig auf (z.B. wenn jemand hängt) */
  forceReveal(token: string, roundIdx: number): Promise<RoundReveal> {
    this.requireHost(token);
    return this.reveal(this.openRoundAt(roundIdx));
  }

  private maybeReveal(round: Round): Promise<RoundReveal> | null {
    const waiting = [...this.players.values()].filter((p) => !round.submissions.has(p.id) && this.isConnected(p));
    if (waiting.length || round.submissions.size === 0) return null;
    return this.reveal(round);
  }

  private revealing = new Map<string, Promise<RoundReveal>>();

  /** Auflösung ohne wartenden Request (Zeitablauf, Spieler geht): Fehler nur loggen – nie den Prozess beenden */
  private background(p: Promise<unknown> | null) {
    p?.catch((e) => console.error(`[${new Date().toISOString()}] Auflösung in Lobby ${this.id} fehlgeschlagen:`, e));
  }

  /** Eine Spieler-Route nachrechnen; fällt die Auskunft aus, ist nur diese Route betroffen (nicht die ganze Runde) */
  private async evaluate(round: Round, legs: UserLeg[], q: RouteQuery, routes: RouteOption[]) {
    try {
      return await evaluateUserRoute(this.net, legs, round.from!.id, round.to!.id, round.time, this.settings.network, q, routes);
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] Route in Lobby ${this.id} nicht auswertbar: ${(e as Error).message}`);
      return {
        route: null,
        durationMin: null,
        matchedRank: null,
        source: 'none' as const,
        error: 'Deine Route konnte gerade nicht ausgewertet werden.',
      };
    }
  }

  private reveal(round: Round): Promise<RoundReveal> {
    const gen = this.generation;
    const key = `${gen}:${round.index}`;
    let p = this.revealing.get(key);
    if (p) return p;
    if (round.timer) clearTimeout(round.timer);
    p = (async () => {
      const routes = round.routes!;
      const best = routeCostOf(routes[0], this.settings);
      const q = this.query(round);
      const players = [...this.players.values()];
      const evaluations = await Promise.all(
        players.map(async (pl): Promise<Evaluation> => {
          const sub = round.submissions.get(pl.id);
          const tips = [...(round.tips.get(pl.id) ?? [])];
          const locateDist =
            this.settings.locate && sub?.guesses
              ? {
                  from: sub.guesses.from ? Math.round(distM({ lat: sub.guesses.from[0], lon: sub.guesses.from[1] }, round.from!)) : null,
                  to: sub.guesses.to ? Math.round(distM({ lat: sub.guesses.to[0], lon: sub.guesses.to[1] }, round.to!)) : null,
                }
              : null;
          const r = sub?.legs.length
            ? await this.evaluate(round, sub.legs, q, routes)
            : { route: null, durationMin: null, matchedRank: null, source: 'none' as const, error: sub ? 'Keine Route angegeben.' : 'Nicht rechtzeitig abgegeben.' };
          const costMin = r.durationMin == null ? null : routeCost(r.durationMin, r.route ? transfersOf(r.route) : 0, this.settings);
          const score = computeScore({
            routePoints: costMin == null ? 0 : scoreRoute(costMin, best),
            tips,
            elapsedSec: sub?.legs.length ? sub.elapsedSec : null,
            limitSec: round.limitSec,
            locateDist,
            multiplier: difficultyMultiplier(this.settings),
            tipLevel: this.settings.tips,
          });
          return {
            playerId: pl.id,
            playerName: pl.name,
            legs: sub?.legs ?? [],
            ...r,
            costMin,
            elapsedSec: sub?.elapsedSec ?? null,
            timedOut: !sub,
            tips,
            guesses: sub?.guesses ?? null,
            locateDist,
            score,
          };
        }),
      );
      evaluations.sort((a, b) => b.score.total - a.score.total);
      // während der Auswertung abgebrochen oder zurück in die Lobby: keine Punkte vergeben
      if (gen !== this.generation || round.status !== 'open') return round.reveal ?? { index: round.index, routes, evaluations: [], cancelled: true };
      for (const ev of evaluations) {
        const pl = this.players.get(ev.playerId);
        if (pl) pl.score += ev.score.total;
      }
      round.reveal = { index: round.index, routes, evaluations, cancelled: false };
      round.status = 'revealed';
      this.touch();
      this.emitEvent({ type: 'revealed', reveal: round.reveal });
      this.emit('roundResult', round.reveal);
      this.emitState();
      return round.reveal;
    })();
    this.revealing.set(key, p);
    // fehlgeschlagen → nicht merken, sonst scheitert jede weitere Auflösung dieser Runde
    p.catch(() => this.revealing.delete(key));
    return p;
  }

  getReveal(token: string, roundIdx: number): RoundReveal {
    this.auth(token);
    const r = this.rounds[roundIdx]?.reveal;
    if (!r) throw new GameError('Runde noch nicht aufgelöst', 404);
    return r;
  }

  private openRoundAt(idx: number): Round {
    if (idx !== this.currentRound) throw new GameError('Falsche Runde');
    const round = this.rounds[idx];
    if (!round || round.status !== 'open') throw new GameError('Runde ist nicht offen');
    return round;
  }

  // -------------------------------------------------------------- Zustand

  state(): GameState {
    const players = this.playersPublic();
    const rounds: RoundPublic[] = this.rounds.map((r) => {
      const visible = r.status !== 'preparing';
      return {
        index: r.index,
        status: r.status,
        from: visible && r.from ? this.net.ref(r.from.id) : null,
        to: visible && r.to ? this.net.ref(r.to.id) : null,
        when: describeSlotDate(r.time),
        restriction: visible ? r.restriction : null,
        bannedLines: visible ? r.bannedLines : [],
        limitSec: r.limitSec,
        submitted: [...r.submissions.keys()],
        startedAt: r.startedAt,
        deadline: r.deadline,
        pausedAt: r.pausedAt,
      };
    });
    return {
      mode: 'route',
      id: this.id,
      serverNow: Date.now(),
      settings: this.settings,
      phase: this.phase,
      players,
      currentRound: this.currentRound,
      rounds,
    };
  }

}
