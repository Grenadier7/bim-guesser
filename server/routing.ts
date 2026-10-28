// Ermittelt die Top-Verbindungsarten per Stichprobe und rechnet Routen nach.
//
// Ablauf:
//  1. Stichprobe: Auskunft für 6 Abfahrtszeiten abfragen, Ergebnisse nach Verbindungsart gruppieren
//     (Linien + Umstiegsstationen; gleiche Verkehrsmittel auf demselben Abschnitt gelten als gleich).
//  2. Die besten Verbindungsarten UND die User-Route werden auf dieselbe Weise nachgerechnet:
//     je Teilstrecke echte Abfahrten (beliebige gleichwertige Linie), für jede Stichproben-Zeit verkettet.
//     So zählt bei "Wartezeit mitzählen" die tatsächliche nächste Abfahrt – nicht nur die wenigen
//     Fahrten, die zufällig in der Stichprobe waren.
//  3. Mit "Ø-Wartezeiten" zählt statt der verketteten Fahrten: Fahrzeit (Median) je Linie + an jedem
//     Umstieg Umsteigeweg + halber Takt der nächsten Linie (Takt = Abfahrten pro Stunde zu dieser Zeit).
//     Ein zufällig perfekter Anschluss (an um 16:32, S-Bahn um 16:34) bringt so keinen Vorteil mehr –
//     eine S-Bahn alle 15 min kostet im Schnitt 7,5 min Warten, eine U-Bahn alle 4 min nur 2.
import type { LatLon, Mode, NetMode, Restriction, RouteLeg, RouteOption, RouteStep, UserLeg } from '../shared/types.ts';
import { lineColor, lineGroupLabel, regionalTrains, lineKey, restrictionAllowsLine, restrictionLabel, restrictionMaxLegs, transfersOf } from '../shared/rules.ts';
import * as efa from './efa.ts';
import { distM, type Network } from './network.ts';

/** Abfahrtszeiten relativ zum Zeitfenster, an denen gesampelt wird (Minuten) */
export const SAMPLE_OFFSETS = [0, 10, 20, 30, 40, 50];
const TRIPS_PER_SAMPLE = 4;
/** so viele Verbindungsarten werden genau nachgerechnet */
const CHAIN_TOP = 5;

/** Die Wiener-Linien-Auskunft hat auf keine Abfrage geantwortet */
export class EfaUnavailableError extends Error {}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function walkMin(net: Network, a: string, b: string): number {
  if (a === b) return 0;
  return Math.max(1, Math.round((distM(net.station(a), net.station(b)) * 1.3) / 80));
}

function walkLeg(net: Network, a: string, b: string, dep: number, arr: number): RouteLeg {
  const sa = net.station(a);
  const sb = net.station(b);
  return {
    mode: 'W',
    line: null,
    color: lineColor('W', null),
    fromName: sa.name,
    toName: sb.name,
    fromStation: a,
    toStation: b,
    dep: efa.fmtTime(dep),
    arr: efa.fmtTime(arr),
    path: [
      [sa.lat, sa.lon],
      [sb.lat, sb.lon],
    ],
  };
}

function toRouteLeg(net: Network, l: efa.EfaLeg, lineLabel?: string): RouteLeg {
  const path: LatLon[] = l.path.length ? l.path : l.stops.length ? l.stops.map((s) => [s.lat, s.lon]) : [
    [l.from.lat, l.from.lon],
    [l.to.lat, l.to.lon],
  ];
  return {
    mode: l.mode,
    line: lineLabel ?? l.line,
    color: lineColor(l.mode, l.line),
    fromName: l.from.name,
    toName: l.to.name,
    fromStation: net.resolve(l.from),
    toStation: net.resolve(l.to),
    dep: efa.fmtTime(l.dep),
    arr: efa.fmtTime(l.arr),
    path,
  };
}

/** Linie im Netz, die denselben Abschnitt fährt (für Regionalzüge, die selbst keine Linie im Netz sind) */
function equivalentLine(net: Network, mode: Mode, from: string, to: string): string | null {
  if (mode === 'U' || mode === 'W') return null;
  for (const l of net.lines.values()) if (modeGroup(l.mode) === modeGroup(mode) && net.servesInOrder(l.id, from, to, 'regular')) return l.id;
  return null;
}

