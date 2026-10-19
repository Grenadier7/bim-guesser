// Netzgraph: alle Linien als Strecken zwischen Stationen, jede Strecke als weiche Bézier-Kurve exakt durch die
// Stationspunkte. Die Richtung an einer Station zeigt zur geradesten Fortsetzung (gleiche Linien bevorzugt) –
// so gibt es keine Knicke, und Linien auf derselben Strecke liegen genau übereinander.
// Reine Berechnung ohne Leaflet/DOM – gezeichnet wird in netmap.ts, getestet in test/netgraph.test.ts.
import type { Line, Station } from '../../shared/types.ts';
import { patternsOf } from './learn/model.ts';
import type { NetIndex } from './net.ts';

export type LL = [number, number];
type XY = [number, number];
export type Kind = 'U' | 'S' | 'T' | 'B';

/** Busse, die in den Kursen als Querverbindung erklärt werden – nur die gehören zur Grundkarte */
export const MAP_BUSES = ['13A', '10A', '48A'];

export interface Edge {
  key: string;
  kind: Kind;
  a: string;
  b: string;
  lines: Set<string>;
  /** je Linie die befahrene Richtung: 1 = a→b, 2 = b→a, 3 = beide */
  dirs: Map<string, number>;
  /** Kurve von a nach b */
  curve: LL[];
}

export const kindOf = (l: Line): Kind | null =>
  l.mode === 'U' || l.mode === 'S' || l.mode === 'T' ? l.mode : l.mode === 'B' || l.mode === 'N' ? 'B' : null;
const edgeKey = (kind: Kind, a: string, b: string) => `${kind}:${a < b ? `${a}|${b}` : `${b}|${a}`}`;
const baseLine = (l: Line) => l.mode === 'U' || l.mode === 'S' || l.mode === 'T' || (l.mode === 'B' && MAP_BUSES.includes(l.id));

export class NetGraph {
  readonly net: NetIndex;
  readonly lines: Line[];
  readonly edges = new Map<string, Edge>();
  /** Station → Linien, die dort halten */
  readonly nodeLines = new Map<string, Set<string>>();
  /** Linie → Endstation → Nachbarstation (für die Richtung des Nummernschilds); Kurzführungen zählen nicht */
  readonly terminals = new Map<string, Map<string, string>>();
  private xy = new Map<string, XY>();
  private k = Math.cos((48.2 * Math.PI) / 180) * 111_320;
  private adj = new Map<string, Map<string, string>>(); // kind:Station → Nachbar → Strecke

  constructor(net: NetIndex, filter: (l: Line) => boolean = baseLine) {
    this.net = net;
    this.lines = net.data.lines.filter((l) => kindOf(l) && filter(l) && patternsOf(l).length);
    const seqs: { line: Line; kind: Kind; seq: string[] }[] = [];
    for (const line of this.lines) {
      const kind = kindOf(line)!;
      const ends = new Map<string, string>();
      const longest = Math.max(...patternsOf(line).map((p) => p.length));
      for (const p of patternsOf(line)) {
        const seq = p.filter((id, i) => id !== p[i - 1]);
        if (seq.length < 2) continue;
        seqs.push({ line, kind, seq });
        if (seq.length >= longest * 0.75) {
          ends.set(seq[0], seq[1]);
          ends.set(seq[seq.length - 1], seq[seq.length - 2]);
        }
        for (const id of seq) {
          if (!this.xy.has(id)) {
            const s = net.station(id);
            this.xy.set(id, [s.lon * this.k, s.lat * 111_320]);
          }
          if (!this.nodeLines.has(id)) this.nodeLines.set(id, new Set());
          this.nodeLines.get(id)!.add(line.id);
        }
      }
      this.terminals.set(line.id, ends);
    }
    for (const { line, kind, seq } of seqs) for (let i = 1; i < seq.length; i++) this.addEdge(kind, seq[i - 1], seq[i], line.id);
    // Abkürzungen (Variante lässt eine Station aus) durch den Weg über die Station ersetzen
    for (const e of [...this.edges.values()]) {
      const via = this.viaNode(e);
      if (!via) continue;
      this.removeEdge(e);
      for (const [l, d] of e.dirs) {
        if (d & 1) {
          this.addEdge(e.kind, e.a, via, l);
          this.addEdge(e.kind, via, e.b, l);
        }
        if (d & 2) {
          this.addEdge(e.kind, e.b, via, l);
          this.addEdge(e.kind, via, e.a, l);
        }
      }
    }
    for (const e of this.edges.values()) e.curve = this.curve(e);
  }

  has(lineId: string) {
    return this.terminals.has(lineId);
  }

