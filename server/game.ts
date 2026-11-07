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
  RouteLeg,
  RouteOption,
  Station,
  TipKind,
  TipResult,
  UmlandStart,
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
  moveMinutes,
  VARIANTS,
  WELL_KNOWN_S,
} from '../shared/rules.ts';
import { distM, NoPairError, type Network, type PastPair } from './network.ts';
import { EfaUnavailableError, evaluateUserRoute, topRoutes, type RouteQuery } from './routing.ts';
import { DEADLINE_GRACE_MS, GameError, Lobby } from './lobby.ts';
import { CancelledError, fmtTime } from './efa.ts';
import { waterData } from './water.ts';
import { nearestWater, walkMinutes, type WaterHit } from '../shared/water.ts';
import { heliMinutes, heliPart, joinRoutes, type Heli } from './challengeRound.ts';
import { UMLAND, avoidFor, crossesCenter, legsOf, mergeRoutes, pairFits, pickDistricts, pickManyDistricts, pickRequired, pickVisitDistricts, routeAllowed, ruleNetOf, searchVariants, umlandStart, withTrain } from './challengeRound.ts';
import { bridgeCount } from '../shared/challengeRules.ts';
import { bridgeData, bridgeLookup } from './bridges.ts';
import { FUTURE_LINES } from '../shared/challenges.ts';
import { runningLines } from './timetable.ts';
import type { RuleNet, RuleRound } from '../shared/challengeRules.ts';
import { withCancel } from './plancontext.ts';
import { describeSlotDate, slotTime } from './timeslots.ts';
import { cleanLegs, sanitizeSettings, validLatLon } from './settings.ts';

export { GameError };

interface Submission {
  legs: UserLeg[];
  guesses: Guesses | null;
  elapsedSec: number;
  /** für diese Runde aufgegeben */
  gaveUp?: boolean;
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
  /** Tages-Challenges: Pflicht-Linien, Umland-Start, gesperrte Bezirke, Ziele/Punkte zur Auswahl, Wasser */
  required: string[];
  umland?: UmlandStart;
  districts?: number[];
  targets?: Station[];
  waypoints?: Station[];
  water?: 'all' | 'bath';
  /** Linien, die zu dieser Uhrzeit nicht fahren („nur fahrende Linien vorschlagen“) */
  idle?: string[];
  /** Hubschrauber-Linien (H1–H3) */
  helis?: Heli[];
  /** Brückenkenner: so viele Brücken mindestens */
  bridges?: number;
  /** Zielnetz 2040: beste Verbindung heute */
  today?: { min: number; lines: string[] };
}

export class Game extends Lobby {
  readonly mode = 'route' as const;
  settings: GameSettings;
  currentRound = -1;
  private rounds: Round[] = [];
  private usedStations = new Set<string>();
  /** Haltestellen nahe am Wasser bzw. an einem Bad („Ab ins Wasser“/„Ab ins Bad“, einmal berechnet) */
  private waterStops: Partial<Record<'all' | 'bath', { s: Station; hit: WaterHit }[]>> = {};
  /** bisherige Strecken dieses Spiels – neue sollen woanders liegen */
  private pastPairs: PastPair[] = [];
  private generation = 0;
  /** dieses Spiel (Lobby + Durchgang) – z.B. für „erstes Spiel einer Challenge am Tag“ */
  get runId(): string {
    return `${this.id}:${this.generation}`;
  }
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
    // Tages-Challenge aktiv: Einstellungen sind fest – nur Challenge beenden/wechseln geht
    // (die Rundenzahl bleibt wählbar)
    const keys = s && typeof s === 'object' ? Object.keys(s) : [];
    if (this.settings.challenge && !keys.includes('challenge') && !(keys.length && keys.every((k) => k === 'rounds')))
      throw new GameError('Während einer Tages-Challenge sind die Einstellungen fest – erst die Challenge beenden.');
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