/** Verkehrsmittel-Gruppe: Busse und Nachtbusse gelten als gleich */
const modeGroup = (m: Mode): Mode => (m === 'N' ? 'B' : m);

function legSig(mode: Mode, line: string, from: string | null, to: string | null): string {
  return `${lineKey(mode, line)}@${from ?? '?'}>${to ?? '?'}`;
}

export function userSignature(net: Network, legs: UserLeg[]): string {
  return legs.map((l) => legSig(net.lines.get(l.line)!.mode, l.line, l.from, l.to)).join('|');
}

function tripSignature(net: Network, t: efa.EfaTrip): string {
  const pt = t.legs.filter((l) => l.mode !== 'W');
  if (!pt.length) return 'walk';
  return pt.map((l) => legSig(l.mode, l.line!, net.resolve(l.from), net.resolve(l.to))).join('|');
}

// ---------------------------------------------------------------- Abfragen

export interface RouteQuery {
  /** Wartezeit ab Abfragezeit mitzählen (Tür-zu-Tür) statt nur ab Abfahrt */
  countWait: boolean;
  restriction: Restriction | null;
  /** bei "banLines": verbotene Linien */
  banned?: string[];
  /** Wartezeiten als Durchschnitt (halber Takt) statt verketteter Fahrplan */
  avgWait?: boolean;
  /**
   * Spielvorbereitung: Paar früh verwerfen, wenn keine der besten Stichproben-Verbindungen so viele Umstiege hat –
   * dann hätte auch die nachgerechnete beste Verbindung zu wenige (spart ~30 Fahrplan-Abfragen je verworfenem Paar).
   */
  minTransfers?: number;
  /** nur Stichproben (ohne Nachrechnen) – z.B. um die Linie für „Linie gesperrt“ zu bestimmen */
  sampleOnly?: boolean;
}

/** EFA-Parameter für eine Einschränkung */
function restrictionQuery(r: Restriction | null): { mots?: number[]; maxChanges?: number } {
  if (r === 'noU') return { mots: [1, 3, 4, 5] };
  if (r === 'noBus') return { mots: [1, 2, 3, 4] };
  if (r === 'oneTransfer') return { maxChanges: 1 };
  return {};
}

// ---------------------------------------------------------------- Nachrechnen (verketten)

/** Abfahrten "direkt von A nach B mit diesem Verkehrsmittel" – jede gleichwertige Linie zählt */
class LegTimetable {
  private legs: efa.EfaLeg[] = [];
  /**
   * Zeitbereiche [von, bis], in denen ALLE Abfahrten bekannt sind (sortiert, ohne Überlappung). Eine Abfrage ab T
   * liefert die nächsten Fahrten ab T – also lückenlos bis zur letzten gelieferten Abfahrt. Zwischen zwei Bereichen
   * kann etwas fehlen: dort wird gezielt nachgeladen (früher galt alles zwischen erster und letzter Abfrage als
   * bekannt → falsche Wartezeiten, Befund H-03).
   */
  private covered: [number, number][] = [];
  /** welche EFA-Haltestellen der Station-Gruppen funktionieren (z.B. Bim-Steig statt U-Bahn) */
  private ids: [string, string] | null = null;
  /**
   * Zwischenhalt, über den gefragt wird: die Auskunft liefert sonst nur die schnellste Linie –
   * Karlsplatz → Praterstern immer U1, nie U2. "Über Schottentor" erzwingt die U2.
   */
  private via: string | null | undefined = undefined;
  private net: Network;
  private leg: UserLeg;
  private mode: Mode;
  private banned: Set<string>;

  constructor(net: Network, leg: UserLeg, banned: string[]) {
    this.net = net;
    this.leg = leg;
    this.mode = net.lines.get(leg.line)!.mode;
    this.banned = new Set(banned);
  }

  /** Ende des lückenlos bekannten Bereichs, der t enthält (null = t ist nicht abgedeckt) */
  private coveredUntil(t: number): number | null {
    return this.covered.find(([a, b]) => a <= t && t <= b)?.[1] ?? null;
  }

