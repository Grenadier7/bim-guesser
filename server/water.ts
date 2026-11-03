// Gewässer-Daten für „Ab ins Wasser“ (data/water.json, aus OpenStreetMap – scripts/build-water.ts), einmal geladen
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WaterData } from '../shared/water.ts';

const FILE = path.resolve(import.meta.dirname, '../data/water.json');
let data: WaterData | null | undefined;

/** null = keine Daten (dann gibt es die Challenge nicht) */
export function waterData(): WaterData | null {
  if (data === undefined) data = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as WaterData) : null;
  return data;
}

/** roh für den Browser (Karte, Fußweg zum Wasser) */
export const waterJson = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8') : null);
