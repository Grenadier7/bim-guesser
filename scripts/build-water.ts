// Gewässer und Bäder in Wien für „Ab ins Wasser“: einmalig aus OpenStreetMap (Overpass, ODbL) holen und vereinfacht
// nach data/water.json schreiben – Punkte etwa alle 40 m entlang der Ufer/Flussläufe, dazu die Bäder als Punkte.
// npm run build:water
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../data/water.json');
const QUERY = `[out:json][timeout:90];
area["name"="Wien"]["admin_level"="4"]->.w;
(
  way["waterway"~"^(river|canal)$"]["name"~"^(Donau|Donaukanal|Wien|Wienfluss|Liesing|Neue Donau)$"](area.w);
  way["natural"="water"]["name"~"^(Alte Donau|Neue Donau|Kaiserwasser|Donau)$"](area.w);
  relation["natural"="water"]["name"~"^(Alte Donau|Obere Alte Donau|Untere Alte Donau|Neue Donau|Kaiserwasser)$"](area.w);
  way["waterway"="stream"]["name"="Liesing"]["tunnel"!="yes"]["location"!="underground"](area.w);
  nwr["leisure"~"^(swimming_area|water_park)$"]["name"](area.w);
  nwr["amenity"="public_bath"]["name"](area.w);
  nwr["leisure"="sports_centre"]["sport"="swimming"]["name"~"[Bb]ad"](area.w);
);
out geom;`;

type LL = [number, number];
const dist = (a: LL, b: LL) => {
  const k = Math.cos((a[0] * Math.PI) / 180) * 111_320;
  return Math.hypot((a[1] - b[1]) * k, (a[0] - b[0]) * 111_320);
};

/** Linie in Punkte etwa alle `step` Meter zerlegen */
function sample(line: LL[], step = 40): LL[] {
  const out: LL[] = [];
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let j = 0; j < n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  if (line.length) out.push(line[line.length - 1]);
  return out;
}

const NAME: Record<string, string> = { Wien: 'Wienfluss', Wienfluss: 'Wienfluss', 'Obere Alte Donau': 'Alte Donau', 'Untere Alte Donau': 'Alte Donau', Liesing: 'Liesing (Fluss)' };

interface El {
  type: string;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  members?: { geometry?: { lat: number; lon: number }[] }[];
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'User-Agent': 'BimGuesser/1.0 (scripts/build-water.ts)', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ data: QUERY }),
});
if (!res.ok) throw new Error(`Overpass: HTTP ${res.status}`);
const els = ((await res.json()) as { elements: El[] }).elements;

const waters = new Map<string, { kind: 'river' | 'lake' | 'bath'; lines: LL[][] }>();
const baths: { name: string; lat: number; lon: number }[] = [];
for (const e of els) {
  const t = e.tags ?? {};
  const isBath = t.leisure === 'swimming_area' || t.leisure === 'water_park' || t.amenity === 'public_bath' || t.sport === 'swimming';
  // Spa/Hammam/Wellness sind kein „Wasser“ zum Hineinspringen, Familienbäder nur für Kinder
  if (isBath && /hammam|spa|wellness|sargfabrik|kleinkinder|familienbad/i.test(t.name ?? '')) continue;
  if (isBath) {
    const g = e.geometry ?? e.members?.flatMap((m) => m.geometry ?? []) ?? [];
    const lat = e.lat ?? (g.length ? g.reduce((s, p) => s + p.lat, 0) / g.length : e.bounds && (e.bounds.minlat + e.bounds.maxlat) / 2);
    const lon = e.lon ?? (g.length ? g.reduce((s, p) => s + p.lon, 0) / g.length : e.bounds && (e.bounds.minlon + e.bounds.maxlon) / 2);
    if (lat && lon && !baths.some((b) => b.name === t.name && dist([b.lat, b.lon], [lat, lon]) < 300)) baths.push({ name: t.name, lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
    continue;
  }
  const name = NAME[t.name] ?? t.name;
  const lines = e.type === 'relation' ? (e.members ?? []).map((m) => m.geometry ?? []) : [e.geometry ?? []];
  const w = waters.get(name) ?? { kind: t.waterway ? 'river' : 'lake', lines: [] };
  for (const l of lines) if (l.length > 1) w.lines.push(l.map((p) => [p.lat, p.lon] as LL));
  waters.set(name, w);
}

const out = {
  source: '© OpenStreetMap-Mitwirkende (ODbL) – Overpass, verarbeitet',
  generatedAt: new Date().toISOString(),
  waters: [...waters].map(([name, w]) => ({
    name,
    kind: w.kind,
    // zum Zeichnen: die Linien (vereinfacht auf ~40 m), zum Rechnen: dieselben Punkte
    lines: w.lines.map((l) => sample(l).map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)])),
  })),
  baths,
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`water.json: ${out.waters.map((w) => `${w.name} (${w.lines.reduce((n, l) => n + l.length, 0)} Punkte)`).join(', ')} · ${baths.length} Bäder`);