  private markCovered(a: number, b: number) {
    const all = [...this.covered, [a, b] as [number, number]].sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const r of all) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    this.covered = out;
  }

  /** nächste Abfahrt ab t (lückenlos geprüft) */
  async firstAfter(t: number, maxFetches = 4): Promise<efa.EfaLeg | null> {
    for (let i = 0; i <= maxFetches; i++) {
      const until = this.coveredUntil(t);
      if (until != null) {
        const hit = this.legs.find((l) => l.dep >= t && l.dep <= until);
        if (hit) return hit;
      }
      if (i === maxFetches) break;
      if (!(await this.fetch(until ?? t))) break;
    }
    return null;
  }

  /** alle Abfahrten in [from, from + len) – lückenlos nachgeladen */
  async departures(from: number, len: number): Promise<efa.EfaLeg[]> {
    const until = from + len;
    for (let i = 0; i < 10; i++) {
      const c = this.coveredUntil(from);
      // erste nicht abgedeckte Stelle im Fenster
      const gap = c == null ? from : c < until ? c : null;
      if (gap == null) break;
      if (!(await this.fetch(gap))) break;
    }
    return this.legs.filter((l) => l.dep >= from && l.dep < until);
  }

  private matches(l: efa.EfaLeg): boolean {
    if (l.line && this.banned.has(l.line)) return false;
    // U-Bahn: genau diese Linie; sonst jede Linie desselben Verkehrsmittels (z.B. 30 oder 31, S1/S2/S3)
    if (this.mode === 'U') return l.mode === 'U' && l.line === this.leg.line;
    return modeGroup(l.mode) === modeGroup(this.mode);
  }

  /** Linien, die in [from, to) auf diesem Abschnitt fahren (für die Beschriftung „S80/REX8/R81“) */
  linesIn(from: number, to: number): string[] {
    return [...new Set(this.legs.filter((l) => l.dep >= from && l.dep < to && l.line).map((l) => l.line!))];
  }

  /** passende Fahrten ab `time` und bis wohin die Antwort lückenlos ist (letzte gelieferte Abfahrt) */
  private async query(from: string, to: string, time: number): Promise<{ out: efa.EfaLeg[]; until: number | null }> {
    const t5 = Math.floor(time / 5) * 5;
    const ask = async (via?: string) => {
      const trips = await efa.trip({ from, to, time: t5, mots: efa.motsForModes([this.mode]), maxChanges: 0, count: 8, via });
      const out: efa.EfaLeg[] = [];
      for (const t of trips) {
        const leg = singleLeg(t.legs.filter((l) => l.mode !== 'W'));
        if (leg && this.matches(leg)) out.push(leg);
      }
      return { trips, out, until: trips.length ? Math.max(...trips.map((t) => t.dep)) : null };
    };
    if (this.via) return ask(this.via);
    const plain = await ask();
    // nur eine andere Linie gefunden (z.B. U1 statt U2)? → über Zwischenhalte der gewählten Linie fragen
    if (plain.out.length || !plain.trips.length || this.via === null) return plain;
    for (const via of this.viaCandidates()) {
      const r = await ask(via);
      if (r.out.length) {
        this.via = via;
        return r;
      }
    }
    this.via = null; // nichts gefunden – nicht bei jeder Abfrage erneut probieren
    return plain;
  }

  /** EFA-Ids von Zwischenhalten der Linie zwischen Ein- und Ausstieg (Mitte zuerst) */
  private viaCandidates(): string[] {
    const line = this.net.lines.get(this.leg.line)!;
    for (const p of line.patterns) {
      const i = p.indexOf(this.leg.from);
      const j = i >= 0 ? p.indexOf(this.leg.to, i + 1) : -1;
      if (j - i < 2) continue;
      const inner = p.slice(i + 1, j);
      const mid = Math.floor(inner.length / 2);
      const order = [...inner].sort((a, b) => Math.abs(inner.indexOf(a) - mid) - Math.abs(inner.indexOf(b) - mid)).slice(0, 3);
      return order.map((id) => this.net.mainEfaId(id)).filter((x): x is string => !!x);
    }
    return [];
  }

  /** ab `time` nachladen; false = es kam nichts Neues hinzu (Betriebsschluss o.ä.) */
  private async fetch(time: number): Promise<boolean> {
    const t5 = Math.floor(time / 5) * 5;
    let res: { out: efa.EfaLeg[]; until: number | null } = { out: [], until: null };
    if (this.ids) res = await this.query(this.ids[0], this.ids[1], time);
    else {
      // Station-Gruppen können mehrere Haltestellen haben (U-Bahn, Bim, Bus) – die passende suchen
      const froms = this.net.data.efaIds[this.leg.from].slice(0, 3);
      const tos = this.net.data.efaIds[this.leg.to].slice(0, 3);
      outer: for (const f of froms)
        for (const t of tos) {
          res = await this.query(f, t, time);
          if (res.out.length) {
            this.ids = [f, t];
            break outer;
          }
        }
    }
    const before = this.legs.length;
    for (const l of res.out) if (!this.legs.some((x) => x.dep === l.dep && x.arr === l.arr)) this.legs.push(l);
    this.legs.sort((a, b) => a.dep - b.dep);
    // ohne Fahrten: in der nächsten Stunde fährt nichts (die Antwort wäre sonst nicht leer)
    const prev = this.coveredUntil(t5) ?? -Infinity;
    this.markCovered(t5, Math.max(res.until ?? t5 + 60, t5));
    return this.legs.length > before || (this.coveredUntil(t5) ?? -Infinity) > prev;
  }
}

