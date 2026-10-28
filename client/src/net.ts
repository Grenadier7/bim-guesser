// Netz-Hilfen im Browser: Linien suchen, Einstiege und Ausstiege ermitteln.
import type { Line, NetMode, NetworkPublic, Restriction, Station } from '../../shared/types.ts';
import { distM } from '../../shared/geo.ts';
import { linePatterns, restrictionAllowsLine } from '../../shared/rules.ts';

export { distM };


export function fmtDist(m: number): string {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

export interface Direction {
  label: string;
  stations: Station[];
  /** Endstation(en) dieser Richtung */
  terminals: Station[];
  /** Einstieg, falls nicht an der aktuellen Station (Gegenrichtung hält dort nicht) */
  board?: Station;
  walkM?: number;
}

/** so weit darf der Weg zur Haltestelle der Gegenrichtung höchstens sein */
const ALT_BOARD_MAX_M = 700;

export class NetIndex {
  readonly data: NetworkPublic;
  readonly stations = new Map<string, Station>();
  readonly lines = new Map<string, Line>();
  mode: NetMode = 'regular';

  constructor(data: NetworkPublic) {
    this.data = data;
    for (const s of data.stations) this.stations.set(s.id, s);
    for (const l of data.lines) this.lines.set(l.id, l);
  }

  /** Adressen als Start/Ziel (Punkt 13): ohne Linien, nicht in `stations` (Suche, Netzkarte bleiben unberührt) */
  private virtual = new Map<string, Station>();

  station(id: string): Station {
    return this.stations.get(id) ?? this.virtual.get(id)!;
  }

  /** Start/Ziel aus dem Spielzustand bekannt machen (Haltestelle: schon da; Adresse: neu anlegen) */
  ensure(ref: { id: string; name: string; lat: number; lon: number }): Station {
    const known = this.stations.get(ref.id) ?? this.virtual.get(ref.id);
    if (known) return known;
    const st: Station = { id: ref.id, name: ref.name, lat: ref.lat, lon: ref.lon, modes: [], lines: [], district: 0 };
    this.virtual.set(ref.id, st);
    return st;
  }

  patterns(line: Line): string[][] {
    return linePatterns(line, this.mode);
  }

  /** Linien im aktuellen Netzmodus, passend zur Eingabe (und zur Einschränkung der Runde) */
  searchLines(q: string, restriction: Restriction | null = null, banned: string[] = []): Line[] {
    const query = q.trim().toLowerCase().replace(/\s+/g, '');
    if (!query) return [];
    const all = this.data.lines.filter((l) => this.patterns(l).length && restrictionAllowsLine(restriction, banned, l));
    const exact = all.filter((l) => l.id.toLowerCase() === query);
    const prefix = all.filter((l) => l.id.toLowerCase().startsWith(query) && !exact.includes(l));
    return [...exact, ...prefix].slice(0, 14);
  }

  /** Stationen der Linie, nach Entfernung zu einem Punkt sortiert */
  boardOptions(line: Line, near: Station, limit = 6): { station: Station; dist: number }[] {
    const ids = new Set(this.patterns(line).flat());
    return [...ids]
      .map((id) => ({ station: this.station(id), dist: id === near.id ? 0 : distM(this.station(id), near) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit);
  }

  /** Mögliche Ausstiege ab einer Station, gruppiert nach Richtung */
  directions(line: Line, board: string): Direction[] {
    const groups = new Map<string, string[][]>();
    for (const p of this.patterns(line)) {
      const i = p.indexOf(board);
      if (i < 0 || i === p.length - 1) continue;
      const rest = p.slice(i + 1);
      groups.set(rest[0], [...(groups.get(rest[0]) ?? []), rest]);
    }
    const out: Direction[] = [];
    for (const rests of groups.values()) {
      rests.sort((a, b) => b.length - a.length);
      const order: string[] = [];
      for (const r of rests) for (const id of r) if (!order.includes(id)) order.push(id);
      const ends = [...new Set(rests.map((r) => r[r.length - 1]))].map((id) => this.station(id));
      const names = [...new Set(ends.map((s) => s.name))];
      out.push({ label: `Richtung ${names.join(' / ')}`, stations: order.map((id) => this.station(id)), terminals: ends });
    }
    return out;
  }

  /**
   * Haltestellen der Linie als durchgehende Liste von einer Endstation zur anderen, mit der
   * Einstiegs-Station mittendrin: oben die nördlichere Richtung (Endstation zuerst), unten die andere.
   */
  lineThrough(line: Line, board: string): { up: Direction | null; down: Direction | null } {
    const dirs = this.directions(line, board);
    const north = (d: Direction) => Math.max(...d.terminals.map((s) => s.lat));
    if (!dirs.length) return { up: null, down: null };
    if (dirs.length === 1) {
      // Hält die Linie hier nur in eine Richtung (Schleife, Einbahn)? Dann die Gegenrichtung ab der
      // nächstgelegenen Haltestelle anbieten – sonst (echte Endstation) einfach nach unten
      const alt = this.oppositeDirection(line, board, dirs[0]);
      if (!alt) return { up: null, down: dirs[0] };
      dirs.push(alt);
    }
    const [a, b] = [...dirs].sort((x, y) => north(y) - north(x));
    // weitere Äste (selten) hängen unten an
    const down: Direction = dirs.length > 2
      ? { label: dirs.filter((d) => d !== a).map((d) => d.label).join(' / '), stations: dirs.filter((d) => d !== a).flatMap((d) => d.stations), terminals: dirs.filter((d) => d !== a).flatMap((d) => d.terminals) }
      : b;
    return { up: { ...a, stations: [...a.stations].reverse() }, down };
  }

  /** Gegenrichtung ab einer nahen Haltestelle, wenn die Linie an `board` nur in eine Richtung hält */
  private oppositeDirection(line: Line, board: string, main: Direction): Direction | null {
    const here = this.station(board);
    const known = new Set([board, ...main.stations.map((s) => s.id)]);
    let best: Direction | null = null;
    for (const p of this.patterns(line)) {
      if (p.includes(board)) continue;
      for (let i = 0; i < p.length - 1; i++) {
        const st = this.station(p[i]);
        const d = distM(here, st);
        if (d > ALT_BOARD_MAX_M || (best && d >= best.walkM!)) continue;
        const rest = p.slice(i + 1).filter((id) => !known.has(id));
        // nur echte Gegenrichtungen – nicht die letzte Station vor einer Endstelle
        if (rest.length < 2) continue;
        const end = this.station(p[p.length - 1]);
        best = { label: `Richtung ${end.name}`, stations: rest.map((id) => this.station(id)), terminals: [end], board: st, walkM: d };
      }
    }
    if (best) best.label += ` – Einstieg ${best.board!.name} (🚶 ${fmtDist(best.walkM!)})`;
    return best;
  }

  /** Koordinaten der Fahrt von a nach b entlang einer Haltefolge */
  legPath(line: Line, a: string, b: string): [number, number][] {
    for (const p of this.patterns(line)) {
      const i = p.indexOf(a);
      const j = i >= 0 ? p.indexOf(b, i + 1) : -1;
      if (j > i) return p.slice(i, j + 1).map((id) => [this.station(id).lat, this.station(id).lon]);
    }
    const sa = this.station(a);
    const sb = this.station(b);
    return [
      [sa.lat, sa.lon],
      [sb.lat, sb.lon],
    ];
  }

  stopsBetween(line: Line, a: string, b: string): number {
    return this.legPath(line, a, b).length - 1;
  }
}
