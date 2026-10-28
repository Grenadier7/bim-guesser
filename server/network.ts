import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { distM, normName } from '../shared/geo.ts';
import type { GameSettings, Headways, Line, NetMode, NetworkData, NetworkPublic, SlotId, Station, StationKind, StationRef } from '../shared/types.ts';
import { distanceRange, linePatterns } from '../shared/rules.ts';
import { inStationKinds } from '../shared/pools.ts';
import type { EfaPoint } from './efa.ts';
import { coversTime, timetableWarnings } from './timetable.ts';
import { STATE_DIR } from './paths.ts';

/** Ø-Takt je Linie (optional – fehlt die Datei, zeigt der Steckbrief einfach keinen Takt) */
function loadHeadways(): Headways['lines'] | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(path.dirname(FILE), 'headways.json'), 'utf8')) as Headways).lines;
  } catch {
    return undefined;
  }
}

/** Kein Start/Ziel-Paar möglich (Einstellungen zu eng) – wird im Spiel zur verständlichen Meldung */
export class NoPairError extends Error {}

export { distM };

const FILE = path.resolve(import.meta.dirname, '../data/network.json');
/** Wie oft jede Station schon Start/Ziel war – damit nicht dieselben ständig kommen */
const USAGE_FILE = path.join(STATE_DIR, 'usage.json');

/** Abwechslung innerhalb eines Spiels: so weit müssen neue Start/Ziele von bisherigen weg sein */
const AVOID_POINT_M = 1200;
/** … und eine Strecke gilt als "ähnlich", wenn beide Enden so nah an einer früheren liegen */
const SIMILAR_ROUTE_M = 3000;

export interface PastPair {
  a: { lat: number; lon: number };
  b: { lat: number; lon: number };
}



export class Network {
  readonly data: NetworkData;
  readonly stations = new Map<string, Station>();
  readonly lines = new Map<string, Line>();
  private efaToStation = new Map<string, string>();
  private usage = new Map<string, number>();
  private usageSave: NodeJS.Timeout | null = null;
  private byNorm = new Map<string, Station[]>();

  /** Adressen als Start/Ziel (Punkt 13): eigene „Stationen“ ohne Linien – nicht in `stations`, damit sie nie
   *  versehentlich als Haltestelle erkannt werden */
  private virtual = new Map<string, Station>();
  private addresses: [number, number, string, number][] = [];

  constructor(data: NetworkData) {
    this.data = data;
    try {
      this.addresses = (JSON.parse(readFileSync(path.join(path.dirname(FILE), 'addresses.json'), 'utf8')) as { addresses: [number, number, string, number][] }).addresses;
    } catch {
      /* ohne Adressdaten nur Haltestellen */
    }
    for (const s of data.stations) {
      this.stations.set(s.id, s);
      const k = normName(s.name);
      this.byNorm.set(k, [...(this.byNorm.get(k) ?? []), s]);
    }
    for (const l of data.lines) this.lines.set(l.id, l);
    for (const [sid, ids] of Object.entries(data.efaIds)) for (const id of ids) this.efaToStation.set(id, sid);
    try {
      for (const [id, n] of Object.entries(JSON.parse(readFileSync(USAGE_FILE, 'utf8')) as Record<string, number>)) this.usage.set(id, n);
    } catch {
      /* noch keine Statistik */
    }
  }

  /** Start/Ziel verwendet → seltener ziehen (gespeichert in data/usage.json) */
  markUsed(...ids: string[]) {
    for (const id of ids) this.usage.set(id, (this.usage.get(id) ?? 0) + 1);
    if (this.usageSave) return;
    this.usageSave = setTimeout(() => this.saveUsage(), 5000);
    this.usageSave.unref();
  }

  /** Statistik sofort schreiben (auch beim Beenden des Servers, Befund L-11) */
  saveUsage() {
    if (this.usageSave) clearTimeout(this.usageSave);
    this.usageSave = null;
    try {
      writeFileSync(USAGE_FILE, JSON.stringify(Object.fromEntries(this.usage)));
    } catch (e) {
      // nur Statistik – aber melden, damit man fehlende Rechte am Volume bemerkt
      console.warn(`Statistik ${USAGE_FILE} nicht beschreibbar: ${(e as Error).message}`);
    }
  }

  static load(): Network {
    try {
      return new Network(JSON.parse(readFileSync(FILE, 'utf8')));
    } catch (e) {
      throw new Error(`data/network.json fehlt oder ist kaputt – zuerst "npm run build:data" ausführen. (${(e as Error).message})`);
    }
  }