/**
 * Linie fährt den Abschnitt zu dieser Zeit nicht durch (z.B. 92B mittags nur ab Donaustadtbrücke): was schlägt die
 * Auskunft für genau diesen Abschnitt vor? Leer, wenn sie auch nichts weiß.
 */
async function suggestion(net: Network, leg: UserLeg, slotTime: number): Promise<string> {
  try {
    const trips = await efa.trip({ from: net.mainEfaId(leg.from), to: net.mainEfaId(leg.to), time: slotTime, count: 1 });
    const pt = trips[0]?.legs.filter((l) => l.mode !== 'W') ?? [];
    if (!pt.length) return '';
    const parts = pt.map((l) => `${l.line ?? '?'} bis ${efa.cleanName(l.to.name)}`);
    return ` So geht es laut Auskunft zu dieser Zeit: ${parts.join(', dann ')}.`;
  } catch {
    return '';
  }
}

/** Eine Fahrt mit genau einer Linie – auch wenn die Auskunft sie am Zwischenhalt in zwei Stücke teilt */
function singleLeg(pt: efa.EfaLeg[]): efa.EfaLeg | null {
  if (pt.length === 1) return pt[0];
  if (pt.length === 2 && pt[0].line === pt[1].line && pt[0].mode === pt[1].mode && pt[1].dep - pt[0].arr <= 2)
    return { ...pt[0], to: pt[1].to, arr: pt[1].arr, stops: [...pt[0].stops, ...pt[1].stops.slice(1)], path: [...pt[0].path, ...pt[1].path] };
  return null;
}

interface ChainResult {
  route: RouteOption;
  error: null;
}

/**
 * Route für jede Stichproben-Zeit verketten. Umstieg an derselben Station: 2 min,
 * Fußwege: Luftlinie × 1,3 bei 80 m/min.
 */
