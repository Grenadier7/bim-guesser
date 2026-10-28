// Zufällige Adressen als Start/Ziel der Routenjagd (Punkt 13) → data/addresses.json
//
//   node scripts/build-addresses.ts
//
// Quelle: Adressdatensatz der Stadt Wien (OGD, CC BY 4.0), ~290 000 Adressen. Damit die Verteilung passt, wird
// gleichmäßig über die bebaute Fläche ausgedünnt: Raster aus 400-m-Zellen, je Zelle höchstens 3 Adressen – sonst
// käme fast jede Runde aus dem dichten Zentrum. Nur Adressen bis 1,5 km von einer Haltestelle (spielbar).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { distM } from '../shared/geo.ts';
import { shuffle } from '../shared/random.ts';
import type { NetworkData } from '../shared/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'data/raw/addresses.geojson');
const URL_ =
  'https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien:ADRESSENOGD&srsName=EPSG:4326&outputFormat=json&propertyName=NAME,GEB_BEZIRK,SHAPE';
const CELL_M = 400;
const PER_CELL = 3;
const MAX_TO_STOP_M = 1500;

async function main() {
  if (!existsSync(RAW)) {
    console.log('▶ Adressen laden (einmalig, ~40 MB) …');
    const res = await fetch(URL_);
    if (!res.ok) throw new Error(`OGD: HTTP ${res.status}`);
    mkdirSync(path.dirname(RAW), { recursive: true });
    writeFileSync(RAW, await res.text());
  }
  const raw = JSON.parse(readFileSync(RAW, 'utf8')) as { features: { geometry: { coordinates: [number, number] }; properties: { NAME: string; GEB_BEZIRK: string } }[] };
  const net = JSON.parse(readFileSync(path.join(ROOT, 'data/network.json'), 'utf8')) as NetworkData;
  // Haltestellen-Raster für die Nähe-Prüfung (schnell)
  const grid = new Map<string, { lat: number; lon: number }[]>();
  const key = (lat: number, lon: number) => `${Math.floor(lat * 50)}:${Math.floor(lon * 33)}`;
  for (const s of net.stations) grid.set(key(s.lat, s.lon), [...(grid.get(key(s.lat, s.lon)) ?? []), s]);
  const nearStop = (p: { lat: number; lon: number }) => {
    const [a, b] = key(p.lat, p.lon).split(':').map(Number);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const s of grid.get(`${a + i}:${b + j}`) ?? []) if (distM(p, s) <= MAX_TO_STOP_M) return true;
    return false;
  };
  const cells = new Map<string, [number, number, string, number][]>();
  const latM = 111_320;
  const lonM = 111_320 * Math.cos((48.2 * Math.PI) / 180);
  let usable = 0;
  for (const f of raw.features) {
    const [lon, lat] = f.geometry.coordinates;
    // Zusätze wie „(BETRIEB)“ und Tür-/Stiegennummern („53-59/3“ → „53-59“) weg – im Spiel zählt Straße + Hausnummer
    const name = String(f.properties.NAME ?? '')
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\/.*$/, '')
      // Gebäudenamen in Großbuchstaben am Ende („… 6 BLINDENERZIEHUNGSINSTITUT“)
      .replace(/(\s+[A-ZÄÖÜß-]{3,})+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    // nur echte Hausnummern (keine Bauplätze, Brückennamen ohne Nummer …)
    if (!name || !/\d/.test(name) || !nearStop({ lat, lon })) continue;
    usable++;
    const c = `${Math.floor((lat * latM) / CELL_M)}:${Math.floor((lon * lonM) / CELL_M)}`;
    const list = cells.get(c) ?? cells.set(c, []).get(c)!;
    list.push([Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, name, Number(f.properties.GEB_BEZIRK)]);
  }
  const out = [...cells.values()].flatMap((list) => shuffle(list).slice(0, PER_CELL));
  writeFileSync(path.join(ROOT, 'data/addresses.json'), JSON.stringify({ source: 'Stadt Wien – data.wien.gv.at (CC BY 4.0)', addresses: out }));
  console.log(`✔ data/addresses.json: ${out.length} Adressen aus ${cells.size} Rasterzellen (von ${usable} spielbaren, ${raw.features.length} gesamt)`);
}

await main();
