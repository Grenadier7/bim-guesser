// Kleine Karte zum Festlegen eines Punkts (neue Station, Station verschieben, eigene Adresse): Klick setzt den Punkt,
// Stationen in der Nähe sind als graue Punkte eingezeichnet.
import L from 'leaflet';
import type { NetIndex } from '../net.ts';

export function miniMap(el: HTMLElement, net: NetIndex | null, point: { lat: number; lon: number } | null, onPick: (p: { lat: number; lon: number }) => void): L.Map {
  const map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 10, maxZoom: 18 });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, HERE, Garmin, © OpenStreetMap',
    maxZoom: 18,
  }).addTo(map);
  map.setView(point ? [point.lat, point.lon] : [48.2085, 16.3725], point ? 15 : 12);
  // Stationen erst ab Zoom 14 (sonst zu viele)
  const stations = L.layerGroup().addTo(map);
  const drawStations = () => {
    stations.clearLayers();
    if (!net || map.getZoom() < 14) return;
    const b = map.getBounds();
    for (const s of net.data.stations)
      if (b.contains([s.lat, s.lon])) L.circleMarker([s.lat, s.lon], { radius: 4, color: '#5b6170', weight: 1, fillOpacity: 0.6 }).bindTooltip(s.name).addTo(stations);
  };
  map.on('moveend', drawStations);
  drawStations();
  // Punkt als Kreis (Leaflets Standard-Marker braucht Bilddateien)
  const dot = (lat: number, lon: number) => L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#e3000f', fillOpacity: 1 }).addTo(map);
  let marker = point ? dot(point.lat, point.lon) : null;
  map.on('click', (e: L.LeafletMouseEvent) => {
    const p = { lat: Math.round(e.latlng.lat * 1e6) / 1e6, lon: Math.round(e.latlng.lng * 1e6) / 1e6 };
    if (marker) marker.setLatLng([p.lat, p.lon]);
    else marker = dot(p.lat, p.lon);
    onPick(p);
  });
  setTimeout(() => map.invalidateSize(), 50);
  return map;
}