async function chainRoute(
  net: Network,
  legs: UserLeg[],
  fromId: string,
  toId: string,
  slotTime: number,
  q: RouteQuery,
  key: string,
  labels?: (string | null)[],
): Promise<ChainResult | { route: null; error: string }> {
  const tables = legs.map((l) => new LegTimetable(net, l, q.banned ?? []));
  /** wann die Teilstrecken in den Stichproben tatsächlich gefahren werden (für die Beschriftung) */
  const rideTimes: number[][] = legs.map(() => []);
  const samples: { total: number; ride: number; route: RouteLeg[] }[] = [];
  let failedLeg = 0;
  for (const offset of SAMPLE_OFFSETS) {
    const t0 = slotTime + offset;
    const w0 = walkMin(net, fromId, legs[0].from);
    const out: RouteLeg[] = [];
    let cur = t0 + w0;
    let begin = 0;
    let failed: string | null = null;
    for (let i = 0; i < legs.length; i++) {
      const prev = i === 0 ? fromId : legs[i - 1].to;
      const w = i === 0 ? w0 : prev === legs[i].from ? 2 : Math.max(2, walkMin(net, prev, legs[i].from));
      if (i > 0) cur += w;
      const l = await tables[i].firstAfter(cur);
      if (l) rideTimes[i].push(l.dep);
      if (!l) {
        failed = `Linie ${legs[i].line} fährt um diese Zeit nicht direkt von ${net.station(legs[i].from).name} nach ${net.station(legs[i].to).name}.`;
        failedLeg = i;
        break;
      }
      if (i === 0) begin = l.dep - w0;
      if (prev !== legs[i].from) out.push(walkLeg(net, prev, legs[i].from, l.dep - w, l.dep));
      out.push(toRouteLeg(net, l, labels?.[i] ?? undefined));
      cur = l.arr;
    }
    if (failed) {
      if (samples.length) continue;
      return { route: null, error: failed + (await suggestion(net, legs.find((_, k) => k === failedLeg)!, slotTime)) };
    }
    const last = legs[legs.length - 1].to;
    const wEnd = walkMin(net, last, toId);
    if (wEnd) out.push(walkLeg(net, last, toId, cur, cur + wEnd));
    samples.push({ total: cur + wEnd - (q.countWait ? t0 : begin), ride: cur + wEnd - begin, route: out });
  }
  const durs = samples.map((s) => s.total);
  const med = median(durs);
  const rep = samples.reduce((b, s) => (Math.abs(s.total - med) < Math.abs(b.total - med) ? s : b));
  // Beschriftung je Teilstrecke: bei der S-Bahn alle S-Bahnen, die dort fahren („S1/S2/S3/S4“), dazu getrennt die
  // Regionalzüge, die im Takt mitzählen – um die Zeit, zu der man die Teilstrecke wirklich fährt (nach langem
  // Fußweg ist das nicht die Abfragezeit); sonst wie bisher
  const lineInfo = legs.map((l, i) => {
    if (net.lines.get(l.line)?.mode !== 'S') return { label: labels?.[i] ?? l.line, with: [] as string[] };
    const at = rideTimes[i].length ? rideTimes[i] : [slotTime];
    const running = tables[i].linesIn(Math.min(...at) - 10, Math.max(...at) + 20);
    // die eingegebene Linie nur, wenn sie um diese Zeit auch fährt (S4 um 17 Uhr nördlich von Floridsdorf: nur S3)
    const label = lineGroupLabel(running) || l.line;
    return { label, with: regionalTrains(running) };
  });
  let pi = 0;
  const route: RouteOption = {
    key,
    legs: rep.route.map((l) => {
      if (l.mode === 'W') return l;
      const info = lineInfo[pi++];
      return info ? { ...l, line: info.label, ...(info.with.length ? { with: info.with } : {}) } : l;
    }),
    medianMin: med,
    minMin: Math.min(...durs),
    maxMin: Math.max(...durs),
    rideMin: median(samples.map((s) => s.ride)),
    samples: samples.length,
  };
  if (q.avgWait) {
    const avg = await averagedRoute(net, legs, tables, fromId, toId, slotTime, q.countWait, lineInfo.map((x) => x.label), lineInfo.map((x) => x.with));
    if (avg) Object.assign(route, avg);
  }
  return { route, error: null };
}

/** Zeitfenster, über das der Takt gemittelt wird (Minuten) */
const HEADWAY_WINDOW = 60;
/** so weit nach dem Fenster wird noch nach der nächsten Abfahrt gesucht (seltene Linien) */
const MAX_GAP = 120;

/**
 * Erwartete Wartezeit (min) bei Ankunft irgendwann in [t, t + window): für jede Ankunftsminute die Zeit bis zur
 * nächsten Abfahrt, gemittelt. null = in diesem Fenster fährt nichts mehr (Betriebsschluss).
 */
export function expectedWait(departures: number[], t: number, window = HEADWAY_WINDOW): number | null {
  // stetig gerechnet: Ankunft gleichverteilt in [t, t + window) – je Abschnitt bis zur nächsten Abfahrt d wartet man
  // im Schnitt die halbe Abschnittslänge. Regelmäßiger Takt H → genau H/2 (früher minutenweise: (H−1)/2, Befund L-03).
  const end = t + window;
  let a = t;
  let sum = 0;
  for (const d of [...departures].sort((x, y) => x - y)) {
    if (d < a) continue;
    const segEnd = Math.min(d, end);
    sum += ((d - a + (d - segEnd)) / 2) * (segEnd - a);
    a = segEnd;
    if (a >= end) break;
  }
  // nach der letzten Abfahrt fährt nichts mehr (Betriebsschluss): nur über die abgedeckte Zeit mitteln
  return a > t ? sum / (a - t) : null;
}
/**
 * Am Start wird nur die halbe Ø-Wartezeit gerechnet (also ein Viertel des Takts):
 * zur ersten Abfahrt kann man sich die Zeit meist einteilen – beim Umsteigen nicht.
 * Gilt nur, wenn die erste Linie direkt an der Start-Station abfährt (kein Fußweg dorthin).
 */