  /**
   * Referenztage zu alt? Die Auskunft kennt nur einige Monate zurück – danach liefert „Reguläres Netz“ nichts mehr
   * (Befund M-07). Liefert Warntexte für Log und /api/health.
   */
  referenceWarnings(now = new Date()): string[] {
    const out: string[] = timetableWarnings(now);
    for (const [type, day] of Object.entries(this.data.regularDays)) {
      // mit eigenem Referenzfahrplan braucht es die Auskunft für diesen Tag nicht
      if (coversTime(Date.UTC(+day.date.slice(0, 4), +day.date.slice(5, 7) - 1, +day.date.slice(8, 10), 12) / 60000)) continue;
      const ageDays = (now.getTime() - new Date(`${day.date}T12:00:00Z`).getTime()) / 86400000;
      if (ageDays > 150) out.push(`Referenztag ${type}=${day.date} ist ${Math.round(ageDays)} Tage alt – die Auskunft kennt ihn evtl. nicht mehr. Netzdaten neu bauen (npm run build:data).`);
    }
    return out;
  }

  publicData(): NetworkPublic {
    const { efaIds: _omit, ...pub } = this.data;
    return { ...pub, headways: loadHeadways(), addressCount: this.addresses.length };
  }

  station(id: string): Station {
    const s = this.stations.get(id) ?? this.virtual.get(id);
    if (!s) throw new Error(`Unbekannte Station ${id}`);
    return s;
  }

  ref(id: string): StationRef {
    const { name, lat, lon } = this.station(id);
    return { id, name, lat, lon };
  }

  mainEfaId(stationId: string): string {
    const v = this.virtual.get(stationId);
    if (v) return `coord:${v.lon}:${v.lat}`;
    return this.data.efaIds[stationId][0];
  }

  get hasAddresses(): boolean {
    return this.addresses.length > 0;
  }

  /**
   * Zufälliges Adress-Paar (gleichmäßig über die bebaute Fläche, siehe scripts/build-addresses.ts) mit denselben
   * Regeln wie bei Haltestellen: Entfernung, Fokus-Kreis, Abwechslung zu früheren Runden.
   */
  randomAddressPair(s: GameSettings, past: PastPair[] = []): [Station, Station] {
    if (this.addresses.length < 2) throw new NoPairError('Keine Adressdaten vorhanden – bitte „Haltestellen“ wählen.');
    const [minD, maxD] = distanceRange(s.distance);
    const all = this.addresses.map(([lat, lon, name, district], i) => ({ i, lat, lon, name, district }));
    const inFocus = s.focus ? all.filter((x) => distM(x, s.focus!) <= s.focus!.radiusM) : [];
    // je Ende: mit Wahrscheinlichkeit `share` aus dem Fokus-Kreis, sonst aus ganz Wien
    const pick = () => {
      const pool = inFocus.length && Math.random() < s.focus!.share ? inFocus : all;
      return pool[Math.floor(Math.random() * pool.length)];
    };
    const points = past.flatMap((p) => [p.a, p.b]);
    for (let n = 0; n < 3000; n++) {
      const a = pick();
      const b = pick();
      const d = distM(a, b);
      const min = n < 1000 ? minD : Math.min(minD, 1500);
      if (a === b || d < min || d > maxD) continue;
      if (n < 2000 && points.some((p) => distM(p, a) < AVOID_POINT_M || distM(p, b) < AVOID_POINT_M)) continue;
      return [this.addVirtual(a), this.addVirtual(b)];
    }
    throw new NoPairError('Kein passendes Adress-Paar gefunden – bitte andere Entfernung wählen.');
  }

  private addVirtual(x: { i: number; lat: number; lon: number; name: string; district: number }): Station {
    const id = `a:${x.i}`;
    const st: Station = { id, name: x.name, lat: x.lat, lon: x.lon, modes: [], lines: [], district: x.district };
    this.virtual.set(id, st);
    return st;
  }

  isAddress(id: string): boolean {
    return this.virtual.has(id);
  }

  /** EFA-Haltestelle -> unsere Station (über ID, sonst Name + Nähe) */
  resolve(p: EfaPoint): string | null {
    const direct = this.efaToStation.get(p.id);
    if (direct) return direct;
    if (!p.lat) return null;
    const sameName = (this.byNorm.get(normName(p.name)) ?? []).filter((s) => distM(s, p) < 800);
    if (sameName.length) return sameName[0].id;
    let best: Station | null = null;
    let bestD = 120;
    for (const s of this.stations.values()) {
      const d = distM(s, p);
      if (d < bestD) (best = s), (bestD = d);
    }
    return best?.id ?? null;
  }

  /** Fährt die Linie im gewählten Netz (in irgendeiner Richtung/Variante) von a nach b? */
  servesInOrder(lineId: string, a: string, b: string, net: NetMode): boolean {
    const line = this.lines.get(lineId);
    if (!line) return false;
    return linePatterns(line, net).some((p) => {
      const i = p.indexOf(a);
      return i >= 0 && p.indexOf(b, i + 1) > i;
    });
  }

