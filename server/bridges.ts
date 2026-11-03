// Brücken für „Brückenkenner“ (data/bridges.json, aus OpenStreetMap – scripts/build-bridges.ts), einmal geladen
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bridgeIndex, type BridgeData } from '../shared/bridges.ts';

const FILE = path.resolve(import.meta.dirname, '../data/bridges.json');
let data: BridgeData | null | undefined;
let index: Map<string, string[]> | null = null;

/** null = keine Daten (dann gibt es die Challenge nicht) */
export function bridgeData(): BridgeData | null {
  if (data === undefined) data = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as BridgeData) : null;
  return data;
}

/** Abschnitt „a|b“ → Brücken */
export function bridgeLookup(): Map<string, string[]> | null {
  const d = bridgeData();
  if (d && !index) index = bridgeIndex(d);
  return index;
}

/** roh für den Browser (Karte, Zählen im Baukasten) */
export const bridgeJson = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8') : null);