const FIRST_WAIT_FACTOR = 0.5;

/**
 * Ø-Wartezeiten: Fahrzeit je Linie (Median) + Umsteigeweg + halber Takt der nächsten Linie.
 * Start: halber Takt nur mit "Wartezeit mitzählen". Liefert den ganzen Zeitplan (steps), damit
 * überall dieselben berechneten Minuten stehen. null, wenn eine Linie im Fenster gar nicht fährt.
 */
async function averagedRoute(
  net: Network,
  legs: UserLeg[],
  tables: LegTimetable[],
  fromId: string,
  toId: string,
  slotTime: number,
  countWait: boolean,
  labels?: (string | null)[],
  /** je Teilstrecke: Regionalzüge, die im Takt mitzählen */
  extra?: string[][],
): Promise<Pick<RouteOption, 'medianMin' | 'rideMin' | 'steps'> | null> {
  let t = slotTime;
  let firstWait = 0;
  const steps: RouteStep[] = [];
  // Zeiten auf ganze Minuten runden, damit die Summe der Schritte genau die Gesamtzeit ergibt
  const add = (kind: RouteStep['kind'], min: number, extra: Omit<RouteStep, 'kind' | 'at' | 'min'>) => {
    const a = Math.round(t);
    t += min;
    const m = Math.round(t) - a;
    if (m > 0 || kind === 'ride') steps.push({ kind, at: efa.fmtTime(a), min: m, ...extra });
  };
  const w0 = walkMin(net, fromId, legs[0].from);
  if (w0) add('walk', w0, { to: net.station(legs[0].from).name });
  for (let i = 0; i < legs.length; i++) {
    const prev = i === 0 ? fromId : legs[i - 1].to;
    if (i > 0) {
      const same = prev === legs[i].from;
      add(same ? 'transfer' : 'walk', same ? 2 : Math.max(2, walkMin(net, prev, legs[i].from)), { to: net.station(legs[i].from).name });
    }
    // Erwartete Wartezeit: für jede Ankunftsminute der nächsten Stunde die Zeit bis zur nächsten echten
    // Abfahrt, gemittelt. Stimmt auch bei unregelmäßigem Takt (50B: 12:35, 13:15, 13:55, 14:45 …) und springt
    // nicht, wenn man 2 min früher oder später ankommt – das Zählen von Abfahrten im Fenster tat das.
    // Fenster + die erste Abfahrt danach (für die Wartezeit am Fensterende) – statt pauschal 3 h zu laden
    const deps = await tables[i].departures(t, HEADWAY_WINDOW);
    const after = await tables[i].firstAfter(t + HEADWAY_WINDOW, Math.ceil(MAX_GAP / 30));
    if (after && after.dep < t + HEADWAY_WINDOW + MAX_GAP) deps.push(after);
    const meanWait = expectedWait(
      deps.map((d) => d.dep),
      t,
    );
    if (meanWait == null) return null;
    // "fährt etwa alle …": gleichwertiger regelmäßiger Takt
    const every = meanWait * 2;
    const wait = meanWait * (i === 0 && !w0 ? FIRST_WAIT_FACTOR : 1);
    if (i > 0 || countWait) {
      const before = t;
      add('wait', wait, { to: net.station(legs[i].from).name, every: Math.round(every), ...(extra?.[i]?.length ? { with: extra[i] } : {}) });
      if (i === 0) firstWait = t - before;
    }
    const line = net.lines.get(legs[i].line)!;
    const inWindow = deps.filter((d) => d.dep < t + HEADWAY_WINDOW);
    const ride = median((inWindow.length ? inWindow : deps).map((d) => d.arr - d.dep));
    add('ride', ride, {
      from: net.station(legs[i].from).name,
      to: net.station(legs[i].to).name,
      line: labels?.[i] ?? line.id,
      mode: line.mode,
      color: lineColor(line.mode, line.id),
    });
  }
  const wEnd = walkMin(net, legs[legs.length - 1].to, toId);
  if (wEnd) add('walk', wEnd, { to: net.station(toId).name });
  const total = Math.round(t) - slotTime;
  return { medianMin: total, rideMin: total - Math.round(firstWait), steps };
}

