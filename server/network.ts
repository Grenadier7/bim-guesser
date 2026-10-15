import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameSettings, Line, NetMode, NetworkData, NetworkPublic, SlotId, Station, StationKind, StationRef } from '../shared/types.ts';
import { distanceRange, linePatterns } from '../shared/rules.ts';
import { inStationKinds } from '../shared/pools.ts';
import type { EfaPoint } from './efa.ts';

const FILE = path.resolve(import.meta.dirname, '../data/network.json');

export function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function normName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+(S\s*U|U\s*S|S|U)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export class Network {
  readonly data: NetworkData;
  readonly stations = new Map<string, Station>();
  readonly lines = new Map<string, Line>();
  private efaToStation = new Map<string, string>();
  private byNorm = new Map<string, Station[]>();

  constructor(data: NetworkData) {
    this.data = data;
    for (const s of data.stations) {
      this.stations.set(s.id, s);
      const k = normName(s.name);
      this.byNorm.set(k, [...(this.byNorm.get(k) ?? []), s]);
    }
    for (const l of data.lines) this.lines.set(l.id, l);
    for (const [sid, ids] of Object.entries(data.efaIds)) for (const id of ids) this.efaToStation.set(id, sid);
  }

  static load(): Network {
    try {
      return new Network(JSON.parse(readFileSync(FILE, 'utf8')));
    } catch (e) {
      throw new Error(`data/network.json fehlt oder ist kaputt – zuerst "npm run build:data" ausführen. (${(e as Error).message})`);
    }
  }

  publicData(): NetworkPublic {
    const { efaIds: _omit, ...pub } = this.data;
    return pub;
  }

  station(id: string): Station {
    const s = this.stations.get(id);
    if (!s) throw new Error(`Unbekannte Station ${id}`);
    return s;
  }

  ref(id: string): StationRef {
    const { name, lat, lon } = this.station(id);
    return { id, name, lat, lon };
  }

  mainEfaId(stationId: string): string {
    return this.data.efaIds[stationId][0];
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
  randomPair(s: GameSettings, exclude: Set<string>): [Station, Station] {
    const pool = this.candidates(s.stations, s.slot, s.network).filter((x) => !exclude.has(x.id));
    const inFocus = s.focus ? pool.filter((x) => distM(x, s.focus!) <= s.focus!.radiusM) : [];
    const [minD, maxD] = distanceRange(s.distance);
    const pick = () => {
      const fromFocus = inFocus.length > 0 && Math.random() < s.focus!.share;
      const src = fromFocus ? inFocus : pool;
      return src[Math.floor(Math.random() * src.length)];
    };
    for (let i = 0; i < 2000; i++) {
      // bei kleinen Kreisen darf die Mindestdistanz nach vielen Versuchen etwas schrumpfen
      const min = i < 1000 ? minD : Math.min(minD, 1500);
      const a = pick();
      const b = pick();
      const d = distM(a, b);
      if (a !== b && d >= min && d <= maxD) return [a, b];
    }
    throw new Error('Kein passendes Stationspaar gefunden');
  }
}
