// Netzkarte: alle U-, S-Bahn- und Bim-Linien als weiche Kurven, die exakt durch die Stationspunkte laufen.
// Jede Strecke zwischen zwei Stationen ist eine Bézier-Kurve; die Richtung an der Station zeigt zur geraden
// Fortsetzung. So gibt es keine Knicke, und Linien auf derselben Strecke liegen genau übereinander.
// Alle Ansichten (Kurse, Test) zeichnen dieselbe Karte und blenden nur Linien hervor oder aus.
import L from 'leaflet';
import type { Line, Station } from '../../shared/types.ts';
import { distM } from './net.ts';
import { NET_COLOR } from './netcolors.ts';
import { kindOf, NetGraph, type Edge, type Kind, type LL } from './netgraph.ts';
import { app } from './store.ts';
import { esc } from './ui.ts';

export { kindOf, MAP_BUSES, NetGraph, type Kind } from './netgraph.ts';
export { NET_COLOR };

const CENTER = { lat: 48.2085, lon: 16.3731 }; // Stephansplatz

// ---------------------------------------------------------------- Darstellung

/** Abschnitt einer Linie, der eigens hervorgehoben wird (z.B. Ringstraße, ein Ast der Stammstrecke) */
export interface Piece {
  line: string;
  from: string;
  to: string;
  color?: string;
  /** Nummernschild (Standard: Liniennummer); leer = keins */
  label?: string;
  /** wo entlang des Abschnitts das Schild sitzt (0 = Anfang, 1 = Ende) */
  labelFrac?: number;
}

export interface NetView {
  kinds: Set<Kind>;
  /** hervorgehobene Linien – alle anderen blass. Leer (und keine Abschnitte) = ganzes Netz normal */
  focus: Set<string>;
  /** verbindende Linien: in Farbe, aber zurückgenommen */
  context?: Set<string>;
  /** eigene Farben (z.B. Busse nach Zehnerstelle) */
  colors?: Record<string, string>;
  pieces?: Piece[];
  /** markierte Stationen (Name dauerhaft, wenn es wenige sind) */
  marks?: Station[];
  bands: { ring: boolean; guertel: boolean; vorort: boolean };
  hubs: boolean;
  /** Liniennummern an den Endstationen */
  labels: boolean;
  /** jede Linie genau einmal (am äußeren Ende) beschriften – auch auf Stadt-Zoom */
  allLabels?: boolean;
  /** nur diese Linien der Grundkarte zeichnen (z.B. leise Orientierung beim Nachzeichnen) */
  only?: Set<string>;
  /** zusätzliche Haltestellen als kleine, anklickbare Punkte */
  stops?: Station[];
  /** noch mehr Haltestellen (z.B. alle in Wien) – erst ab Zoom 14 sichtbar */
  allStops?: Station[];
  /** Linie angetippt (nur hervorgehobene Linien sind anklickbar) */
  onLine?: (id: string) => void;
  /** Haltestelle angetippt */
  onStation?: (id: string) => void;
  /** ganzes Netz blass – als Hintergrund unter Routen (Routenjagd, Training) */
  dimAll?: boolean;
  /** still: keine Namen beim Drüberfahren, keine Nummern, keine Knotennamen (Quizfragen sollen nichts verraten) */
  quiet?: boolean;
}

export const NO_BANDS: NetView['bands'] = { ring: false, guertel: false, vorort: false };

export const BANDS: Record<keyof NetView['bands'], { label: string; parts: [string, string, string][] }> = {
  ring: {
    label: 'Ring',
    parts: [
      ['2', 'Schwedenplatz', 'Parlament'],
      ['1', 'Parlament', 'Schwedenplatz'],
    ],
  },
  guertel: {
    label: 'Gürtel',
    parts: [
      ['U6', 'Spittelau', 'Gumpendorfer Straße'],
      ['18', 'Gumpendorfer Straße', 'St. Marx'],
    ],
  },
  vorort: { label: 'Vorortelinie', parts: [['S45', 'Heiligenstadt', 'Hütteldorf']] },
};

const STYLE: Record<Kind, { w: number; case: number; dash?: string }> = {
  B: { w: 2.4, case: 2, dash: '5 4' },
  T: { w: 2.6, case: 2.2 },
  S: { w: 4.2, case: 2.6 },
  U: { w: 6, case: 3 },
};

