// Brücken für „Brückenkenner“: wo fährt ein Öffi über Donau, Neue Donau, Donaukanal, Wienfluss oder Alte Donau?
// Echte Brücken aus OpenStreetMap (Overpass, ODbL), den Abschnitten des Liniennetzes (Station → nächste Station)
// zugeordnet. npm run build:bridges
//
// Was zählt (architektonisch und spielsinnvoll):
// - nur Brücken über die großen Gewässer – nicht die Liesing (kleiner Bach), nicht Brücken über Bahngleise/Straßen
// - die Brücke muss das Verkehrsmittel tragen: U-Bahn über eine U-Bahn-Brücke, S-Bahn/Zug über eine Bahnbrücke,
//   Bim über eine Straßenbahn-Brücke, Bus über eine Straßenbrücke – die U1 unter dem Donaukanal zählt also nicht
// - der Abschnitt muss das Gewässer queren (Stationen auf beiden Seiten) und nahe an der Brücke liegen
// - eine Brücke = ein Name (die Reichsbrücke über Donau und Neue Donau ist eine)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Mode, NetworkData } from '../shared/types.ts';
import type { WaterData } from '../shared/water.ts';
import type { BridgeData } from '../shared/bridges.ts';

const DATA = path.resolve(import.meta.dirname, '../data');
const net = JSON.parse(readFileSync(path.join(DATA, 'network.json'), 'utf8')) as NetworkData;
const water = JSON.parse(readFileSync(path.join(DATA, 'water.json'), 'utf8')) as WaterData;

/** Gewässer, deren Brücken zählen (Anzeige-Name der Gruppe) */
const RIVERS: Record<string, string> = { Donau: 'Donau', 'Neue Donau': 'Donau', Donaukanal: 'Donaukanal', Wienfluss: 'Wienfluss', 'Alte Donau': 'Alte Donau' };
/** Abschnitt höchstens so weit von der Brücke entfernt (m) – die Abschnitte sind gerade Linien zwischen Stationen */
const NEAR_M = 450;

type LL = [number, number];
const K = Math.cos((48.2 * Math.PI) / 180) * 111_320;
const xy = ([lat, lon]: LL) => [lon * K, lat * 111_320] as const;
const dist = (a: LL, b: LL) => Math.hypot((a[1] - b[1]) * K, (a[0] - b[0]) * 111_320);

