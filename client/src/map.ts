// Leere Wien-Karte (ohne Beschriftungen) + Routen-Darstellung
import L from 'leaflet';
import { isDark } from './theme.ts';
import type { WaterData } from '../../shared/water.ts';
import type { Mode } from '../../shared/types.ts';
import { MODE_COLOR, MODE_ICON } from '../../shared/rules.ts';
import 'leaflet/dist/leaflet.css';
import type { District, FocusArea, LatLon, RouteLeg, RouteOption, StationRef } from '../../shared/types.ts';
import { chain, esc } from './ui.ts';

const VIENNA: L.LatLngBoundsExpression = [
  [48.115, 16.18],
  [48.325, 16.58],
];

type LL = [number, number];

export interface PlayerRoute {
  key: string;
  name: string;
  route: RouteOption;
  isMe: boolean;
}

function pin(cls: string, letter: string, size = 28) {
  return L.divIcon({ className: `pin ${cls}`, html: `<span>${letter}</span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

export class GameMap {
  private map: L.Map;
  private endpoints = L.layerGroup();
  private guesses = L.layerGroup();
  private hints = L.layerGroup();
  private draft = L.layerGroup();
  private routes = L.layerGroup();
  private routeLayers = new Map<string, L.Layer[]>();
  /** Routen, die in der Auflösung ohne Auswahl kräftig gezeigt werden (beste + eigene) */
  private focusKeys: string[] = [];
  private clickHandler: ((e: L.LeafletMouseEvent) => void) | null = null;
  private areas = L.layerGroup();
  private learnArea = L.layerGroup();
  private learnMarks = L.layerGroup();
  /** Tages-Challenges: Ziele/Punkte, Gewässer, innere Bezirke */
  private challenge = L.layerGroup();
  private tapHandler: ((e: L.LeafletMouseEvent) => void) | null = null;

  constructor(el: HTMLElement) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 10, maxZoom: 16, zoomSnap: 0.25 });
    // Basiskarte ohne Beschriftungen ("leere Karte")
    // Basiskarte hell bzw. dunkel (Dunkelmodus, theme.ts)
    const tiles = (dark: boolean) =>
      L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark ? 'Dark' : 'Light'}_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
        // ab Zoomstufe 15 enthalten die Kacheln Straßen- und Parknamen – darüber nur vergrößern
        maxNativeZoom: 14,
        attribution: 'Karte: Esri, HERE, Garmin, &copy; OpenStreetMap · Daten: Wiener Linien (CC BY 4.0) · Fahrplan: Mobilitätsverbünde Österreich OG – data.mobilitaetsverbuende.at (verarbeitet)',
      });
    let base = tiles(isDark()).addTo(this.map);
    window.addEventListener('themechange', () => {
      base.remove();
      base = tiles(isDark()).addTo(this.map);
      base.bringToBack();
    });
    // Quellenangabe: am Handy nur ein (i) (style.css) – antippen klappt auf bzw. zu, Links bleiben klickbar
    const attr = this.map.attributionControl?.getContainer();
    if (attr) {
      attr.title = 'Kartenquellen';
      attr.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('a') && attr.classList.contains('open')) return;
        attr.classList.toggle('open');
      });
      this.map.on('click', () => attr.classList.remove('open'));
    }
    this.map.fitBounds(VIENNA);
    for (const g of [this.areas, this.learnArea, this.learnMarks, this.challenge, this.guesses, this.endpoints, this.hints, this.draft, this.routes]) g.addTo(this.map);
  }

  /** die Leaflet-Karte selbst – für eigene Ebenen wie die Netzkarte */
  get leaflet(): L.Map {
    return this.map;
  }

  /** zuletzt angezeigter Ausschnitt – nach Größenänderung neu einpassen */
  private lastView: { bounds: L.LatLngBounds; maxZoom?: number } | null = null;

  private fit(bounds: L.LatLngBounds, maxZoom?: number) {
    this.lastView = { bounds, maxZoom };
    // Karte gerade ohne Größe (ausgeblendet, z.B. am Handy beim Umschalten)? Dann nicht animieren –
    // flyToBounds rechnet sonst mit NaN. Beim nächsten invalidate(true) wird lastView nachgeholt.
    const size = this.map.getSize();
    if (!size.x || !size.y || !bounds.isValid()) return;
    try {
      this.map.flyToBounds(bounds, { duration: 0.6, maxZoom });
    } catch {
      this.map.fitBounds(bounds, { maxZoom, animate: false });
    }
  }

  invalidate(refit = false) {
    this.map.invalidateSize();
    if (refit && this.lastView) this.map.fitBounds(this.lastView.bounds, { maxZoom: this.lastView.maxZoom, animate: false });
  }

  private clearHooks: (() => void)[] = [];
  /** eigene Ebenen (z.B. Netzkarte), die bei clear() und clearLearn() mitgeleert werden */
  onClear(fn: () => void) {
    this.clearHooks.push(fn);
  }

  clear() {
    for (const fn of this.clearHooks) fn();
    this.stopLocate();
    this.onTap(null);
    for (const g of [this.areas, this.learnArea, this.learnMarks, this.guesses, this.endpoints, this.hints, this.draft, this.routes, this.challenge]) g.clearLayers();
    this.routeLayers.clear();
  }

  /** Allgemeiner Klick-Handler (Lobby: Fokus setzen) */
  onTap(cb: ((ll: LatLon) => void) | null) {
    if (this.tapHandler) this.map.off('click', this.tapHandler);
    this.tapHandler = cb ? (e) => cb([e.latlng.lat, e.latlng.lng]) : null;
    if (this.tapHandler) this.map.on('click', this.tapHandler);
    this.map.getContainer().classList.toggle('tappable', !!cb);
  }

  /** Bezirksgrenzen (dezent) + Fokus-Kreis */
  showAreas(districts: District[], focus: FocusArea | null) {
    this.areas.clearLayers();
    for (const d of districts) {
      this.areas.addLayer(
        L.polygon(d.rings, { color: '#8a8f98', weight: 1, opacity: 0.6, fill: false, interactive: false }),
      );
    }
    if (focus) {
      this.areas.addLayer(
        L.circle([focus.lat, focus.lon], {
          radius: focus.radiusM,
          color: '#e3000f',
          weight: 2,
          fillColor: '#e3000f',
          fillOpacity: 0.08 + focus.share * 0.12,
          interactive: false,
        }),
      );
      this.areas.addLayer(L.circleMarker([focus.lat, focus.lon], { radius: 4, color: '#e3000f', fillOpacity: 1, interactive: false }));
    }
  }

  // -------------------------------------------------------------- Lernmodus

  /** Lernbereich hervorheben (Bezirksumriss oder Kreis) und optional einpassen */
  showLearnArea(area: { rings?: LatLon[][]; circle?: { lat: number; lon: number; radiusM: number } } | null, fit: boolean, strong = false) {
    this.learnArea.clearLayers();
    let bounds: L.LatLngBounds | null = null;
    const style = { color: '#1e6fbf', weight: strong ? 3 : 2, fillColor: '#1e6fbf', fillOpacity: strong ? 0.22 : 0.07, interactive: false };
    if (area?.rings) {
      const poly = L.polygon(area.rings, style);
      this.learnArea.addLayer(poly);
      bounds = poly.getBounds();
    } else if (area?.circle) {
      const c = L.circle([area.circle.lat, area.circle.lon], { ...style, radius: area.circle.radiusM });
      this.learnArea.addLayer(c);
      this.learnArea.addLayer(L.circleMarker([area.circle.lat, area.circle.lon], { radius: 3, color: '#1e6fbf', fillOpacity: 1, interactive: false }));
      // getBounds braucht eine Karte – Kreis grob selbst berechnen
      const dLat = area.circle.radiusM / 111_320;
      const dLon = dLat / Math.cos((area.circle.lat * Math.PI) / 180);
      bounds = L.latLngBounds([area.circle.lat - dLat, area.circle.lon - dLon], [area.circle.lat + dLat, area.circle.lon + dLon]);
    }
    if (fit) {
      if (bounds) this.fit(bounds.pad(0.1), 15);
      else this.overview();
    }
  }

  /** Eine hervorgehobene Station (Ziel der Frage) */
  showTarget(lat: number, lon: number, label: string | null, pan = false) {
    const m = L.marker([lat, lon], { icon: pin('pin-target', '★', 26), zIndexOffset: 1000 });
    if (label) m.bindTooltip(esc(label), { permanent: true, direction: 'top', offset: [0, -14], className: 'pin-label' });
    this.learnMarks.addLayer(m);
    if (pan) this.map.panTo([lat, lon]);
  }

  /** Quiz-Auflösung "Wo liegt …?": Tipps aller Spieler mit Namen + echte Station */
  showPlayerGuesses(guesses: { name: string; ll: LatLon; me: boolean }[], actual: { lat: number; lon: number; name: string }) {
    const bounds = L.latLngBounds([[actual.lat, actual.lon]]);
    for (const g of guesses) {
      bounds.extend(g.ll);
      this.learnMarks.addLayer(L.polyline([g.ll, [actual.lat, actual.lon]], { color: g.me ? '#1b1e23' : '#8a8f98', weight: 2, dashArray: '4 6' }));
      this.learnMarks.addLayer(
        L.marker(g.ll, { icon: pin(g.me ? 'pin-guess' : 'pin-guess pin-other', '?', 22), zIndexOffset: g.me ? 950 : 900 }).bindTooltip(esc(g.name), {
          permanent: true,
          direction: 'right',
          offset: [10, 0],
          className: 'stop-label',
        }),
      );
    }
    this.showTarget(actual.lat, actual.lon, actual.name);
    this.fit(bounds.pad(0.3), 15);
  }

  zoomTo(lat: number, lon: number, zoom: number) {
    this.lastView = null;
    if (!this.map.getSize().x) return void this.map.setView([lat, lon], zoom);
    this.map.flyTo([lat, lon], zoom, { duration: 0.5 });
  }

  /** Nachzeichnen: vom Spieler getippte Punkte als gestrichelte Linie */
  showSketch(points: LatLon[], ends?: [LatLon, LatLon]) {
    this.draft.clearLayers();
    // mit Start/Ende: die Zeichnung beginnt und endet an den Endstationen
    const line = ends && points.length ? [ends[0], ...points, ends[1]] : points;
    if (line.length > 1) this.draft.addLayer(L.polyline(line, { color: '#1b1e23', weight: 4, dashArray: '8 7', lineCap: 'round', interactive: false }));
    for (const p of points) this.draft.addLayer(L.circleMarker(p, { radius: 4, color: '#1b1e23', fillColor: '#1b1e23', fillOpacity: 1, interactive: false }));
  }

  /** Karte auf ein paar Punkte einpassen */
  fitPoints(points: LatLon[], maxZoom = 14) {
    if (points.length) this.fit(L.latLngBounds(points).pad(0.25), maxZoom);
  }

  /** Stationen hervorheben (z.B. beim Nachzeichnen verfehlt) */
  showMarkedStops(stops: { lat: number; lon: number; name: string }[], color: string) {
    for (const st of stops)
      this.learnMarks.addLayer(
        L.circleMarker([st.lat, st.lon], { radius: 6, color, weight: 3, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(st.name), {
          direction: 'top',
          offset: [0, -5],
          className: 'stop-label',
        }),
      );
  }

  /**
   * Kurs-Ansicht (Lernen): vereinfachte Linien. Fokus-Linien kräftig mit weißem Rand und Nummernschild,
   * Kontext-Linien dünn und blass. Stationspunkte mit Namen – dauerhaft (wenige) oder beim Drüberfahren.
   */
  clearLearn() {
    for (const fn of this.clearHooks) fn();
    this.draft.clearLayers();
    this.learnMarks.clearLayers();
  }

  overview() {
    // über fit: ohne Kartengröße (ausgeblendet) wird nachgeholt statt mit NaN zu rechnen
    this.fit(L.latLngBounds(VIENNA as L.LatLngExpression[]));
  }

  /** Innenstadt bis etwas über den Gürtel hinaus – Startansicht zum Lernen */
  cityView() {
    this.lastView = null;
    if (!this.map.getSize().x) return this.map.setView([48.2045, 16.3685], 12.5);
    this.map.flyTo([48.2045, 16.3685], 12.5, { duration: 0.5 });
  }

  // -------------------------------------------------------------- Start/Ziel

  showEndpoints(from: StationRef, to: StationRef, fit = true, names = true) {
    this.endpoints.clearLayers();
    for (const [s, cls, letter] of [
      [from, 'pin-start', 'A'],
      [to, 'pin-end', 'B'],
    ] as const) {
      const m = L.marker([s.lat, s.lon], { icon: pin(cls, letter), zIndexOffset: 1000 });
      if (names) m.bindTooltip(esc(s.name), { permanent: true, direction: 'top', offset: [0, -14], className: 'pin-label' });
      this.endpoints.addLayer(m);
    }
    if (fit) {
      const b = L.latLngBounds([
        [from.lat, from.lon],
        [to.lat, to.lon],
      ]);
      this.fit(b.pad(0.6), 14);
    }
  }

  /**
   * Tages-Challenges: Start (A) und – statt B – drei Ziele (1–3), drei Punkte (✓ wenn befahren), die Gewässer
   * („Ab ins Wasser“) oder die gesperrten inneren Bezirke. Passt die Karte auf alles ein.
   */
  showChallenge(o: {
    from: StationRef;
    to?: StationRef | null;
    targets?: StationRef[];
    waypoints?: { s: StationRef; done: boolean }[];
    water?: WaterData | null;
    inner?: District[];
    /** Sonnenschein: unterirdische Abschnitte */
    underground?: { line: string; path: [number, number][] }[];
    /** Umland: Wien umrahmen (Start liegt außerhalb) */
    outline?: District[];
    /** Zielnetz 2040: neue/geänderte Linien (Verlauf) und neue Stationen */
    future?: { lines: { id: string; color: string; path: [number, number][] }[]; stations: StationRef[] };
    /** Brückenkenner: alle Brücken, über die Öffis fahren – Abschnitte je Verkehrsmittel, Linien darüber */
    bridges?: { name: string; river: string; lat: number; lon: number; modes: Mode[]; lines: string[]; segs: { mode: Mode; path: [number, number][] }[] }[];
    /** Hubschrauber-Linien: rosa Strich mit Flugzeit */
    helis?: { id: string; a: StationRef; b: StationRef; min: number }[];
    fit?: boolean;
  }) {
    this.endpoints.clearLayers();
    this.challenge.clearLayers();
    const pts: [number, number][] = [[o.from.lat, o.from.lon]];
    const label = (m: L.Marker, text: string) => m.bindTooltip(esc(text), { permanent: true, direction: 'top', offset: [0, -14], className: 'pin-label' });
    this.endpoints.addLayer(label(L.marker([o.from.lat, o.from.lon], { icon: pin('pin-start', 'A'), zIndexOffset: 1000 }), o.from.name));
    if (o.to) {
      this.endpoints.addLayer(label(L.marker([o.to.lat, o.to.lon], { icon: pin('pin-end', 'B'), zIndexOffset: 1000 }), o.to.name));
      pts.push([o.to.lat, o.to.lon]);
    }
    o.targets?.forEach((t, i) => {
      this.endpoints.addLayer(label(L.marker([t.lat, t.lon], { icon: pin('pin-end', String(i + 1)), zIndexOffset: 1000 }), `Ziel ${i + 1}: ${t.name}`));
      pts.push([t.lat, t.lon]);
    });
    o.waypoints?.forEach(({ s, done }, i) => {
      this.endpoints.addLayer(label(L.marker([s.lat, s.lon], { icon: pin(done ? 'pin-way done' : 'pin-way', done ? '✓' : String(i + 1)), zIndexOffset: 900 }), s.name));
      pts.push([s.lat, s.lon]);
    });
    for (const d of o.inner ?? [])
      this.challenge.addLayer(L.polygon(d.rings, { color: '#c81e1e', weight: 1.5, fillColor: '#c81e1e', fillOpacity: 0.16, interactive: false }).bindTooltip(`🚫 ${esc(d.name)}`, { sticky: true }));
    for (const d of o.outline ?? []) this.challenge.addLayer(L.polygon(d.rings, { color: '#5a6b7d', weight: 1, fillColor: '#5a6b7d', fillOpacity: 0.05, interactive: false }));
    if (o.future) {
      for (const l of o.future.lines) {
        this.challenge.addLayer(L.polyline(l.path, { color: '#fff', weight: 8, opacity: 0.85, interactive: false }));
        this.challenge.addLayer(L.polyline(l.path, { color: l.color, weight: 5, opacity: 0.9 }).bindTooltip(`🔮 ${esc(l.id)}`, { sticky: true }));
      }
      for (const s of o.future.stations)
        this.challenge.addLayer(L.circleMarker([s.lat, s.lon], { radius: 6, color: '#222', weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(`🆕 ${esc(s.name)}`, { direction: 'top' }));
    }
    for (const b of o.bridges ?? []) {
      const tip = `<b>🌉 ${esc(b.name)}</b> (${esc(b.river)})${b.lines.length ? `<br>${b.lines.map(esc).join('<br>')}` : ''}`;
      // Abschnitt über die Brücke in der Farbe des Verkehrsmittels (mehrere nebeneinander leicht versetzt)
      b.segs.forEach((sg, i) => {
        const off = (i % 3) * 0.00012;
        const path = sg.path.map(([la, lo]) => [la + off, lo + off] as [number, number]);
        this.challenge.addLayer(L.polyline(path, { color: '#fff', weight: 9, opacity: 0.9 }));
        this.challenge.addLayer(L.polyline(path, { color: MODE_COLOR[sg.mode], weight: 5, opacity: 0.95 }).bindTooltip(tip, { sticky: true }));
      });
      const icons = b.modes.map((m) => MODE_ICON[m]).join('');
      this.challenge.addLayer(
        L.marker([b.lat, b.lon], {
          icon: L.divIcon({ className: 'bridge-pin', html: `<span>🌉</span>${icons ? `<small>${icons}</small>` : ''}`, iconSize: [22 + 14 * b.modes.length, 22] }),
          zIndexOffset: 500,
        }).bindTooltip(tip, { direction: 'top' }),
      );
    }
    // Beschriftung je Hubschrauber an einer anderen Stelle der Linie (35 / 50 / 65 %), damit sie sich nicht überdecken
    const at = [0.5, 0.3, 0.7];
    for (const [k, x] of (o.helis ?? []).entries()) {
      const line = L.polyline(
        [
          [x.a.lat, x.a.lon],
          [x.b.lat, x.b.lon],
        ],
        { color: '#c2185b', weight: 4, opacity: 0.85, dashArray: '10 8' },
      );
      this.challenge.addLayer(line.bindTooltip(`🚁 ${esc(x.id)}: ${esc(x.a.name)} ↔ ${esc(x.b.name)} · ${x.min} min`, { sticky: true }));
      const f = at[k % at.length];
      this.challenge.addLayer(
        L.marker([x.a.lat + (x.b.lat - x.a.lat) * f, x.a.lon + (x.b.lon - x.a.lon) * f], {
          icon: L.divIcon({ className: 'heli-label', html: `🚁 ${esc(x.id)} · ${x.min} min`, iconSize: [88, 20], iconAnchor: [44, 10] }),
          interactive: false,
          zIndexOffset: 600,
        }),
      );
      for (const s of [x.a, x.b]) {
        this.challenge.addLayer(L.circleMarker([s.lat, s.lon], { radius: 7, color: '#c2185b', weight: 3, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(`🚁 ${esc(x.id)}: ${esc(s.name)}`, { direction: 'top' }));
        pts.push([s.lat, s.lon]);
      }
    }
    for (const u of o.underground ?? [])
      this.challenge.addLayer(
        L.polyline(u.path, { color: '#4a4a4a', weight: 7, opacity: 0.45, dashArray: '2 8', lineCap: 'round' }).bindTooltip(`☁️ ${esc(u.line)} unter der Erde`, { sticky: true }),
      );
    if (o.water) {
      for (const w of o.water.waters)
        for (const line of w.lines)
          this.challenge.addLayer(L.polyline(line, { color: '#1e88e5', weight: w.kind === 'river' ? 5 : 3, opacity: 0.55, interactive: false }));
      for (const b of o.water.baths)
        this.challenge.addLayer(L.circleMarker([b.lat, b.lon], { radius: 6, color: '#1e88e5', weight: 2, fillColor: '#bbdefb', fillOpacity: 1 }).bindTooltip(`🏊 ${esc(b.name)}`, { direction: 'top' }));
    }
    if (o.water) {
      // Wasser: Umgebung des Starts (~3,5 km), damit Flüsse und Bäder in der Nähe zu sehen sind
      const d = 0.032;
      pts.push([o.from.lat - d, o.from.lon - d * 1.5], [o.from.lat + d, o.from.lon + d * 1.5]);
    }
    // Umland: Ort und ganz Wien im Bild
    if (o.outline?.length) for (const d of o.outline) for (const ring of d.rings) for (const p of ring) pts.push(p);
    if (o.fit !== false) this.fit(L.latLngBounds(pts).pad(o.outline ? 0.05 : 0.3), 14);
  }

  clearEndpoints() {
    this.endpoints.clearLayers();
  }

  // -------------------------------------------------------------- "Wo liegt das?"

  startLocate(onPick: (ll: LatLon) => void) {
    this.stopLocate();
    this.map.getContainer().classList.add('locating');
    this.clickHandler = (e) => onPick([e.latlng.lat, e.latlng.lng]);
    this.map.on('click', this.clickHandler);
  }

  stopLocate() {
    this.map.getContainer().classList.remove('locating');
    if (this.clickHandler) this.map.off('click', this.clickHandler);
    this.clickHandler = null;
  }

  /** Geschätzte Positionen; mit `actual` zusätzlich gestrichelte Linie zur echten Station */
  showGuesses(g: { from: LatLon | null; to: LatLon | null }, actual?: { from: StationRef; to: StationRef }) {
    this.guesses.clearLayers();
    const items = [
      [g.from, 'A', actual?.from],
      [g.to, 'B', actual?.to],
    ] as const;
    for (const [ll, letter, real] of items) {
      if (!ll) continue;
      this.guesses.addLayer(L.marker(ll, { icon: pin('pin-guess', `${letter}?`, 26), zIndexOffset: 900 }));
      if (real) this.guesses.addLayer(L.polyline([ll, [real.lat, real.lon]], { color: '#333', weight: 2, dashArray: '4 6' }));
    }
  }

  clearGuesses() {
    this.guesses.clearLayers();
  }

  // -------------------------------------------------------------- Eingabe & Tipps

  /** Route, die der User gerade baut (Luftlinien zwischen Haltestellen) */
  showDraft(segments: { path: LL[]; color: string; walk: boolean }[], transfers: { lat: number; lon: number; name: string }[]) {
    this.draft.clearLayers();
    // Fußwege zuerst (darunter) – sonst verdecken lange Fußwege die gefahrenen Linien
    for (const s of [...segments].sort((a, b) => Number(b.walk) - Number(a.walk))) {
      if (!s.walk) this.draft.addLayer(L.polyline(s.path, { color: '#fff', weight: 9, opacity: 0.9 }));
      this.draft.addLayer(
        L.polyline(s.path, s.walk ? { color: '#666', weight: 4, dashArray: '2 8', lineCap: 'round' } : { color: s.color, weight: 5 }),
      );
    }
    for (const t of transfers)
      this.draft.addLayer(
        L.circleMarker([t.lat, t.lon], { radius: 6, color: '#222', weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(t.name), {
          direction: 'right',
          offset: [8, 0],
          className: 'stop-label',
        }),
      );
  }

  /** Tipp: Umstiegsorte der schnellsten Route */
  showTransferHints(stops: { name: string; lat: number; lon: number }[]) {
    this.hints.clearLayers();
    for (const s of stops) {
      const m = L.marker([s.lat, s.lon], { icon: pin('pin-hint', '⇄', 26), zIndexOffset: 800 });
      if (s.name) m.bindTooltip(esc(s.name), { permanent: true, direction: 'bottom', offset: [0, 12], className: 'hint-label' });
      this.hints.addLayer(m);
    }
  }

  // -------------------------------------------------------------- Auflösung

  /**
   * Alle Routen farbig nach Verkehrsmittel, mit Beschriftung wie bei Google Maps.
   * Kräftig nur die `focus`-Routen (beste + eigene) – die anderen blass, bis man sie in der Liste auswählt.
   */
  showReveal(routes: RouteOption[], players: PlayerRoute[], focus: string[] = []) {
    this.stopLocate();
    this.draft.clearLayers();
    this.hints.clearLayers();
    this.routes.clearLayers();
    this.routeLayers.clear();
    const top = routes.slice(0, 4);
    const items: { key: string; route: RouteOption; label: string; player: boolean; rank: number }[] = top.map((r, i) => ({
      key: r.key,
      route: r,
      label: '',
      player: false,
      rank: i,
    }));
    // Spielerrouten, die nicht ohnehin unter den Top-Routen sind
    players.forEach((p, i) => {
      if (!top.some((r) => r.key === p.route.key)) items.push({ key: p.key, route: p.route, label: p.name, player: true, rank: 10 + i });
    });

    const bounds = L.latLngBounds([]);
    for (const item of [...items].reverse()) {
      const layers: L.Layer[] = [];
      for (const leg of item.route.legs) {
        if (leg.path.length < 2) continue;
        bounds.extend(L.latLngBounds(leg.path));
        layers.push(...this.legLayers(leg, item.player, item.rank));
      }
      const frac = item.player ? 0.25 + ((item.rank - 10) % 4) * 0.12 : ([0.5, 0.65, 0.35, 0.8][item.rank] ?? 0.5);
      const pos = labelPoint(item.route.legs, frac);
      if (pos) {
        const cls = item.player ? 'rlabel-user' : item.rank === 0 ? 'rlabel-best' : '';
        const html = `<div class="rlabel ${cls}">${item.player ? `<em>${esc(item.label)}</em>` : ''}${chain(item.route.legs)}<strong>${item.route.medianMin} min</strong></div>`;
        layers.push(L.marker(pos, { icon: L.divIcon({ className: 'rlabel-wrap', html, iconSize: undefined, iconAnchor: [0, 0] }), zIndexOffset: 500 - item.rank }));
      }
      for (const l of layers) this.routes.addLayer(l);
      this.routeLayers.set(item.key, layers);
    }
    // Spieler, deren Route einer Top-Route entspricht: gleiche Layer hervorheben
    for (const p of players) if (!this.routeLayers.has(p.key)) this.routeLayers.set(p.key, this.routeLayers.get(p.route.key) ?? []);
    this.focusKeys = focus.length ? focus : top[0] ? [top[0].key] : [];
    this.highlight(null);
    if (bounds.isValid()) this.fit(bounds.pad(0.15));
  }

  private legLayers(leg: RouteLeg, isPlayer: boolean, rank: number): L.Layer[] {
    const weight = rank === 0 ? 7 : 5;
    if (leg.mode === 'W') return [L.polyline(leg.path, { color: '#555', weight: 3, dashArray: '1 7', lineCap: 'round' })];
    return [
      L.polyline(leg.path, { color: '#fff', weight: weight + 4, opacity: 0.95 }),
      L.polyline(leg.path, { color: leg.color, weight, dashArray: isPlayer ? '10 7' : undefined }),
    ];
  }

  /** Eine Route hervorheben – null = Grundzustand (nur beste + eigene kräftig, andere blass ohne Schild) */
  highlight(key: string | null) {
    const keys = key ? [key] : this.focusKeys;
    const active = new Set(keys.map((k) => this.routeLayers.get(k)).filter((x): x is L.Layer[] => !!x));
    // Aliase (Spieler mit Top-Route) teilen sich Layer – jede Gruppe nur einmal behandeln
    for (const layers of new Set(this.routeLayers.values())) {
      const on = active.size === 0 || active.has(layers);
      for (const l of layers) {
        if (l instanceof L.Polyline) l.setStyle({ opacity: on ? 1 : 0.12 });
        if (l instanceof L.Marker) l.setOpacity(on ? 1 : 0);
      }
    }
    for (const layers of active) for (const l of layers) if (l instanceof L.Polyline) l.bringToFront();
  }
}

function labelPoint(legs: RouteLeg[], frac: number): LL | null {
  const pts = legs.flatMap((l) => l.path);
  if (!pts.length) return null;
  return pts[Math.min(pts.length - 1, Math.floor(pts.length * frac))];
}
