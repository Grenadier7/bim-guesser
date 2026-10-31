// Admin-Seite, Einstellungen → Adressen: alle Adressen auf einer Karte. Punkt anklicken → Name, Bezirk, ausnehmen bzw.
// wieder aufnehmen (eigene: entfernen); leere Stelle anklicken → dort gleich eine eigene Adresse anlegen.
import L from 'leaflet';
import { esc } from '../ui.ts';

export type AddrRow = [lat: number, lon: number, name: string, district: number];

export interface AddrMapOpts {
  /** gebaute Adressen – Index = ID „a:Index“ */
  all: AddrRow[];
  /** ausgenommen (Entwurf) */
  removed: Set<string>;
  own: { name: string; lat: number; lon: number; district: number }[];
  view: { lat: number; lon: number; zoom: number } | null;
  onToggle: (id: string) => void;
  onRemoveOwn: (i: number) => void;
  onAdd: (a: { name: string; lat: number; lon: number; district: number }) => void;
  onView: (v: { lat: number; lon: number; zoom: number }) => void;
}

const STYLE = {
  on: { radius: 3.5, color: '#1b1e23', weight: 1, fillColor: '#1b1e23', fillOpacity: 0.75 },
  off: { radius: 4.5, color: '#c81e1e', weight: 2, fillColor: '#fff', fillOpacity: 1 },
  own: { radius: 6, color: '#fff', weight: 2, fillColor: '#0f8a4a', fillOpacity: 1 },
} as const;
/** Punktgröße je Zoom – weit draußen klein, sonst ist Wien ein schwarzer Fleck */
const SCALE: Record<number, number> = { 10: 0.3, 11: 0.35, 12: 0.45, 13: 0.6, 14: 0.8, 15: 1, 16: 1.2, 17: 1.4, 18: 1.6 };

export function addrMap(el: HTMLElement, o: AddrMapOpts): { show(id: string): void } {
  const map = L.map(el, { minZoom: 10, maxZoom: 17, preferCanvas: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, HERE, Garmin, © OpenStreetMap',
    maxZoom: 18,
  }).addTo(map);
  map.setView(o.view ? [o.view.lat, o.view.lon] : [48.2085, 16.3725], o.view?.zoom ?? 12);
  map.on('moveend', () => {
    const c = map.getCenter();
    o.onView({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
  });
  const markers = new Map<string, L.CircleMarker>();
  const styleOf = (id: string) => {
    const k = SCALE[Math.round(map.getZoom())] ?? 1;
    const st = id.startsWith('own:') ? STYLE.own : o.removed.has(id) ? STYLE.off : STYLE.on;
    return { ...st, radius: Math.max(1.5, st.radius * k), weight: k < 0.6 && st === STYLE.on ? 0 : st.weight };
  };
  map.on('zoomend', () => markers.forEach((m, id) => m.setStyle(styleOf(id))));
  const popup = (id: string): HTMLElement => {
    const div = document.createElement('div');
    div.className = 'adm-addrpop';
    if (id.startsWith('own:')) {
      const i = Number(id.slice(4));
      const a = o.own[i];
      div.innerHTML = `<b>${esc(a.name)}</b><small>${a.district}. Bezirk · eigene Adresse</small><button type="button" class="btn btn-ghost btn-small">Entfernen</button>`;
      div.querySelector('button')!.addEventListener('click', (e) => (e.stopPropagation(), o.onRemoveOwn(i)));
      return div;
    }
    const [, , name, district] = o.all[Number(id.slice(2))];
    const off = o.removed.has(id);
    div.innerHTML = `<b>${esc(name)}</b><small>${district}. Bezirk${off ? ' · <span class="adm-tag gone">ausgenommen</span>' : ''}</small><button type="button" class="btn btn-ghost btn-small">${off ? 'Wieder aufnehmen' : 'Ausnehmen'}</button>`;
    div.querySelector('button')!.addEventListener('click', (e) => {
      e.stopPropagation();
      o.onToggle(id);
      // gleich hier umfärben – die Karte bleibt, wo sie ist (Inhalt erst nach dem Klick tauschen)
      markers.get(id)?.setStyle(styleOf(id));
      setTimeout(() => markers.get(id)?.setPopupContent(popup(id)), 0);
    });
    return div;
  };
  o.all.forEach(([lat, lon], i) => {
    const id = `a:${i}`;
    const m = L.circleMarker([lat, lon], { ...styleOf(id), bubblingMouseEvents: false }).addTo(map);
    m.bindPopup(() => popup(id));
    markers.set(id, m);
  });
  o.own.forEach((a, i) => {
    const id = `own:${i}`;
    const m = L.circleMarker([a.lat, a.lon], { ...styleOf(id), bubblingMouseEvents: false }).addTo(map);
    m.bindPopup(() => popup(id));
    markers.set(id, m);
  });
  // leere Stelle: neue eigene Adresse gleich dort – Formular im Popup, Bezirk der nächsten Adresse vorgeschlagen
  const pick = L.circleMarker([0, 0], { radius: 9, color: '#fff', weight: 3, fillColor: '#e3000f', fillOpacity: 1, interactive: false });
  map.on('click', (e: L.LeafletMouseEvent) => {
    // Klicks aus einem Popup (dessen Inhalt gerade getauscht wurde) sind kein Klick auf die Karte
    const t = e.originalEvent.target as Node;
    if (!el.contains(t) || (t instanceof Element && t.closest('.leaflet-popup'))) return;
    const p = { lat: Math.round(e.latlng.lat * 1e6) / 1e6, lon: Math.round(e.latlng.lng * 1e6) / 1e6 };
    let best = 0;
    let bd = Infinity;
    for (const [lat, lon, , d] of o.all) {
      const x = (lat - p.lat) ** 2 + ((lon - p.lon) * 0.66) ** 2;
      if (x < bd) ((bd = x), (best = d));
    }
    pick.setLatLng([p.lat, p.lon]).addTo(map);
    const div = document.createElement('form');
    div.className = 'adm-addrpop';
    div.innerHTML = `<b>Neue Adresse hier</b>
      <input name="name" maxlength="60" placeholder="z.B. Stephansplatz 1" required autocomplete="off">
      <label>Bezirk <input name="district" type="number" min="1" max="23" value="${best || ''}" required></label>
      <button class="btn btn-primary btn-small">Hinzufügen</button>`;
    div.addEventListener('click', (ev) => ev.stopPropagation());
    div.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = new FormData(div);
      const name = String(f.get('name') ?? '').trim();
      const district = Number(f.get('district'));
      if (!name || !(district >= 1 && district <= 23)) return;
      map.closePopup();
      o.onAdd({ name, lat: p.lat, lon: p.lon, district });
    });
    L.popup({ minWidth: 200, autoPanPaddingTopLeft: [70, 20] }).setLatLng([p.lat, p.lon]).setContent(div).openOn(map);
    setTimeout(() => div.querySelector<HTMLInputElement>('input[name="name"]')?.focus(), 50);
  });
  map.on('popupclose', () => pick.remove());
  setTimeout(() => map.invalidateSize(), 50);
  return {
    show(id: string) {
      const m = markers.get(id);
      if (!m) return;
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 16));
      m.openPopup();
    },
  };
}