  private addEdge(kind: Kind, a: string, b: string, line: string) {
    const key = edgeKey(kind, a, b);
    let e = this.edges.get(key);
    if (!e) {
      e = { key, kind, a, b, lines: new Set(), dirs: new Map(), curve: [] };
      this.edges.set(key, e);
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        const k = `${kind}:${x}`;
        if (!this.adj.has(k)) this.adj.set(k, new Map());
        this.adj.get(k)!.set(y, key);
      }
    }
    e.lines.add(line);
    e.dirs.set(line, (e.dirs.get(line) ?? 0) | (a === e.a ? 1 : 2));
  }

  private removeEdge(e: Edge) {
    this.edges.delete(e.key);
    this.adj.get(`${e.kind}:${e.a}`)?.delete(e.b);
    this.adj.get(`${e.kind}:${e.b}`)?.delete(e.a);
  }

  /** Station zwischen a und b, über die eine andere Variante fährt (kaum Umweg) */
  private viaNode(e: Edge): string | null {
    const d = this.dist(e.a, e.b);
    for (const [v] of this.adj.get(`${e.kind}:${e.a}`) ?? []) {
      if (v === e.b || !this.adj.get(`${e.kind}:${v}`)?.has(e.b)) continue;
      if (this.dist(e.a, v) + this.dist(v, e.b) < d * 1.25) return v;
    }
    return null;
  }

  private dist(a: string, b: string) {
    const [ax, ay] = this.xy.get(a)!;
    const [bx, by] = this.xy.get(b)!;
    return Math.hypot(bx - ax, by - ay);
  }

  /** Richtung von `from` nach `to` (Ost, Nord), Länge 1 */
  dir(from: string, to: string): XY {
    const [ax, ay] = this.xy.get(from)!;
    const [bx, by] = this.xy.get(to)!;
    const d = Math.hypot(bx - ax, by - ay) || 1;
    return [(bx - ax) / d, (by - ay) / d];
  }

  /** Fahrtrichtung in `n`, wenn man von `from` kommt: zur geradesten Fortsetzung (gleiche Linien bevorzugt) */
  private tangent(kind: Kind, n: string, from: string): XY {
    const inLines = this.edges.get(edgeKey(kind, from, n))?.lines ?? new Set<string>();
    const dirIn = this.dir(from, n);
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const [q, key] of this.adj.get(`${kind}:${n}`) ?? []) {
      if (q === from) continue;
      const out = this.dir(n, q);
      const cos = dirIn[0] * out[0] + dirIn[1] * out[1];
      if (cos < -0.1) continue; // Kehrtwende
      const shared = [...this.edges.get(key)!.lines].filter((l) => inLines.has(l)).length;
      const score = shared * 2 + cos;
      if (score > bestScore) {
        bestScore = score;
        best = q;
      }
    }
    return best ? this.dir(from, best) : dirIn;
  }

  private curve(e: Edge): LL[] {
    const [ax, ay] = this.xy.get(e.a)!;
    const [bx, by] = this.xy.get(e.b)!;
    const d = Math.hypot(bx - ax, by - ay);
    const ta = this.tangent(e.kind, e.a, e.b); // b → a → weiter; umgedreht = Richtung in a nach b
    const tb = this.tangent(e.kind, e.b, e.a);
    const h = d * 0.36;
    const p1: XY = [ax - ta[0] * h, ay - ta[1] * h];
    const p2: XY = [bx - tb[0] * h, by - tb[1] * h];
    const n = Math.max(2, Math.min(18, Math.ceil(d / 45)));
    const out: LL[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const x = u * u * u * ax + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * bx;
      const y = u * u * u * ay + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * by;
      out.push([y / 111_320, x / this.k]);
    }
    return out;
  }

  station(id: string): Station {
    return this.net.station(id);
  }

  /** Stationen einer Linie von `from` bis `to` (nach Namen) */
  stationsAlong(lineId: string, from: string, to: string): string[] {
    const line = this.net.lines.get(lineId);
    if (!line || !this.has(lineId)) return [];
    for (const p of patternsOf(line)) {
      const i = p.findIndex((id) => this.net.station(id).name === from);
      const j = p.findIndex((id) => this.net.station(id).name === to);
      if (i < 0 || j < 0) continue;
      return i <= j ? p.slice(i, j + 1) : p.slice(j, i + 1).reverse();
    }
    return [];
  }

  /** Kurve entlang einer Linie von Station `from` bis `to` (nach Namen) */
  along(lineId: string, from: string, to: string): LL[] {
    const line = this.net.lines.get(lineId);
    return line ? this.path(kindOf(line)!, this.stationsAlong(lineId, from, to)) : [];
  }

  /** Stationsfolge → durchgehende Kurve über die Strecken (auch über ersetzte Abkürzungen) */
  path(kind: Kind, seq: string[]): LL[] {
    const out: LL[] = [];
    for (let i = 1; i < seq.length; i++) {
      const [a, b] = [seq[i - 1], seq[i]];
      const direct = this.edges.get(edgeKey(kind, a, b));
      let parts: Edge[] = direct ? [direct] : [];
      if (!direct)
        for (const [v] of this.adj.get(`${kind}:${a}`) ?? []) {
          const e2 = this.edges.get(edgeKey(kind, v, b));
          if (e2) {
            parts = [this.edges.get(edgeKey(kind, a, v))!, e2];
            break;
          }
        }
      let from = a;
      for (const p of parts) {
        const c = p.a === from ? p.curve : [...p.curve].reverse();
        out.push(...(out.length ? c.slice(1) : c));
        from = p.a === from ? p.b : p.a;
      }
    }
    return out;
  }
}