// ---------------------------------------------------------------- Top-Verbindungen

export async function topRoutes(net: Network, fromId: string, toId: string, slotTime: number, q: RouteQuery): Promise<RouteOption[]> {
  const from = net.mainEfaId(fromId);
  const to = net.mainEfaId(toId);
  const rq = restrictionQuery(q.restriction);
  let failures = 0;
  const batches = await Promise.all(
    SAMPLE_OFFSETS.map((o) =>
      efa.trip({ from, to, time: slotTime + o, count: TRIPS_PER_SAMPLE, ...rq }).catch(() => {
        failures++;
        return [] as efa.EfaTrip[];
      }),
    ),
  );
  if (failures === SAMPLE_OFFSETS.length) throw new EfaUnavailableError('Die Wiener-Linien-Auskunft ist gerade nicht erreichbar.');

  const banned = new Set(q.banned ?? []);
  const seen = new Set<string>();
  const groups = new Map<string, efa.EfaTrip[]>();
  const lastOffset = SAMPLE_OFFSETS[SAMPLE_OFFSETS.length - 1];
  for (const t of batches.flat()) {
    if (t.dep < slotTime - 10 || t.dep > slotTime + lastOffset + 40) continue;
    if (t.legs.some((l) => l.line && banned.has(l.line))) continue;
    const key = tripSignature(net, t);
    const id = `${key}#${t.dep}#${t.arr}`;
    if (seen.has(id)) continue;
    seen.add(id);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  // 1. Stichproben-Werte je Verbindungsart (reine Fahrzeit)
  const candidates: { key: string; trips: efa.EfaTrip[]; rideMed: number; option: RouteOption }[] = [];
  for (const [key, trips] of groups) {
    const inWindow = trips.filter((t) => t.dep <= slotTime + lastOffset + 20);
    if (!inWindow.length) continue;
    const rides = inWindow.map((t) => t.arr - t.dep);
    const rideMed = median(rides);
    const rep = inWindow.reduce((best, t) => (Math.abs(t.arr - t.dep - rideMed) < Math.abs(best.arr - best.dep - rideMed) ? t : best));
    // gleichwertige Linien auf einem Abschnitt zusammen anzeigen ("S1/S2", "30/31")
    const ptIdx = rep.legs.map((l, i) => (l.mode === 'W' ? -1 : i)).filter((i) => i >= 0);
    const labels = rep.legs.map((l, i) => {
      if (l.mode === 'W' || l.mode === 'U') return null;
      const k = ptIdx.indexOf(i);
      const names = new Set<string>();
      for (const t of trips) {
        const pt = t.legs.filter((x) => x.mode !== 'W');
        if (pt[k]?.line) names.add(pt[k].line!);
      }
      // nur die Linien des Netzes („S1/S2/S3“) – Regionalzüge stehen beim Nachrechnen getrennt dabei
      return lineGroupLabel([...names]);
    });
    const legs = rep.legs.map((l, i) => toRouteLeg(net, l, labels[i] ?? undefined));
    candidates.push({
      key,
      trips,
      rideMed,
      option: { key, legs, medianMin: rideMed, minMin: Math.min(...rides), maxMin: Math.max(...rides), rideMin: rideMed, samples: trips.length },
    });
  }
  candidates.sort((a, b) => a.rideMed - b.rideMed || b.trips.length - a.trips.length);

  // 2. Die besten genau nachrechnen – gleiches Verfahren wie bei der User-Route
  const top = candidates.slice(0, CHAIN_TOP);
  if (q.minTransfers && !top.some((c) => transfersOf(c.option) >= q.minTransfers!)) return [];
  if (q.sampleOnly) return top.map((c) => c.option);
  const chained = await Promise.all(
    top.map(async (c) => {
      if (c.key === 'walk') return c.option;
      const rep = c.trips[0];
      const pt = rep.legs.filter((l) => l.mode !== 'W');
      const legs: UserLeg[] = [];
      for (const l of pt) {
        const f = net.resolve(l.from);
        const t = net.resolve(l.to);
        // Regionalzug (REX, R …): gleichwertige S-Bahn desselben Abschnitts – zählt mit denselben Abfahrten
        const line = !f || !t ? null : l.line && net.lines.has(l.line) ? l.line : equivalentLine(net, l.mode, f, t);
        if (!f || !t || !line) return c.option; // nicht nachrechenbar – Stichprobe behalten
        legs.push({ line, from: f, to: t });
      }
      const labels = c.option.legs.filter((l) => l.mode !== 'W').map((l) => l.line);
      const r = await chainRoute(net, legs, fromId, toId, slotTime, q, c.key, labels).catch(() => null);
      if (!r?.route) return c.option;
      // Plausibilität: deutlich schlechter als die Stichprobe → Stichprobe behalten
      if (r.route.rideMin > c.rideMed * 1.5 + 15) return c.option;
      // Linienverlauf (Pfad) der Stichprobe behalten – die verkettete Fahrt hat dieselben Abschnitte
      return { ...r.route, legs: r.route.legs.map((l) => (l.mode === 'W' ? l : { ...l, path: c.option.legs.find((x) => x.mode === l.mode && x.fromStation === l.fromStation)?.path ?? l.path })) };
    }),
  );
  // mit Ø-Wartezeiten nur berechnete Verbindungen zeigen – nicht nachrechenbare Stichproben passen nicht dazu
  const shown = q.avgWait && chained.some((r) => r.steps) ? chained.filter((r) => r.steps || r.key === 'walk') : chained;
  shown.sort((a, b) => a.medianMin - b.medianMin || b.samples - a.samples);
  return shown;
}

// ---------------------------------------------------------------- User-Route nachrechnen

export interface UserRouteResult {
  route: RouteOption | null;
  durationMin: number | null;
  matchedRank: number | null;
  source: 'top' | 'computed' | 'none';
  error: string | null;
}

export function validateLegs(net: Network, legs: UserLeg[], mode: NetMode, restriction: Restriction | null, banned: string[] = []): string | null {
  if (!Array.isArray(legs) || legs.length === 0) return 'Keine Route angegeben.';
  if (legs.length > restrictionMaxLegs(restriction))
    return restriction ? `Einschränkung „${restrictionLabel(restriction, banned)}“ nicht eingehalten.` : 'Zu viele Teilstrecken.';
  for (const l of legs) {
    const line = net.lines.get(l.line);
    if (!line) return `Unbekannte Linie ${l.line}.`;
    if (!restrictionAllowsLine(restriction, banned, line))
      return `Einschränkung „${restrictionLabel(restriction!, banned)}“ nicht eingehalten (Linie ${l.line}).`;
    if (!net.stations.has(l.from) || !net.stations.has(l.to)) return 'Unbekannte Station.';
    if (!net.servesInOrder(l.line, l.from, l.to, mode))
      return `Linie ${l.line} fährt nicht von ${net.station(l.from).name} nach ${net.station(l.to).name}.`;
  }
  return null;
}

export async function evaluateUserRoute(
  net: Network,
  legs: UserLeg[],
  fromId: string,
  toId: string,
  slotTime: number,
  netMode: NetMode,
  q: RouteQuery,
  top: RouteOption[],
): Promise<UserRouteResult> {
  const invalid = validateLegs(net, legs, netMode, q.restriction, q.banned);
  if (invalid) return { route: null, durationMin: null, matchedRank: null, source: 'none', error: invalid };

  // gleiche Verbindungsart wie eine Top-Verbindung? (gleichwertige Linien zählen gleich)
  const sig = userSignature(net, legs);
  const rank = top.findIndex((r) => r.key === sig);
  if (rank >= 0) return { route: top[rank], durationMin: top[rank].medianMin, matchedRank: rank, source: 'top', error: null };

  const r = await chainRoute(net, legs, fromId, toId, slotTime, q, sig);
  if (!r.route) return { route: null, durationMin: null, matchedRank: null, source: 'none', error: r.error };
  return { route: r.route, durationMin: r.route.medianMin, matchedRank: null, source: 'computed', error: null };
}