/** Punkt nach `frac` der Länge eines Linienzugs */
function pointAlong(path: LL[], frac: number): LL {
  const seg = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], (p[1] - path[i][1]) * 0.66));
  let rest = seg.reduce((a, b) => a + b, 0) * frac;
  for (let i = 0; i < seg.length; i++) {
    if (rest <= seg[i] && seg[i] > 0) {
      const t = rest / seg[i];
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t];
    }
    rest -= seg[i];
  }
  return path[path.length - 1];
}

export class NetMapLayer {
  private group = L.layerGroup();
  // eigene Ebenen: Linien unter allem anderen (Routen, Skizzen liegen darüber), Beschriftungen darüber
  private renderer = L.svg({ padding: 0.5, pane: 'netPane' });
  private map: L.Map;
  readonly graph: NetGraph;
  /** Busse und Nachtlinien, die nicht zur Grundkarte gehören – nur bei Bedarf berechnet */
  private extraGraph: NetGraph | null = null;

  constructor(map: L.Map, graph: NetGraph) {
    this.map = map;
    this.graph = graph;
    if (!map.getPane('netPane')) map.createPane('netPane').style.zIndex = '350';
    if (!map.getPane('netLabels')) map.createPane('netLabels').style.zIndex = '450';
    this.group.addTo(map);
    map.on('zoomend', this.onZoom);
    this.onZoom();
  }

  /** Auf Stadt-Zoom Kleinkram ausblenden (Bim-Nummern, kleine Knoten, einfache Stationen) */
  private onZoom = () => {
    const z = this.map.getZoom();
    this.map.getContainer().classList.toggle('net-z-low', z < 12.5);
    this.map.getContainer().classList.toggle('net-z-mid', z < 14);
  };

  clear() {
    this.group.clearLayers();
  }

  private get extra(): NetGraph {
    this.extraGraph ??= new NetGraph(this.graph.net, (l) => (l.mode === 'B' || l.mode === 'N') && !this.graph.has(l.id));
    return this.extraGraph;
  }

  /** Farbe einer Linie in dieser Ansicht */
  private lineColor(id: string, v: NetView, focus = false): string {
    if (v.colors?.[id]) return v.colors[id];
    const l = this.graph.net.lines.get(id);
    if (!l) return '#333';
    if (l.mode === 'U') return l.color;
    if (l.mode === 'S') return NET_COLOR.S;
    if (l.mode === 'N') return NET_COLOR.N;
    if (l.mode === 'B') return NET_COLOR.B;
    if (id === 'BB') return NET_COLOR.BB;
    return focus ? NET_COLOR.Tfocus : NET_COLOR.T;
  }

