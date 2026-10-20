// Ø-Takt je Linie an den Referenztagen (für den Steckbrief im Lernmodus) → data/headways.json
//
//   node scripts/build-headways.ts            (alle Linien, ~5 min, nutzt den Auskunfts-Cache in data/cache)
//   node scripts/build-headways.ts U6 13A     (nur diese Linien, zum Ausprobieren)
//
// Je Linie: ein Abschnitt in der Mitte der Hauptstrecke (dort fahren auch Kurzführungen), direkte Fahrten genau
// dieser Linie in einem 60-min-Fenster ab der Zeit. Takt = Ø Abstand der Abfahrten. Neu erzeugen, wenn sich das
// Netz ändert (wie data/network.json).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as efa from '../server/efa.ts';
import { regularPatterns, isSpecialLine } from '../shared/rules.ts';
import type { DayType, Headways, NetworkData } from '../shared/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const net = JSON.parse(readFileSync(path.join(ROOT, 'data/network.json'), 'utf8')) as NetworkData;

/** Zeitpunkte: Tagtyp + Uhrzeit */
export const HEADWAY_TIMES: { key: string; day: DayType; hour: number }[] = [
  { key: 'wd7', day: 'wd', hour: 7 },
  { key: 'wd12', day: 'wd', hour: 12 },
  { key: 'wd20', day: 'wd', hour: 20 },
  { key: 'sa12', day: 'sa', hour: 12 },
  { key: 'su12', day: 'su', hour: 12 },
];
const WINDOW = 60;

function startMin(day: DayType, hour: number): number {
  const [y, m, d] = net.regularDays[day].date.split('-').map(Number);
  return efa.naiveMinutes(y, m, d, hour, 0);
}

/** Abfahrten der Linie zwischen zwei Stationen im Fenster [t, t + WINDOW) */
async function departures(lineId: string, mode: string, from: string, to: string, t: number): Promise<number[] | null> {
  const fromIds = net.efaIds[from].slice(0, 2);
  const toIds = net.efaIds[to].slice(0, 2);
  for (const f of fromIds)
    for (const tt of toIds) {
      const deps = new Set<number>();
      let cursor = t;
      for (let i = 0; i < 6 && cursor < t + WINDOW; i++) {
        const trips = await efa.trip({ from: f, to: tt, time: cursor, mots: efa.motsForModes([mode as never]), maxChanges: 0, count: 8 });
        if (!trips.length) break;
        for (const trip of trips) {
          const pt = trip.legs.filter((l) => l.mode !== 'W');
          if (pt.length === 1 && pt[0].line === lineId && trip.dep >= t && trip.dep < t + WINDOW) deps.add(trip.dep);
        }
        const last = Math.max(...trips.map((x) => x.dep));
        if (last <= cursor) break;
        cursor = last + 1;
      }
      if (deps.size) return [...deps].sort((a, b) => a - b);
    }
  return null;
}

/** Ø Abstand: 60 min / Anzahl Abfahrten (gerundet auf 0,5 min); eine Abfahrt → „60“ */
export function meanHeadway(deps: number[], window = WINDOW): number {
  return Math.round((window / deps.length) * 2) / 2;
}

async function main() {
  const only = new Set(process.argv.slice(2));
  const lines = net.lines.filter((l) => (only.size ? only.has(l.id) : !isSpecialLine(l)));
  const out: Headways = { generatedAt: new Date().toISOString().slice(0, 10), lines: {} };
  let done = 0;
  await Promise.all(
    lines.map(async (l) => {
      const pats = regularPatterns(l);
      if (!pats.length) return;
      const main = pats.reduce((a, b) => (b.length > a.length ? b : a));
      if (main.length < 2) return;
      const i = Math.max(0, Math.floor(main.length / 2) - 1);
      const [a, b] = [main[i], main[Math.min(main.length - 1, i + 2)]];
      const row: Record<string, number | null> = {};
      for (const t of HEADWAY_TIMES) {
        try {
          const deps = await departures(l.id, l.mode, a, b, startMin(t.day, t.hour));
          row[t.key] = deps ? meanHeadway(deps) : null;
        } catch {
          row[t.key] = null;
        }
      }
      out.lines[l.id] = row;
      if (++done % 20 === 0) console.log(`  ${done}/${lines.length} Linien`);
    }),
  );
  if (only.size) return console.log(JSON.stringify(out.lines, null, 1));
  writeFileSync(path.join(ROOT, 'data/headways.json'), JSON.stringify(out));
  const missing = Object.entries(out.lines).filter(([, r]) => r.wd12 == null).map(([id]) => id);
  console.log(`✔ data/headways.json: ${Object.keys(out.lines).length} Linien, ohne Mittags-Takt: ${missing.join(' ') || '–'}`);
}

if (import.meta.main) await main();