  endGame(token: string) {
    this.requireHost(token);
    const firstOpen = this.rounds.findIndex((r) => r.status !== 'revealed');
    const played = firstOpen < 0 ? this.rounds.length : firstOpen;
    if (this.phase !== 'playing' || played === 0) return this.backToLobby(token);
    for (const r of this.rounds) if (r.timer) clearTimeout(r.timer);
    this.generation++; // Vorbereitung weiterer Runden abbrechen
    this.rounds = this.rounds.slice(0, played);
    this.currentRound = played - 1;
    this.finishGame();
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
    // Variante (ohne U-Bahn / nur Bim): jede Runde
    const v = VARIANTS.find((x) => x.id === this.settings.variant)?.restriction;
    if (v) return out.map(() => v);
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
      // Tages-Challenge mit fester Regel: ihr Zeitlimit gilt so (Extrazeit nur für wechselnde Hürden)
      limitSec: this.settings.challenge && VARIANTS.some((v) => v.id === this.settings.variant && v.restriction) ? baseLimitSec(this.settings) : roundLimitSec(baseLimitSec(this.settings), restriction),
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
      required: [],
    };
  }

  private ruleRound(round: Round): RuleRound {
    return {
      restriction: round.restriction,
      banned: round.restriction === 'insider' ? [...round.bannedLines, ...WELL_KNOWN_S] : round.bannedLines,
      required: round.required,
      entryLines: round.umland ? [...new Set(round.umland.options.flatMap((o) => o.lines))] : undefined,
      entryTown: round.umland?.town,
      districts: round.districts,
      bridges: round.bridges,
    };
  }

  /** Abfrage für die Runde; `avoid`: Gesperrtes (Bezirke, Tunnel, Insider-Linien) schon bei der Suche meiden */
  private query(round: Round, avoid = true): RouteQuery {
    const rr = this.ruleRound(round);
    return {
      countWait: this.settings.countWait,
      avgWait: this.settings.avgWait,
      restriction: round.restriction,
      banned: rr.banned,
      required: round.required,
      entryLines: rr.entryLines,
      entryTown: rr.entryTown,
      ...(avoid ? avoidFor(rr, this.net) : {}),
      ...(this.settings.scooter ? { scooter: true } : {}),
    };
  }

  /** Verbindungen a → b mit allen Suchen der Regel (siehe searchVariants), zusammengeführt und sortiert */
  private async searchAll(round: Round, a: string, b: string, extra: Partial<RouteQuery> = {}): Promise<RouteOption[]> {
    const q = { ...this.query(round), ...extra };
    const lists = await Promise.all([q, ...searchVariants(round.restriction).map((v) => ({ ...q, ...v }))].map((x) => topRoutes(this.net, a, b, round.time, x)));
    return sortRoutes(mergeRoutes(lists), this.settings);
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
    // Spiel beendet/neu gestartet → nicht zu Ende rechnen (bricht bei der nächsten Fahrplan-Abfrage ab)
    try {
      return await withCancel(() => gen !== this.generation, () => this.prepareInner(round, gen));
    } catch (e) {
      if (e instanceof CancelledError || gen !== this.generation) return [];
      throw e;
    }
  }

  /** Start/Ziel ziehen – mit festem Start (z.B. Schwedenplatz), Umland-Einstieg oder „quer durch die Innenstadt“ */
  private pickPair(round: Round): [Station, Station] {
    const s = this.settings;
    round.umland = undefined;
    let fixed: Station | null = null;
    if (round.restriction === 'umland') {
      // Start im Ort – das Ziel liegt passend weit von der (ersten) Einstiegs-Station in Wien
      const towns = UMLAND.map((u) => umlandStart(this.net, u)).filter((x): x is UmlandStart => !!x);
      round.umland = towns[Math.floor(Math.random() * towns.length)];
      fixed = this.net.station(round.umland.options[Math.floor(Math.random() * round.umland.options.length)].entry);
    } else if (s.start) fixed = this.net.stationByName(s.start);
    if (fixed) return [fixed, s.endpoints === 'addresses' && this.net.hasAddresses ? this.net.randomAddressFrom(fixed, s) : this.net.randomTarget(fixed, s, this.usedStations)];
    // Brückenkenner: über Donau, Donaukanal und Wienfluss – ein Ende in Transdanubien, das andere südlich des Wienflusses
    const across = (a: Station, b: Station) => {
      const north = (s: Station) => [21, 22].includes(s.district);
      const south = (s: Station) => [4, 5, 10, 12, 13, 23].includes(s.district);
      return (north(a) && south(b)) || (north(b) && south(a));
    };
    const picky = round.restriction === 'avoidInner' || round.restriction === 'minBridges';
    for (let i = 0; i < (picky ? 400 : 1); i++) {
      const [a, b] = s.endpoints === 'addresses' && this.net.hasAddresses ? this.net.randomAddressPair(s, this.pastPairs) : this.net.randomPair(s, this.usedStations, this.pastPairs);
      if (round.restriction === 'avoidInner' ? crossesCenter(a, b) : round.restriction === 'minBridges' ? across(a, b) : true) return [a, b];
    }
    throw new NoPairError('Kein Paar gefunden, das quer durch die Innenstadt führt.');
  }

  /** beste erlaubte Verbindungen a → b (für „3 Ziele“ und „3 Punkte“) */
  private async allowedRoutes(round: Round, a: string, b: string, rn: RuleNet): Promise<RouteOption[]> {
    return (await this.searchAll(round, a, b)).filter((r) => routeAllowed(r, this.ruleRound(round), rn));
  }

  private async prepareInner(round: Round, gen: number): Promise<RouteOption[]> {
    const wanted = this.minTransfersFor(round);
    const rn = ruleNetOf(this.net, this.settings.network);
    // fehlen die Gewässer- bzw. Brücken-Daten, gibt es diese Challenges nicht – gleich sagen statt lange zu suchen
    const water = this.settings.task === 'water' || this.settings.task === 'bath';
    if ((water && !waterData()) || (round.restriction === 'minBridges' && !bridgeLookup()))
      throw new GameError('Diese Challenge ist gerade nicht verfügbar – bitte eine andere wählen.', 503);
    for (let attempt = 0; attempt < 18; attempt++) {
      if (gen !== this.generation) return [];
      let a: Station, b: Station;
      try {
        [a, b] = this.pickPair(round);
      } catch (e) {
        if (e instanceof NoPairError) throw new GameError(e.message, 422);
        throw e;
      }
      const strict = attempt < 12;
      let routes: RouteOption[] | null;
      try {
        if (this.settings.task === 'water' || this.settings.task === 'bath') routes = await this.prepWater(round, rn, this.settings.task === 'bath' ? 'bath' : 'all');
        else if (round.umland) routes = await this.prepUmland(round, round.umland, b, strict);
        else if (this.settings.task === 'heli') routes = await this.prepHeli(round, a, b, strict);
        else if (this.settings.task === 'choose3') routes = await this.prepChoose3(round, a, b, rn, strict);
        else if (this.settings.task === 'visit3') routes = await this.prepVisit3(round, a, rn);
        else routes = await this.prepNormal(round, a, b, rn, strict, strict ? wanted : 0);
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        if (e instanceof NoPairError) continue;
        if (e instanceof EfaUnavailableError) throw new GameError('Die Runde konnte gerade nicht vorbereitet werden – bitte in einer Minute nochmal starten.', 503);
        throw e;
      }
      if (!routes?.length || routes[0].key === 'walk') continue;
      if (this.settings.task === 'water' || this.settings.task === 'bath') a = round.from ?? a;
      // Umland: intern die Einstiegs-Station der besten Verbindung (gezeigt wird der Ort)
      if (round.umland) a = this.net.station(round.umland.options.find((o) => routes![0].key.startsWith(`umland:${o.entry}:`))?.entry ?? a.id);
      round.from = a;
      if (this.settings.onlyRunning) round.idle = this.idleLines(round.time);
      // „3 Ziele“: to = das Ziel der besten Verbindung; „3 Punkte“: der letzte Punkt der besten Reihenfolge
      const lastStop = routes[0].legs.findLast((l) => l.toStation)?.toStation;
      round.to =
        round.targets?.find((t) => t.name === routes![0].target) ??
        round.waypoints?.find((t) => t.name === routes![0].target) ??
        (round.water && lastStop ? this.net.station(lastStop) : b);
      // gespielt: in diesem Spiel und (über alle Spiele) seltener ziehen – mit dem tatsächlichen Start und Ziel
      b = round.to;
      this.usedStations.add(a.id).add(b.id);
      this.pastPairs.push({ a, b });
      if (!this.net.isAddress(a.id) && !this.net.isAddress(b.id)) this.net.markUsed(a.id, b.id);
      round.routes = routes;
      return routes;
    }
    throw new GameError('Keine passende Strecke gefunden – bitte nochmal starten oder die Einstellungen ändern.', 502);
  }

  /** normale Runde A → B, mit Regeln und Auswahl-Kriterien der Challenge */
  private async prepNormal(round: Round, a: Station, b: Station, rn: RuleNet, strict: boolean, wanted: number): Promise<RouteOption[] | null> {
    if (round.restriction === 'banLines') {
      // erst normal rechnen, dann eine Linie der schnellsten Verbindung sperren und neu rechnen
      round.bannedLines = [];
      const free = await topRoutes(this.net, a.id, b.id, round.time, { ...this.query(round), sampleOnly: true });
      if (!free.length || free[0].key === 'walk') return null;
      round.bannedLines = this.pickBan(free[0]);
      if (!round.bannedLines.length) return null;
      // nur sperren, wenn es in der Stichprobe eine Verbindung ohne die gesperrten Linien gibt
      const banned = new Set(round.bannedLines);
      if (!free.some((r) => r.key !== 'walk' && !r.legs.some((l) => l.line?.split('/').some((x) => banned.has(x))))) return null;
    }
    // Fußbus: Verbindungen mit genau einer Linie selbst ausrechnen (die Suche ohne Umstieg kennt keine Fußwege)
    if (round.restriction === 'oneLeg') {
      if (a.lines.some((l) => b.lines.includes(l))) return null; // keine Linie fährt direkt – sonst zu leicht
      const ok = await this.oneLineRoutes(round, a, b);
      // man muss hin- oder weggehen, aber nicht ewig (≤ 45 min)
      return ok.length && ok[0].legs.some((l) => l.mode === 'W') && ok[0].medianMin <= 45 ? ok : null;
    }
    // bei "beste Route" nach Zeit + Umstiegen sortieren – routes[0] ist dann die beste (auch für Tipps)
    // erst ohne Meiden: die schnellste Verbindung überhaupt (Vergleich, Bezirke/Pflicht-Linien wählen)
    round.districts = undefined;
    const all = sortRoutes(await topRoutes(this.net, a.id, b.id, round.time, { ...this.query(round, false), minTransfers: wanted }), this.settings);
    if (!all.length) return null;
    if (round.restriction === 'avoidDistricts' || round.restriction === 'avoidMany') {
      round.districts = (round.restriction === 'avoidMany' ? pickManyDistricts(all, a, b, rn) : pickDistricts(all, a, b, rn)) ?? undefined;
      if (!round.districts) return null;
    }
    // Brückenkenner: mindestens 3 Brücken und 2 mehr als die schnellste Verbindung – geht das nicht mit vertretbarem
    // Umweg (≤ 20 min), 1 mehr. Dazu Verbindungen gezielt über Brücken am Weg (die Suche allein findet sie selten).
    let extra: RouteOption[] = [];
    if (round.restriction === 'minBridges') {
      const best = all.find((r) => r.key !== 'walk');
      const bl = best && legsOf(best, this.ruleRound(round), rn);
      if (!best || !bl) return null;
      extra = await this.viaBridges(round, a, b, rn, new Set(bl.flatMap((l) => rn.bridges?.(l.line, l.from, l.to) ?? [])));
      const found = sortRoutes(mergeRoutes([all, extra, await this.searchAll(round, a.id, b.id)]), this.settings).filter((r) => r.key !== 'walk' && r.medianMin <= best.medianMin + 20);
      const counts = found.map((r) => bridgeCount(legsOf(r, { restriction: null }, rn) ?? [], rn));
      const base = bridgeCount(bl, rn);
      round.bridges = [base + 2, base + 1].find((n) => n >= 3 && counts.some((c) => c >= n));
      if (!round.bridges) return null;
    }
    // Bezirkstour: Bezirke abseits der schnellsten Verbindung; Verbindungen gezielt über ihre Knoten (die Suche allein
    // fährt nie einen Umweg)
    if (round.restriction === 'visitDistricts') {
      round.districts = pickVisitDistricts(all, a, b, rn, this.net) ?? undefined;
      if (!round.districts) return null;
      extra = await this.viaDistricts(round, a, b, round.districts);
    }
    if (round.restriction === 'mustLine' || round.restriction === 'anyLine') {
      const more = await this.searchAll(round, a.id, b.id);
      round.required = pickRequired(round.restriction, sortRoutes(mergeRoutes([all, more]), this.settings), (id) => this.net.lines.get(id)?.mode ?? null);
      if (!round.required.length) return null;
    }
    // dann mit allen Suchen der Regel – nur Verbindungen, die alle Regeln einhalten (die Auflösung zeigt keine
    // Bestzeit mit verbotener Linie)
    const merged = sortRoutes(mergeRoutes([all, extra, await this.searchAll(round, a.id, b.id)]), this.settings);
    const ok = merged.filter((r) => routeAllowed(r, this.ruleRound(round), rn));
    if (!pairFits(this.ruleRound(round), all, ok, rn, a, b, strict)) return null;
    // Zielnetz 2040: die beste Verbindung ist wegen des neuen Netzes anders oder schneller als heute
    if (this.settings.task === 'future') {
      const today = this.netFor('regular');
      const known = today.stations.has(a.id) && today.stations.has(b.id);
      const now = known ? (await topRoutes(today, a.id, b.id, round.time, { ...this.query(round, false) })).filter((r) => r.key !== 'walk').sort((x, y) => x.medianMin - y.medianMin)[0] : null;
      const lines = (r: RouteOption) => r.legs.filter((l) => l.mode !== 'W' && l.line).map((l) => l.line!.split('/')[0]);
      // „wegen des Netzes“: schneller, oder eine neue/geänderte Linie, die heute nicht dabei ist (S1–S4 sind auf der
      // Stammstrecke gleichwertig – S2 statt S1 zählt nicht)
      const norm = (id: string) => (/^S[1-4]$/.test(id) ? 'S1-4' : id);
      const future = new Set(FUTURE_LINES.map(norm));
      const before = new Set(now ? lines(now).map(norm) : []);
      const newLine = lines(ok[0]).map(norm).some((id) => future.has(id) && !before.has(id));
      const changed = !now || ok[0].medianMin <= now.medianMin - 2 || newLine;
      if (strict && !changed) return null;
      round.today = now ? { min: now.medianMin, lines: lines(now) } : undefined;
    }
    // E-Scooter: mit Öffis muss es klar schneller gehen als nur mit dem Scooter (sonst gibt es nichts zu finden)
    const solo = merged.find((r) => r.key === 'walk');
    if (this.settings.scooter && strict && solo && ok[0].medianMin + 2 > solo.medianMin) return null;
    // beste Verbindung muss mindestens so viele Umstiege haben (nach vielen Versuchen gelockert)
    if (ok[0].legs.filter((l) => l.mode !== 'W').length - 1 < wanted) return null;
    return ok;
  }

  /**
   * Brückenkenner: Verbindungen über Brücken am Weg erzwingen – bis zur Brücke, mit der Linie darüber, weiter zum Ziel
   * (einzeln und paarweise, in Fahrtrichtung). Nur Brücken in der Nähe der Luftlinie (Umweg ≤ 35 %).
   */
  private async viaBridges(round: Round, a: Station, b: Station, rn: RuleNet, used: Set<string>): Promise<RouteOption[]> {
    const data = bridgeData();
    if (!data) return [];
    const d = distM(a, b);
    const near = data.bridges
      .filter((br) => !used.has(br.id) && distM(a, br) + distM(br, b) <= d * 1.35)
      .sort((x, y) => distM(a, x) + distM(x, b) - (distM(a, y) + distM(y, b)))
      .slice(0, 5);
    // je Brücke: Abschnitt mit einem Verkehrsmittel, das tagsüber fährt; Richtung: Einstieg näher am Start
    const hops = near.flatMap((br) => {
      const sg = br.segs.find(([, , m]) => m.some((x) => x !== 'N'));
      if (!sg) return [];
      const [p, q] = sg;
      const [x, y] = distM(a, this.net.station(p)) <= distM(a, this.net.station(q)) ? [p, q] : [q, p];
      return [{ br, x: this.net.station(x), y: this.net.station(y) }];
    });
    const cache = new Map<string, Promise<RouteOption | null>>();
    const leg = (p: Station, q: Station) => {
      if (p.id === q.id) return Promise.resolve(null);
      const k = `${p.id}>${q.id}`;
      if (!cache.has(k)) cache.set(k, topRoutes(this.net, p.id, q.id, round.time, this.query(round, false)).then((rs) => sortRoutes(rs, this.settings)[0] ?? null));
      return cache.get(k)!;
    };
    const start = fmtTime(round.time);
    const out: RouteOption[] = [];
    const build = async (chain: Station[], key: string) => {
      const parts = await Promise.all(chain.slice(0, -1).map((p, i) => leg(p, chain[i + 1])));
      if (parts.some((x, i) => !x && chain[i].id !== chain[i + 1].id)) return;
      out.push(joinRoutes(key, parts, start));
    };
    for (const h of hops) await build([a, h.x, h.y, b], `bridge:${h.br.id}`);
    for (const h1 of hops)
      for (const h2 of hops)
        if (h1 !== h2 && distM(a, h1.br) < distM(a, h2.br)) await build([a, h1.x, h1.y, h2.x, h2.y, b], `bridge:${h1.br.id}+${h2.br.id}`);
    // nur, was die Brücken wirklich nimmt
    return out.filter((r) => (legsOf(r, { restriction: null }, rn) ?? []).length);
  }

  /**
   * Bezirkstour: Verbindungen Start → Knoten im 1. Bezirk → Knoten im 2. … → Ziel, in jeder Reihenfolge; je Bezirk die
   * Haltestellen mit den meisten Linien (dort steigt man am ehesten um).
   */
  private async viaDistricts(round: Round, a: Station, b: Station, districts: number[]): Promise<RouteOption[]> {
    const hubsOf = (d: number) =>
      [...this.net.stations.values()]
        .filter((s) => s.district === d && s.lines.length)
        .sort((x, y) => y.lines.length - x.lines.length || distM(a, x) + distM(x, b) - (distM(a, y) + distM(y, b)))
        .slice(0, districts.length > 2 ? 1 : 2);
    const hubs = districts.map(hubsOf);
    if (hubs.some((h) => !h.length)) return [];
    const cache = new Map<string, Promise<RouteOption | null>>();
    const leg = (p: Station, q: Station) => {
      const k = `${p.id}>${q.id}`;
      if (!cache.has(k)) cache.set(k, topRoutes(this.net, p.id, q.id, round.time, this.query(round, false)).then((rs) => sortRoutes(rs, this.settings)[0] ?? null));
      return cache.get(k)!;
    };
    const orders = (l: number[]): number[][] => (l.length <= 1 ? [l] : l.flatMap((x, i) => orders([...l.slice(0, i), ...l.slice(i + 1)]).map((r) => [x, ...r])));
    const combos = (lists: Station[][]): Station[][] => lists.reduce<Station[][]>((acc, l) => acc.flatMap((c) => l.map((s) => [...c, s])), [[]]);
    const start = fmtTime(round.time);
    const out: RouteOption[] = [];
    for (const order of orders(districts.map((_, i) => i)))
      for (const via of combos(order.map((i) => hubs[i]))) {
        const chain = [a, ...via, b];
        if (chain.some((s, i) => i > 0 && s.id === chain[i - 1].id)) continue;
        const parts = await Promise.all(chain.slice(0, -1).map((p, i) => leg(p, chain[i + 1])));
        if (parts.some((x) => !x || x.key === 'walk')) continue;
        out.push(joinRoutes(`districts:${via.map((s) => s.id).join('+')}`, parts, start));
      }
    return out;
  }

  /**
   * Fußbus: für jede Linie in Gehweite (≤ 1,2 km vom Start) die nächste Haltestelle am Start und die Haltestelle in
   * Fahrtrichtung, die dem Ziel am nächsten liegt (≤ 1,5 km) – Fußweg + Fahrt + Fußweg wie bei einer eigenen Route.
   */
  private async oneLineRoutes(round: Round, a: Station, b: Station): Promise<RouteOption[]> {
    const nearA = [...this.net.stations.values()].filter((s) => s.lines.length && distM(s, a) <= 1200);
    const tried = new Set<string>();
    const out: RouteOption[] = [];
    for (const lineId of new Set(nearA.flatMap((s) => s.lines))) {
      const line = this.net.lines.get(lineId);
      if (!line || line.mode === 'N') continue;
      for (const p of linePatterns(line, this.settings.network)) {
        const boards = p.map((id, i) => ({ id, i })).filter((x) => nearA.some((s) => s.id === x.id));
        if (!boards.length) continue;
        const board = boards.sort((x, y) => distM(this.net.station(x.id), a) - distM(this.net.station(y.id), a))[0];
        const after = p.slice(board.i + 1).map((id) => this.net.station(id));
        if (!after.length) continue;
        const alight = after.reduce((m, s) => (distM(s, b) < distM(m, b) ? s : m));
        if (distM(alight, b) > 1500) continue;
        const key = `${lineId}:${board.id}>${alight.id}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const r = await evaluateUserRoute(this.net, [{ line: lineId, from: board.id, to: alight.id }], a.id, b.id, round.time, this.settings.network, this.query(round), []);
        if (r.route && r.durationMin != null) out.push({ ...r.route, key: `foot:${key}`, medianMin: r.durationMin });
      }
    }
    return sortRoutes(out, this.settings).slice(0, 4);
  }

  /**
   * Aus dem Umland: für jeden Zug des Orts die besten Verbindungen ab seiner ersten Station in Wien (dort weiterfahren
   * oder umsteigen), plus die Fahrt bis zur Stadtgrenze. Die beste Wahl des Zugs gehört zur Aufgabe.
   */
  private async prepUmland(round: Round, um: UmlandStart, b: Station, strict: boolean): Promise<RouteOption[] | null> {
    const q = { ...this.query(round), restriction: null, entryLines: undefined, entryTown: undefined };
    const lists = await Promise.all(
      um.options.map(async (o) => {
        if (o.entry === b.id) return [];
        const routes = await topRoutes(this.net, o.entry, b.id, round.time, q);
        return routes.filter((r) => r.key !== 'walk').map((r) => withTrain(r, um, o, this.net));
      }),
    );
    const all = sortRoutes(lists.flat(), this.settings);
    if (!all.length) return null;
    // nicht einfach sitzen bleiben: in Wien wird mindestens einmal umgestiegen (nach vielen Versuchen egal)
    if (strict && all[0].legs.filter((l) => l.mode !== 'W').length < 2) return null;
    return all;
  }

  /** Öffis a → b (bzw. kein Weg, wenn a = b; zu Fuß, wenn nah): die beste Verbindung */
  private async segment(round: Round, a: Station, b: Station): Promise<RouteOption | null> {
    if (a.id === b.id) return null;
    return (await this.searchAll(round, a.id, b.id))[0] ?? null;
  }

  /**
   * Hubschrauber: 2 Linien (kurze Strecken) oder 3. Eine bringt Zeit (3–12 min schneller als ohne), die anderen sehen
   * ähnlich verlockend aus und bringen weniger (höchstens 8 min langsamer als die beste). Landeplätze nicht an U-/S-Bahn-
   * Knoten und nicht direkt bei Start oder Ziel (≥ 1,2 km) – man muss erst hinkommen und danach weiter, der Weg zum
   * Hubschrauber gehört zur Aufgabe. Alle Kandidaten werden mit den echten Verbindungen bis zum Abflug und ab der
   * Landung durchgerechnet.
   */
  private async prepHeli(round: Round, a: Station, b: Station, strict: boolean): Promise<RouteOption[] | null> {
    round.helis = undefined;
    const base = await this.searchAll(round, a.id, b.id);
    const best = base.find((r) => r.key !== 'walk');
    if (!best) return null;
    const d = distM(a, b);
    const count = d < 8000 ? 2 : 3;
    const pool = this.net.candidates(['T', 'hub'], this.settings.slot, this.settings.network).filter((s) => !s.modes.includes('U') && !s.modes.includes('S'));
    // Schätzung: Öffis ~ 300 m/min Luftlinie
    const guess = (x: Station, y: Station) => distM(a, x) / 300 + heliMinutes(distM(x, y)) + distM(y, b) / 300;
    const cands: { x: Station; y: Station; g: number }[] = [];
    for (let n = 0; n < 1500 && cands.length < 80; n++) {
      const x = pool[Math.floor(Math.random() * pool.length)];
      const y = pool[Math.floor(Math.random() * pool.length)];
      const m = distM(x, y);
      if (m < 3000 || m > 8000 || distM(a, x) < 1200 || distM(y, b) < 1200) continue;
      // in Flugrichtung: näher am Start abheben, näher am Ziel landen
      if (distM(a, x) + distM(y, b) > d * 0.95 || distM(a, x) > distM(a, y)) continue;
      cands.push({ x, y, g: guess(x, y) });
    }
    if (cands.length < count) return null;
    cands.sort((p, q) => p.g - q.g);
    const start = fmtTime(round.time);
    const tried: { h: Heli; route: RouteOption }[] = [];
    const tryHeli = async (c: (typeof cands)[number]) => {
      if (tried.some((t) => distM(t.h.a, c.x) < 1500 && distM(t.h.b, c.y) < 1500)) return;
      const h: Heli = { id: '', a: c.x, b: c.y, min: heliMinutes(distM(c.x, c.y)) };
      const [s1, s2] = await Promise.all([this.segment(round, a, c.x), this.segment(round, c.y, b)]);
      if (!s1 || !s2) return;
      tried.push({ h, route: joinRoutes(`heli:${c.x.id}>${c.y.id}`, [s1, heliPart(h, c.x, c.y), s2], start) });
    };
    // erst die vielversprechendsten, dann weitere als Lockvögel
    for (const c of cands.slice(0, 40)) {
      if (tried.length >= 8) break;
      await tryHeli(c);
    }
    tried.sort((p, q) => p.route.medianMin - q.route.medianMin);
    const win = tried[0];
    if (!win) return null;
    const gain = best.medianMin - win.route.medianMin;
    if (strict && (gain < 3 || gain > 12)) return null;
    // Lockvögel: langsamer als der beste Flug, aber ähnlich verlockend; sonst irgendein langsamerer (durchgerechnet)
    const close = tried.slice(1).filter((t) => t.route.medianMin >= win.route.medianMin + 2 && t.route.medianMin <= win.route.medianMin + 8);
    const rest = tried.slice(1).filter((t) => t.route.medianMin >= win.route.medianMin + 2 && !close.includes(t));
    const decoys = [...close, ...rest].filter((t, i, l) => l.findIndex((u) => distM(u.h.a, t.h.a) < 1500) === i && distM(t.h.a, win.h.a) >= 1500).slice(0, count - 1);
    if (decoys.length < count - 1) return null;
    // Reihenfolge mischen – H1 ist nicht immer der richtige
    const all = [win, ...decoys].sort(() => Math.random() - 0.5);
    all.forEach((t, i) => (t.h.id = `H${i + 1}`));
    for (const t of all) t.route = { ...t.route, legs: t.route.legs.map((l) => (l.mode === 'H' ? { ...l, line: t.h.id } : l)), steps: t.route.steps?.map((st) => (st.mode === 'H' ? { ...st, line: t.h.id } : st)) };
    round.helis = all.map((t) => t.h);
    return sortRoutes([...all.map((t) => t.route), ...base], this.settings);
  }

  private async evaluateHeli(round: Round, legs: UserLeg[], dest: string, q: RouteQuery) {
    const fail = (error: string) => ({ route: null, durationMin: null, matchedRank: null, source: 'none' as const, error });
    const parts: (RouteOption | { leg: RouteLeg; min: number } | null)[] = [];
    let at = round.from!;
    let seg: UserLeg[] = [];
    let elapsed = 0;
    const flush = async (to: Station) => {
      if (!seg.length) {
        // nur zu Fuß zum Hubschrauber bzw. vom Landeplatz
        if (at.id === to.id) return null;
        const m = moveMinutes(distM(at, to), false);
        const leg: RouteLeg = { mode: 'W', line: null, color: '#7a7a7a', fromName: at.name, toName: to.name, fromStation: at.id, toStation: to.id, dep: '', arr: '', path: [[at.lat, at.lon], [to.lat, to.lon]] };
        return { key: 'walk', legs: [leg], medianMin: m, minMin: m, maxMin: m, rideMin: m, samples: 1 } as RouteOption;
      }
      const r = await evaluateUserRoute(this.net, seg, at.id, to.id, round.time + Math.round(elapsed), this.settings.network, q, []);
      if (!r.route || r.durationMin == null) throw new Error(r.error ?? 'Teilstrecke nicht auswertbar.');
      return { ...r.route, medianMin: r.durationMin };
    };
    try {
      for (const l of legs) {
        const h = round.helis!.find((x) => x.id === l.line);
        if (!h) {
          seg.push(l);
          continue;
        }
        const [from, to] = l.from === h.a.id && l.to === h.b.id ? [h.a, h.b] : l.from === h.b.id && l.to === h.a.id ? [h.b, h.a] : [null, null];
        if (!from || !to) return fail(`🚁 ${h.id} fliegt nur zwischen ${h.a.name} und ${h.b.name}.`);
        const before = await flush(from);
        if (before) (parts.push(before), (elapsed += before.medianMin));
        parts.push(heliPart(h, from, to));
        elapsed += h.min;
        seg = [];
        at = to;
      }
      const after = await flush(this.net.station(dest));
      if (after) parts.push(after);
    } catch (e) {
      return fail((e as Error).message);
    }
    const route = joinRoutes('heli:user', parts, fmtTime(round.time));
    return { route, durationMin: route.medianMin, matchedRank: null, source: 'computed' as const, error: null };
  }

  /** E-Scooter von Start zu Ziel, ganz ohne Öffis */
  private scooterOnly(round: Round): RouteOption {
    const a = round.from!;
    const b = round.to!;
    const m = moveMinutes(distM(a, b), true);
    const leg: RouteLeg = { mode: 'W', line: null, color: '#7a7a7a', fromName: a.name, toName: b.name, fromStation: a.id, toStation: b.id, dep: '', arr: '', path: [[a.lat, a.lon], [b.lat, b.lon]] };
    return { key: 'walk', legs: [leg], medianMin: m, minMin: m, maxMin: m, rideMin: m, samples: 1 };
  }

  /** Linien des Netzes, die zu dieser Uhrzeit nicht fahren (eigener Fahrplan; ohne ihn: keine Angabe) */
  private idleLines(time: number): string[] | undefined {
    const r = runningLines(time, this.net.planId);
    if (!r) return undefined;
    return [...this.net.lines.keys()].filter((id) => r.all.has(id) && !r.running.has(id));
  }

  /**
   * „Ab ins Wasser“: Start ≥ 2 km vom nächsten Wasser. Bestwert = schnellste Fahrt zu einer Haltestelle nahe am Wasser
   * (≤ 600 m) + Fußweg dorthin; geprüft werden die 30 Haltestellen in Wassernähe, die am nächsten am Start liegen.
   */
  private async prepWater(round: Round, rn: RuleNet, kind: 'all' | 'bath'): Promise<RouteOption[] | null> {
    const w = waterData();
    if (!w) return null;
    // Start: mindestens 1,2 km vom nächsten Wasser/Bad (zu Fuß wäre man zu lange unterwegs)
    // nach Fläche verteilt, selten gezogene zuerst, nicht in der Nähe früherer Starts dieses Spiels
    const starts = this.net.candidates(this.settings.stations, this.settings.slot, this.settings.network).filter((s) => !this.usedStations.has(s.id));
    const before = this.pastPairs.map((p) => p.a);
    const a = this.net.pickSpread(starts, (s) => nearestWater(w, s, kind).dist >= 1200 && before.every((p) => distM(p, s) >= 2000));
    if (!a) return null;
    round.from = a;
    this.waterStops[kind] ??= [...this.net.stations.values()].filter((s) => s.lines.length).map((s) => ({ s, hit: nearestWater(w, s, kind) })).filter((x) => x.hit.dist <= 600);
    const near = [...this.waterStops[kind]!].sort((x, y) => distM(x.s, a) - distM(y.s, a)).slice(0, 30);
    const out: RouteOption[] = [];
    for (const { s, hit } of near) {
      const r = (await this.allowedRoutes(round, a.id, s.id, rn)).find((x) => x.key !== 'walk');
      if (r) out.push(this.withWaterWalk(r, s, hit));
    }
    if (!out.length) return null;
    // mit den Öffis klar schneller als direkt hinzugehen
    const sorted = sortRoutes(out, this.settings);
    if (sorted[0].medianMin + 3 >= walkMinutes(nearestWater(w, a, kind).dist)) return null;
    // genau diese Strecke (Start → Wasser-Haltestelle) gab es eben erst – andere suchen
    const stop = sorted[0].legs.findLast((l) => l.toStation)?.toStation;
    if (stop && this.net.playedRecently(a.id, stop)) return null;
    round.water = kind;
    return sorted.slice(0, 4);
  }

  /** Fußweg von der letzten Haltestelle zum Wasser anhängen (zählt mit) */
  private withWaterWalk(r: RouteOption, s: Station, hit: WaterHit): RouteOption {
    const m = walkMinutes(hit.dist);
    const last = r.legs[r.legs.length - 1];
    const leg: RouteLeg = {
      mode: 'W',
      line: null,
      color: '#7a7a7a',
      fromName: s.name,
      toName: hit.name,
      fromStation: s.id,
      toStation: null,
      dep: last?.arr ?? '',
      arr: last?.arr ?? '',
      path: [
        [s.lat, s.lon],
        [hit.lat, hit.lon],
      ],
    };
    return { ...r, key: `water:${r.key}`, target: hit.name, legs: [...r.legs, leg], medianMin: r.medianMin + m, minMin: r.minMin + m, maxMin: r.maxMin + m, rideMin: r.rideMin + m, steps: undefined };
  }

  /** „3 Ziele“: zwei weitere Ziele in ähnlicher Entfernung; die Wahl soll nicht offensichtlich sein */
  private async prepChoose3(round: Round, a: Station, b: Station, rn: RuleNet, strict: boolean): Promise<RouteOption[] | null> {
    const t2 = this.net.randomTarget(a, this.settings, this.usedStations, [b]);
    const t3 = this.net.randomTarget(a, this.settings, this.usedStations, [b, t2]);
    const targets = [b, t2, t3];
    const per: RouteOption[][] = [];
    for (const t of targets) {
      const ok = await this.allowedRoutes(round, a.id, t.id, rn);
      if (!ok.length || ok[0].key === 'walk') return null;
      per.push(ok.slice(0, 2).map((r) => ({ ...r, key: `${t.id}:${r.key}`, target: t.name })));
    }
    const bestOf = per.map((rs) => rs[0].medianMin);
    const fastest = bestOf.indexOf(Math.min(...bestOf));
    const dists = targets.map((t) => distM(a, t));
    const nearest = dists.indexOf(Math.min(...dists));
    // nicht zu leicht: das nächstgelegene Ziel ist nicht das schnellste – oder alle liegen knapp beisammen
    if (strict && fastest === nearest && Math.max(...bestOf) - Math.min(...bestOf) > 4) return null;
    round.targets = [...targets].sort(() => Math.random() - 0.5);
    return sortRoutes(per.flat(), this.settings);
  }

  /** „3 Punkte“: drei Stationen in der Umgebung, alle befahren – beste Reihenfolge aus den Teilstrecken */
  private async prepVisit3(round: Round, a: Station, rn: RuleNet): Promise<RouteOption[] | null> {
    const near = { ...this.settings, distance: 'short' as const };
    const p1 = this.net.randomTarget(a, near, this.usedStations);
    const p2 = this.net.randomTarget(a, near, this.usedStations, [p1]);
    const p3 = this.net.randomTarget(a, near, this.usedStations, [p1, p2]);
    const pts = [p1, p2, p3];
    const seg = new Map<string, RouteOption | null>();
    const best = async (x: Station, y: Station) => {
      const k = `${x.id}>${y.id}`;
      if (!seg.has(k)) seg.set(k, (await this.allowedRoutes(round, x.id, y.id, rn)).find((r) => r.key !== 'walk') ?? null);
      return seg.get(k)!;
    };
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const combos: RouteOption[] = [];
    for (const o of orders) {
      const chain = [a, ...o.map((i) => pts[i])];
      const parts: RouteOption[] = [];
      for (let i = 1; i < chain.length; i++) {
        const r = await best(chain[i - 1], chain[i]);
        if (!r) break;
        parts.push(r);
      }
      if (parts.length !== 3) continue;
      const sum = (f: (r: RouteOption) => number) => parts.reduce((n, r) => n + f(r), 0);
      combos.push({
        ...parts[0],
        key: `visit:${o.join('')}`,
        target: pts[o[2]].name,
        legs: parts.flatMap((r) => r.legs),
        steps: undefined,
        medianMin: sum((r) => r.medianMin),
        minMin: sum((r) => r.minMin),
        maxMin: sum((r) => r.maxMin),
        rideMin: sum((r) => r.rideMin),
      });
    }
    if (!combos.length) return null;
    round.waypoints = pts;
    return sortRoutes(combos, this.settings).slice(0, 3);
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

  async submit(token: string, roundIdx: number, legs: unknown, guesses: Guesses | null, gaveUp = false): Promise<RoundReveal | null> {
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
      legs: gaveUp ? [] : cleanLegs(legs),
      guesses: guesses && typeof guesses === 'object' ? { from: validLatLon(guesses.from), to: validLatLon(guesses.to) } : null,
      elapsedSec: Math.round(elapsedMs / 100) / 10,
      ...(gaveUp ? { gaveUp: true } : {}),
    });
    this.touch();
    // Statistik der Admin-Seite: gewählte Linien
    this.emit('lines', round.submissions.get(playerId)!.legs.map((l) => l.line));
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
    const fail = (error: string) => ({ route: null, durationMin: null, matchedRank: null, source: 'none' as const, error });
    // Hubschrauber: an den Flügen zerlegen – Öffi-Abschnitte einzeln nachrechnen (Wartezeit nach der Landung zählt)
    if (round.helis && legs.some((l) => round.helis!.some((h) => h.id === l.line))) return this.evaluateHeli(round, legs, round.to!.id, q);
    // E-Scooter ohne Öffis: nur der Scooter von A nach B
    if (!legs.length && this.settings.scooter) {
      const route = routes.find((r) => r.key === 'walk') ?? this.scooterOnly(round);
      return { route, durationMin: route.medianMin, matchedRank: null, source: 'computed' as const, error: null };
    }
    let dest = round.to!.id;
    const end = legs.at(-1)?.to;
    // Umland: erste Fahrt = einer der Züge des Orts (ab seiner ersten Station in Wien), dann wie sonst
    if (round.umland && legs[0]) {
      const um = round.umland;
      const opt = um.options.find((o) => o.lines.includes(legs[0].line) && o.entry === legs[0].from);
      if (!opt) return fail(`🚆 Von ${um.town} fährt die ${legs[0].line} nicht nach Wien.`);
      // gleich an der Stadtgrenze ausgestiegen: diese Fahrt hat keine Strecke in Wien
      const rest = legs[0].to === legs[0].from ? legs.slice(1) : legs;
      if (!rest.length) return fail('🚆 Nach dem Aussteigen fehlt noch der Weg zum Ziel.');
      try {
        const r = await evaluateUserRoute(this.net, rest, opt.entry, dest, round.time, this.settings.network, { ...q, restriction: null, entryLines: undefined, entryTown: undefined }, []);
        if (!r.route || r.durationMin == null) return r;
        const route = withTrain(r.route, um, opt, this.net);
        return { ...r, route, durationMin: route.medianMin, matchedRank: null };
      } catch {
        return fail('Deine Route konnte gerade nicht ausgewertet werden.');
      }
    }
    // „3 Ziele“: gewertet wird das Ziel, bei dem die Route ankommt (bzw. das nächste zum letzten Ausstieg)
    if (round.targets && end) {
      const at = this.net.station(end);
      dest = [...round.targets].sort((x, y) => distM(x, at) - distM(y, at))[0].id;
    }
    // „3 Punkte“: alle befahren (Ein-, Aus- oder Durchfahrt), Ende beim letzten
    if (round.waypoints && end) {
      const rn = ruleNetOf(this.net, this.settings.network);
      const seen = new Set(legs.flatMap((l) => rn.traversed(l.line, l.from, l.to)));
      const missing = round.waypoints.filter((w) => !seen.has(w.id));
      if (missing.length) return fail(`📍 Nicht bei allen Punkten gewesen – es fehlt ${missing.map((w) => w.name).join(' und ')}.`);
      if (!round.waypoints.some((w) => w.id === end)) return fail('📍 Die Route muss bei einem der drei Punkte enden.');
      dest = end;
    }
    // „Ab ins Wasser“: bis zur letzten Haltestelle fahren, dann zu Fuß zum nächsten Wasser (zählt mit)
    if (round.water && end) {
      const w = waterData();
      try {
        const r = await evaluateUserRoute(this.net, legs, round.from!.id, end, round.time, this.settings.network, q, []);
        if (!r.route || r.durationMin == null || !w) return r;
        const st = this.net.station(end);
        const route = this.withWaterWalk(r.route, st, nearestWater(w, st, round.water));
        return { ...r, route, durationMin: route.medianMin, matchedRank: null };
      } catch {
        return fail('Deine Route konnte gerade nicht ausgewertet werden.');
      }
    }
    try {
      return await evaluateUserRoute(this.net, legs, round.from!.id, dest, round.time, this.settings.network, q, routes);
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
          // E-Scooter: auch ganz ohne Öffis eine gültige Antwort
          const r = sub && !sub.gaveUp && (sub.legs.length || this.settings.scooter)
            ? await this.evaluate(round, sub.legs, q, routes)
            : { route: null, durationMin: null, matchedRank: null, source: 'none' as const, error: sub?.gaveUp ? '🏳️ Aufgegeben.' : sub ? 'Keine Route angegeben.' : 'Nicht rechtzeitig abgegeben.' };
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
        // Umland: der Ort (außerhalb des Netzes)
        from: visible && r.umland ? { id: `umland:${r.umland.town}`, name: r.umland.town, lat: r.umland.lat, lon: r.umland.lon } : visible && r.from ? this.net.ref(r.from.id) : null,
        // „Ab ins Wasser“: kein Ziel verraten (der Browser zeigt die Gewässer)
        to: visible && r.to ? this.net.ref((r.water ? r.from! : r.to).id) : null,
        when: describeSlotDate(r.time),
        restriction: visible ? r.restriction : null,
        required: visible ? r.required : [],
        umland: visible ? r.umland : undefined,
        districts: visible ? r.districts : undefined,
        bridges: visible ? r.bridges : undefined,
        // Zielnetz 2040: Vergleich mit heute erst nach der Auflösung
        today: r.status === 'revealed' ? r.today : undefined,
        idle: visible ? r.idle : undefined,
        helis: visible && r.helis ? r.helis.map((h) => ({ id: h.id, a: this.net.ref(h.a.id), b: this.net.ref(h.b.id), min: h.min })) : undefined,
        targets: visible && r.targets ? r.targets.map((t) => this.net.ref(t.id)) : undefined,
        waypoints: visible && r.waypoints ? r.waypoints.map((t) => this.net.ref(t.id)) : undefined,
        water: visible ? r.water : undefined,
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