  /** zeichnet die Ansicht; gibt die Punkte zurück, auf die die Karte passen soll */
  render(v: NetView): LL[] {
    this.group.clearLayers();
    const g = this.graph;
    const r = this.renderer;
    const pieces = (v.pieces ?? []).filter((p) => g.has(p.line) || this.extra.has(p.line));
    const context = v.context ?? new Set<string>();
    const dim = v.focus.size > 0 || pieces.length > 0 || !!v.only || !!v.dimAll;
    const shown = (l: string) => !v.only || v.only.has(l) || v.focus.has(l);
    /** hervorgehobene Strecken, die anklickbar werden */
    const hits: { curve: LL[]; ids: string[] }[] = [];
    const arrows: { curve: LL[]; back: boolean; color: string }[] = [];
    const fit: LL[] = [];
    const fitContext: LL[] = [];
    const poly = (path: LL[], o: L.PolylineOptions) =>
      this.group.addLayer(L.polyline(path, { renderer: r, interactive: false, lineCap: 'round', lineJoin: 'round', ...o }));
    const tag = (at: LL, html: string, className: string, z = 300) =>
      this.group.addLayer(L.marker(at, { pane: 'netLabels', interactive: false, zIndexOffset: z, icon: L.divIcon({ className, html, iconSize: undefined }) }));

    // 1. Konzept-Bänder unter allem
    for (const [key, band] of Object.entries(BANDS) as [keyof NetView['bands'], (typeof BANDS)['ring']][]) {
      if (!v.bands[key]) continue;
      const color = NET_COLOR.band[key];
      for (const [line, a, b] of band.parts) {
        const p = g.along(line, a, b);
        if (p.length > 1) poly(p, { color, weight: 24, opacity: 0.26 });
      }
      const first = g.along(...band.parts[0]);
      if (first.length) tag(pointAlong(first, key === 'ring' ? 0.15 : 0.35), `<span style="--c:${color}">${band.label}</span>`, 'net-band-label', 0);
    }

    // 2. Linien der Grundkarte: Bus → Bim → S → U; Hervorgehobenes mit weißem Rand (Kreuzungen wirken wie Brücken)
    const drawEdges = (graph: NetGraph, kinds: Kind[], solidBus: boolean) => {
      for (const kind of kinds) {
        if (graph === g && !v.kinds.has(kind)) continue;
        const s = STYLE[kind];
        const dash = solidBus ? undefined : s.dash;
        const edges = [...graph.edges.values()].filter((e) => e.kind === kind && [...e.lines].some(shown));
        const pick = (e: Edge, set: Set<string>) => [...e.lines].find((l) => set.has(l));
        const front = dim ? edges.filter((e) => pick(e, v.focus)) : graph === g ? edges : [];
        const ctx = edges.filter((e) => !pick(e, v.focus) && pick(e, context));
        const back = graph === g && dim ? edges.filter((e) => !pick(e, v.focus) && !pick(e, context)) : [];
        for (const e of back) poly(e.curve, { color: this.lineColor([...e.lines][0], v), weight: s.w * 0.75, opacity: 0.22, dashArray: dash });
        for (const e of ctx) {
          poly(e.curve, { color: this.lineColor(pick(e, context)!, v), weight: s.w * 0.9, opacity: 0.5, dashArray: dash });
          fitContext.push(e.curve[0]);
        }
        for (const e of front) poly(e.curve, { color: '#fff', weight: s.w + s.case * 2 + (dim && kind !== 'U' ? 1.4 : 0), opacity: 0.95 });
        for (const e of front) {
          const id = (dim ? pick(e, v.focus) : null) ?? [...e.lines][0];
          poly(e.curve, { color: this.lineColor(id, v, dim), weight: dim && kind !== 'U' && kind !== 'S' ? s.w + 1.4 : s.w, dashArray: dash });
          if (dim) fit.push(e.curve[0], e.curve[e.curve.length - 1]);
          if (v.onLine) hits.push({ curve: e.curve, ids: [...e.lines].filter((l) => !dim || v.focus.has(l)) });
          // Einbahn-Abschnitt (Schleife, getrennte Richtungen): Pfeil in Fahrtrichtung – nur bei wenigen Linien
          const d = dim && v.focus.size <= 4 ? e.dirs.get(id) : 3;
          if (d === 1 || d === 2) arrows.push({ curve: e.curve, back: d === 2, color: this.lineColor(id, v, dim) });
        }
      }
    };
    drawEdges(g, ['B', 'T', 'S', 'U'], false);
    // Busse und Nachtlinien außerhalb der Grundkarte – nur wenn sie Thema sind, dann obenauf
    const wantsExtra = [...v.focus, ...context].some((id) => !g.has(id) && this.extra.has(id));
    if (wantsExtra) drawEdges(this.extra, ['B'], true);

    // 3. Hervorgehobene Abschnitte
    const pieceNodes = new Set<string>();
    for (const p of pieces) {
      const graph = g.has(p.line) ? g : this.extra;
      const path = graph.along(p.line, p.from, p.to);
      if (path.length < 2) continue;
      for (const id of graph.stationsAlong(p.line, p.from, p.to)) pieceNodes.add(id);
      const l = graph.net.lines.get(p.line)!;
      const s = STYLE[kindOf(l)!];
      const w = Math.max(s.w, 4) + 1;
      poly(path, { color: '#fff', weight: w + 6, opacity: 0.95 });
      poly(path, { color: p.color ?? this.lineColor(p.line, v, true), weight: w });
      fit.push(...path.filter((_, i) => i % 6 === 0), path[path.length - 1]);
      const label = p.label ?? p.line;
      if (label)
        tag(
          pointAlong(path, p.labelFrac ?? 0.8),
          `<div style="transform:translate(-50%, -50%)"><span class="net-tag" style="--c:${p.color ?? this.lineColor(p.line, v, true)}">${esc(label)}</span></div>`,
          'net-tags',
          350,
        );
    }

    for (const a of arrows) {
      const i = Math.floor(a.curve.length / 2);
      const [p, q] = [a.curve[Math.max(0, i - 1)], a.curve[Math.min(a.curve.length - 1, i + 1)]];
      // Bildschirmwinkel: 0° = Osten, im Uhrzeigersinn
      const deg = (Math.atan2(-(q[0] - p[0]), (q[1] - p[1]) * Math.cos((p[0] * Math.PI) / 180)) * 180) / Math.PI + (a.back ? 180 : 0);
      tag(a.curve[i], `<span class="net-arrow" style="--c:${a.color};transform:translate(-50%,-50%) rotate(${deg.toFixed(0)}deg)"></span>`, 'net-tags', 200);
    }

    // Klickflächen der hervorgehobenen Linien: unsichtbar und breit, unter den Haltestellen-Punkten
    for (const h of hits) {
      const id = h.ids[0];
      if (!id) continue;
      const hit = L.polyline(h.curve, { renderer: r, weight: 16, opacity: 0, bubblingMouseEvents: false });
      hit.bindTooltip(h.ids.map(esc).join(' · '), { sticky: true, className: 'pin-label' });
      hit.on('click', () => v.onLine!(id));
      this.group.addLayer(hit);
    }

    // Endstationen der hervorgehobenen (bzw. aller) Linien samt Richtung nach außen
    const at = new Map<string, { ls: Line[]; graph: NetGraph; dx: number; dy: number }>();
    for (const graph of wantsExtra ? [g, this.extra] : [g])
      for (const l of graph.lines) {
        if (!v.labels || v.quiet || (graph === g && !v.kinds.has(kindOf(l)!)) || (dim ? !v.focus.has(l.id) : graph !== g)) continue;
        const ends = [...(graph.terminals.get(l.id) ?? [])];
        // hervorgehobene Strahlen nur am äußeren Ende beschriften – sonst ballen sich die Schilder am Ring
        const central = (id: string) => distM(graph.station(id), CENTER) < 2000;
        const far = (a: [string, string], b: [string, string]) => distM(graph.station(b[0]), CENTER) - distM(graph.station(a[0]), CENTER);
        const outer = v.allLabels
          ? ends.sort(far).slice(0, 1)
          : dim && ends.some(([t]) => !central(t))
            ? ends.filter(([t]) => !central(t))
            : ends;
        for (const [t, prev] of outer) {
          if (!at.has(t)) at.set(t, { ls: [], graph, dx: 0, dy: 0 });
          const x = at.get(t)!;
          if (x.ls.includes(l)) continue;
          x.ls.push(l);
          const [ux, uy] = graph.dir(prev, t);
          x.dx += ux;
          x.dy += uy;
        }
      }

    // 4. Punkte: jede Kreuzung außer Bim–Bim; dazu einfache U-/S-Bahn-Stationen als kleine Punkte
    const marks = v.marks ?? [];
    const marked = new Set(marks.map((m) => m.id));
    const kindOfId = (id: string) => kindOf(g.net.lines.get(id)!)!;
    const drawnDots = new Set<string>();
    for (const [id, all] of g.nodeLines) {
      const lines = [...all].filter((l) => v.kinds.has(kindOfId(l)) && shown(l));
      const rapid = lines.filter((l) => kindOfId(l) === 'U' || kindOfId(l) === 'S');
      const cross = lines.length >= 2 && lines.some((l) => kindOfId(l) !== 'T');
      if (!cross && !rapid.length) continue;
      const s = g.station(id);
      // in reinen Bus-Ansichten (Busnummern) keine Umsteigepunkte – dort geht es um Gegenden, nicht ums Umsteigen
      const strong = !dim || pieceNodes.has(id) || lines.some((l) => v.focus.has(l) && !(wantsExtra && kindOfId(l) === 'B'));
      const medium = !strong && lines.some((l) => context.has(l));
      const hub = rapid.length >= 2 || (rapid.length >= 1 && lines.length >= 4);
      const dot = cross
        ? { radius: hub ? 6.5 : 4.8, color: '#1d2127', weight: hub ? 2.4 : 2, className: hub ? '' : 'net-dot-minor' }
        : { radius: 2.6, color: this.lineColor(rapid[0], v), weight: 1.6, className: 'net-dot-minor' };
      const o = strong ? 1 : medium ? 0.6 : 0.2;
      const m = L.circleMarker([s.lat, s.lon], { renderer: r, ...dot, fillColor: '#fff', opacity: o, fillOpacity: strong ? 1 : 0.4 });
      if (!v.quiet) m.bindTooltip(`<b>${esc(s.name)}</b><br><small>${lines.map(esc).join(' · ')}</small>`, { direction: 'top', offset: [0, -6], className: 'pin-label' });
      if (v.onStation) {
        m.options.bubblingMouseEvents = false;
        m.on('click', () => v.onStation!(id));
      }
      this.group.addLayer(m);
      drawnDots.add(id);
      if (v.hubs && !v.quiet && hub && strong && !marked.has(id))
        // in der Innenstadt liegen die Knoten zu dicht – Namen dort erst beim Hineinzoomen
        tag(
          [s.lat, s.lon],
          `<span>${esc(s.name)}</span>`,
          `net-hub-label${rapid.length >= 3 && distM(s, CENTER) > 2500 ? '' : ' minor'}${(at.get(id)?.dx ?? 0) > 0.3 ? ' left' : ''}`,
          0,
        );
    }

    // weitere Haltestellen (z.B. alle im Lerngebiet) – klein, anklickbar
    const extraStops = [...(v.stops ?? []).map((s) => [s, 'net-dot-minor'] as const), ...(v.allStops ?? []).map((s) => [s, 'net-stop-far'] as const)];
    for (const [s, className] of extraStops) {
      if (drawnDots.has(s.id)) continue;
      drawnDots.add(s.id);
      const m = L.circleMarker([s.lat, s.lon], { renderer: r, radius: 3.4, color: '#5b6470', weight: 1.5, fillColor: '#fff', fillOpacity: 1, className, bubblingMouseEvents: !v.onStation });
      if (!v.quiet) m.bindTooltip(esc(s.name), { direction: 'top', offset: [0, -4], className: 'pin-label' });
      if (v.onStation) m.on('click', () => v.onStation!(s.id));
      this.group.addLayer(m);
    }

    // 5. Markierte Stationen: groß, Name dauerhaft (bei vielen nur beim Drüberfahren)
    for (const s of marks) {
      const m = L.circleMarker([s.lat, s.lon], { renderer: r, radius: 7.5, color: '#1b1e23', weight: 3, fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: !v.onStation });
      if (v.onStation) m.on('click', () => v.onStation!(s.id));
      m.bindTooltip(esc(s.name), { permanent: marks.length <= 6, direction: (at.get(s.id)?.dx ?? 0) > 0.3 ? 'left' : 'right', offset: [8, 0], className: 'pin-label' });
      this.group.addLayer(m);
      fit.push([s.lat, s.lon]);
    }

    // 6. Liniennummern an den Endstationen (mehrere Linien an einer Endstation → ein Kästchen)
    for (const [id, { ls, dx, dy }] of at) {
      const s = g.station(id);
      ls.sort((a, b) => 'USTB'.indexOf(kindOf(a)!) - 'USTB'.indexOf(kindOf(b)!) || a.id.localeCompare(b.id, 'de', { numeric: true }));
      const html = ls.map((l) => `<span class="net-tag" style="--c:${this.lineColor(l.id, v, dim)}">${esc(l.id)}</span>`).join('');
      // Schild hinter die Endstation schieben, in Fahrtrichtung nach außen
      const len = Math.hypot(dx, dy) || 1;
      const w = ls.reduce((a, l) => a + l.id.length * 6.5 + 10, 0);
      const ox = (dx / len) * (10 + w / 2);
      const oy = -(dy / len) * 17;
      // auf Stadt-Zoom ausblenden: Bim-/Busnummern im Gesamtnetz und alles, wenn sehr viele Linien hervorgehoben sind
      const minor = !v.allLabels && ((!dim && ls.every((l) => kindOf(l) === 'T' || kindOf(l) === 'B')) || v.focus.size > 15);
      tag([s.lat, s.lon], `<div style="transform:translate(calc(-50% + ${ox.toFixed(1)}px), calc(-50% + ${oy.toFixed(1)}px))">${html}</div>`, `net-tags${minor ? ' minor' : ''}`);
    }
    return fit.length ? fit : fitContext;
  }
}

// ---------------------------------------------------------------- gemeinsame Karte

let shared: NetMapLayer | null = null;

/** Die eine Netzkarte auf der Spielkarte – wird mit app.map.clear() mitgeleert */
export function netLayer(): NetMapLayer {
  if (!shared) {
    const layer = new NetMapLayer(app.map.leaflet, new NetGraph(app.net));
    app.map.onClear(() => layer.clear());
    shared = layer;
  }
  return shared;
}

/** Standard-Ansicht: alles normal, Bänder aus */
export function netView(over: Partial<NetView> = {}): NetView {
  return { kinds: new Set<Kind>(['U', 'S', 'T', 'B']), focus: new Set(), bands: { ...NO_BANDS }, hubs: true, labels: true, ...over };
}