/** Schnitt zweier Strecken: Winkel zwischen ihnen (0–90°), sonst null */
function crossAngle(a: LL, b: LL, c: LL, d: LL): number | null {
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const [cx, cy] = xy(c);
  const [dx, dy] = xy(d);
  const r = [bx - ax, by - ay];
  const s = [dx - cx, dy - cy];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / den;
  const u = ((cx - ax) * r[1] - (cy - ay) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const cos = Math.abs(r[0] * s[0] + r[1] * s[1]) / (Math.hypot(r[0], r[1]) * Math.hypot(s[0], s[1]));
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

function intersects(a: LL, b: LL, c: LL, d: LL): boolean {
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const [cx, cy] = xy(c);
  const [dx, dy] = xy(d);
  const r = [bx - ax, by - ay];
  const s = [dx - cx, dy - cy];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / den;
  const u = ((cx - ax) * r[1] - (cy - ay) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Abstand Punkt – Strecke (m) */
function toSegment(p: LL, a: LL, b: LL): number {
  const [px, py] = xy(p);
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** welche der Gewässer(-Gruppen) quert die Linie? `minAngle`: nur echte Querungen, nicht am Ufer entlang */
function riversCrossed(line: LL[], minAngle = 0): Set<string> {
  const out = new Set<string>();
  for (const w of water.waters) {
    const g = RIVERS[w.name];
    if (!g || out.has(g)) continue;
    for (let i = 0; i + 1 < line.length && !out.has(g); i++)
      if (
        w.lines.some((wl) =>
          wl.some((p, j) => {
            if (j + 1 >= wl.length) return false;
            // See (Alte Donau): nicht am offenen Ende einer Kontur – dort sind die Umrisse oft nur Bruchstücke
            if (w.kind === 'lake' && (dist(p as LL, wl[0] as LL) < 120 || dist(p as LL, wl[wl.length - 1] as LL) < 120) && dist(wl[0] as LL, wl[wl.length - 1] as LL) > 50) return false;
            if (!minAngle) return intersects(line[i], line[i + 1], p as LL, wl[j + 1] as LL);
            const ang = crossAngle(line[i], line[i + 1], p as LL, wl[j + 1] as LL);
            return ang != null && ang >= minAngle;
          }),
        )
      )
        out.add(g);
  }
  return out;
}

// ---- Brücken aus OpenStreetMap
const QUERY = `[out:json][timeout:120];
area["name"="Wien"]["admin_level"="4"]->.w;
(
  way["bridge"]["railway"~"^(subway|tram|rail|light_rail)$"](area.w);
  way["bridge"]["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|busway|service)$"](area.w);
);
out geom tags;`;
let res: Response | null = null;
for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']) {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'BimGuesser/1.0 (Lernspiel Wiener Öffis)' },
    body: 'data=' + encodeURIComponent(QUERY),
  }).catch(() => null);
  if (res?.ok) break;
  console.warn(`Overpass ${url}: ${res ? `HTTP ${res.status}` : 'nicht erreichbar'}`);
}
if (!res?.ok) throw new Error('Overpass nicht erreichbar – später nochmal versuchen.');
interface Way {
  tags: Record<string, string>;
  geometry: { lat: number; lon: number }[];
}
const ways = ((await res.json()) as { elements: Way[] }).elements.filter((w) => w.geometry?.length > 1);

/** welche Verkehrsmittel eine Brücke trägt */
function carries(w: Way): Mode[] {
  const r = w.tags.railway;
  if (r === 'subway') return ['U'];
  if (r === 'rail' || r === 'light_rail') return ['S'];
  if (r === 'tram') return ['T'];
  // Straßenbrücke: Bus – und Bim, wenn die Gleise in der Fahrbahn liegen
  return ['B', 'N', 'T'];
}

// nur Brücken, die ein großes Gewässer überspannen (vorab grob: in der Nähe eines Gewässers)
const riverBridges = ways
  .map((w) => {
    const line = w.geometry.map((g) => [g.lat, g.lon] as LL);
    return { w, line, rivers: riversCrossed(line) };
  })
  .filter((x) => x.rivers.size);
console.log(`${ways.length} Brücken in OSM, davon ${riverBridges.length} über die großen Gewässer`);

// ---- Abschnitte des Netzes zuordnen
const st = new Map(net.stations.map((s) => [s.id, s]));
const mode = new Map(net.lines.map((l) => [l.id, l.mode]));
const segs = new Map<string, { a: string; b: string; modes: Set<Mode>; lines: Set<string> }>();
// nur das reguläre Netz (Umleitungen im Netz „Aktuell“ zählen nicht)
for (const l of net.lines)
  for (const p of l.patterns.filter((_, i) => l.nets[i].includes('r')))
    for (let i = 0; i + 1 < p.length; i++) {
      const k = [p[i], p[i + 1]].sort().join('|');
      const s = segs.get(k) ?? { a: p[i], b: p[i + 1], modes: new Set<Mode>(), lines: new Set<string>() };
      s.modes.add(mode.get(l.id)!);
      s.lines.add(l.id);
      segs.set(k, s);
    }

const pt = (id: string): LL => [st.get(id)!.lat, st.get(id)!.lon];
/** Brücke (nach Name) → Abschnitte, Gewässer, Lage */
const byName = new Map<string, { name: string; river: string; pts: LL[]; segs: Set<string>; modes: Map<string, Set<Mode>> }>();
for (const [k, s] of segs) {
  const a = pt(s.a);
  const b = pt(s.b);
  if (dist(a, b) > 6000) continue;
  // echte Querung: nicht flach am Ufer entlang (U4 im Wiental, am Donaukanal)
  const crossed = riversCrossed([a, b], 25);
  if (!crossed.size) continue;
  for (const rb of riverBridges) {
    const river = [...rb.rivers].find((r) => crossed.has(r));
    if (!river) continue;
    if (!carries(rb.w).some((m) => s.modes.has(m))) continue;
    // Name nur, wenn es nach Brücke klingt (sonst z.B. „Park & Ride Hütteldorf“) oder nach einer Linie
    const raw = rb.w.tags['bridge:name'] ?? rb.w.tags.name;
    const named = raw && (/brücke|steg/i.test(raw) || mode.has(raw)) ? raw : undefined;
    // nach einer Linie benannt („U6“): nur für diese Linie
    if (named && mode.has(named) && !s.lines.has(named)) continue;
    const mid = rb.line[Math.floor(rb.line.length / 2)];
    if (toSegment(mid, a, b) > NEAR_M) continue;
    const art = river === 'Wienfluss' || river === 'Donaukanal' ? 'den' : 'die';
    const name = !named ? `Brücke über ${art} ${river}` : mode.has(named) ? `${named}-Brücke über ${art} ${river}` : named;
    // eine Brücke = Name + Gewässer; ungenannte nach Lage
    const key = named ? `${named}#${river}` : `${river}@${mid[0].toFixed(3)},${mid[1].toFixed(3)}`;
    const e = byName.get(key) ?? { name, river, pts: [], segs: new Set<string>(), modes: new Map<string, Set<Mode>>() };
    e.pts.push(mid);
    e.segs.add(k);
    // nur die Verkehrsmittel, die diese Brücke trägt und die hier fahren
    for (const m of carries(rb.w)) if (s.modes.has(m)) e.modes.set(k, (e.modes.get(k) ?? new Set<Mode>()).add(m));
    byName.set(key, e);
  }
}

// derselbe Abschnitt bei mehreren Brücken desselben Gewässers (Straße + Gleis nebeneinander): nur die nächste
// – je Verkehrsmittel: S-Bahn und U6 fahren zwischen Floridsdorf und Handelskai über verschiedene Brücken
const nearest = new Map<string, { key: string; d: number }>();
for (const [key, e] of byName)
  for (const k of e.segs) {
    const s = segs.get(k)!;
    const d = Math.min(...e.pts.map((p) => toSegment(p, pt(s.a), pt(s.b))));
    for (const m of e.modes.get(k) ?? []) {
      const slot = `${k}#${e.river}#${m}`;
      if (!nearest.has(slot) || d < nearest.get(slot)!.d) nearest.set(slot, { key, d });
    }
  }
for (const [key, e] of byName) {
  for (const k of e.segs) e.modes.set(k, new Set([...(e.modes.get(k) ?? [])].filter((m) => nearest.get(`${k}#${e.river}#${m}`)?.key === key)));
  e.segs = new Set([...e.segs].filter((k) => e.modes.get(k)?.size));
}

const list = [...byName.values()].filter((e) => e.segs.size);
const out: BridgeData = {
  source: '© OpenStreetMap-Mitwirkende (ODbL) – Brücken und Gewässer, den Abschnitten des Liniennetzes zugeordnet',
  generatedAt: new Date().toISOString(),
  bridges: list.map((e, i) => ({
    id: `b${i + 1}`,
    name: e.name,
    river: e.river,
    lat: Math.round((e.pts.reduce((s, p) => s + p[0], 0) / e.pts.length) * 1e5) / 1e5,
    lon: Math.round((e.pts.reduce((s, p) => s + p[1], 0) / e.pts.length) * 1e5) / 1e5,
    segs: [...e.segs].map((k) => [...(k.split('|') as [string, string]), [...(e.modes.get(k) ?? [])]] as [string, string, Mode[]]),
  })),
};
writeFileSync(path.join(DATA, 'bridges.json'), JSON.stringify(out));
const by = new Map<string, number>();
for (const b of out.bridges) by.set(b.river, (by.get(b.river) ?? 0) + 1);
console.log(`bridges.json: ${out.bridges.length} Brücken (${[...by].map(([r, n]) => `${r} ${n}`).join(', ')})`);
const name = (id: string) => st.get(id)?.name ?? id;
for (const b of out.bridges) console.log(`  ${b.id.padEnd(4)} ${b.river.padEnd(11)} ${b.name} · ${b.segs.map(([a, c, m]) => `${name(a)}–${name(c)} (${m.join('')})`).join(', ')}`);