  /** Linien, die im gewählten Netz an der Station halten */
  linesAt(stationId: string, net: NetMode): Line[] {
    // Adresse: Linien der Haltestellen in der Nähe (≤ 500 m, am Stadtrand bis 200 m weiter als die nächste) – für den
    // Tipp „Linien am Start/Ziel“
    if (this.virtual.has(stationId)) {
      const at = this.station(stationId);
      const all = [...this.stations.values()]
        .filter((s) => s.lines.length && distM(s, at) <= 3000)
        .map((s) => ({ d: distM(s, at), lines: this.linesAt(s.id, net) }))
        .filter((x) => x.lines.length);
      const reach = Math.max(500, Math.min(...all.map((x) => x.d)) + 200);
      return [...new Set(all.filter((x) => x.d <= reach).flatMap((x) => x.lines))];
    }
    return this.station(stationId)
      .lines.map((id) => this.lines.get(id)!)
      .filter((l) => linePatterns(l, net).some((p) => p.includes(stationId)));
  }

  private candidateCache = new Map<string, Station[]>();

  /** Stationen, die für die Einstellungen in Frage kommen (gecacht) */
  candidates(pool: StationKind[], slot: SlotId, net: NetMode): Station[] {
    const key = `${pool.join(',')}|${slot === 'sa02' ? 'n' : 'd'}|${net}`;
    let hit = this.candidateCache.get(key);
    if (!hit) this.candidateCache.set(key, (hit = this.computeCandidates(pool, slot, net)));
    return hit;
  }

  private computeCandidates(pool: StationKind[], slot: SlotId, net: NetMode): Station[] {
    const night = slot === 'sa02';
    return [...this.stations.values()].filter((s) => {
      if (!this.linesAt(s.id, net).length) return false;
      // nachts nur Stationen mit U-Bahn oder Nachtbus
      if (night && !s.modes.includes('U') && !s.modes.includes('N')) return false;
      return inStationKinds(s, pool, (id) => this.lines.get(id));
    });
  }

  /**
   * Zufälliges Start/Ziel-Paar. Mit Fokus-Kreis wird jede Station mit Wahrscheinlichkeit
   * `focus.share` aus dem Kreis gezogen, sonst aus ganz Wien.
   */
  randomPair(s: GameSettings, exclude: Set<string>, past: PastPair[] = []): [Station, Station] {
    const all = this.candidates(s.stations, s.slot, s.network);
    if (all.length < 2) throw new NoPairError('Mit diesen Einstellungen gibt es zu wenige Haltestellen – bitte mehr Haltestellen-Arten wählen.');
    // bereits gespielte Stationen meiden – außer der Pool wäre dann zu klein (z.B. viele Runden mit wenigen Stationen)
    const fresh = all.filter((x) => !exclude.has(x.id));
    const pool = fresh.length >= 2 ? fresh : all;
    const inFocus = s.focus ? pool.filter((x) => distM(x, s.focus!) <= s.focus!.radiusM) : [];
    const [minD, maxD] = distanceRange(s.distance);
    // selten gezogene Stationen bevorzugen: Gewicht 1 / (1 + bisherige Ziehungen)²
    const sampler = (list: Station[]) => {
      const cum: number[] = [];
      let sum = 0;
      for (const x of list) cum.push((sum += 1 / (1 + (this.usage.get(x.id) ?? 0)) ** 2));
      return () => {
        const r = Math.random() * sum;
        let lo = 0;
        let hi = cum.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] < r) lo = mid + 1;
          else hi = mid;
        }
        return list[lo];
      };
    };
    const fromPool = sampler(pool);
    const fromFocus = inFocus.length ? sampler(inFocus) : null;
    const pick = () => (fromFocus && Math.random() < s.focus!.share ? fromFocus() : fromPool());
    const points = past.flatMap((p) => [p.a, p.b]);
    for (let i = 0; i < 3000; i++) {
      // bei kleinen Kreisen darf die Mindestdistanz nach vielen Versuchen etwas schrumpfen
      const min = i < 1000 ? minD : Math.min(minD, 1500);
      const a = pick();
      const b = pick();
      const d = distM(a, b);
      if (a === b || d < min || d > maxD) continue;
      // Abwechslung: nicht wieder dieselbe Gegend (wird nach vielen Versuchen gelockert)
      const strict = i < 2000;
      if (strict && points.some((p) => distM(p, a) < AVOID_POINT_M || distM(p, b) < AVOID_POINT_M)) continue;
      const similar = past.some(
        (p) =>
          (distM(p.a, a) < SIMILAR_ROUTE_M && distM(p.b, b) < SIMILAR_ROUTE_M) ||
          (distM(p.a, b) < SIMILAR_ROUTE_M && distM(p.b, a) < SIMILAR_ROUTE_M),
      );
      if (strict && similar) continue;
      return [a, b];
    }
    throw new NoPairError('Kein passendes Stationspaar gefunden – bitte andere Entfernung oder mehr Haltestellen wählen.');
  }
}
