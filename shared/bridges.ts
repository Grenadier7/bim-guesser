// „Brückenkenner“: Brücken, über die Öffis fahren (scripts/build-bridges.ts → data/bridges.json). Server und
// Browser zählen damit gleich, wie viele Brücken eine Route überquert.
import type { Mode } from './types.ts';

export interface Bridge {
  id: string;
  name: string;
  /** Donau (inkl. Neue Donau), Donaukanal, Wienfluss, Alte Donau */
  river: string;
  lat: number;
  lon: number;
  /** Abschnitte Station → nächste Station (beide Richtungen), die über diese Brücke führen – und mit welchen
   *  Verkehrsmitteln (die U3 unter dem Wienfluss nimmt nicht die Straßenbrücke darüber) */
  segs: [string, string, Mode[]][];
}

export interface BridgeData {
  source: string;
  generatedAt: string;
  bridges: Bridge[];
}

/** Abschnitt + Verkehrsmittel → Brücken (für schnelles Nachschlagen) */
export function bridgeIndex(d: BridgeData): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const b of d.bridges)
    for (const [a, c, modes] of b.segs) for (const mode of modes) for (const k of [`${a}|${c}|${mode}`, `${c}|${a}|${mode}`]) m.set(k, [...(m.get(k) ?? []), b.id]);
  return m;
}

/** Brücken entlang einer Fahrt (Stationen Einstieg … Ausstieg) mit diesem Verkehrsmittel */
export function bridgesAlong(index: Map<string, string[]>, stations: string[], mode: Mode | null): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < stations.length; i++) for (const b of index.get(`${stations[i]}|${stations[i + 1]}|${mode}`) ?? []) if (!out.includes(b)) out.push(b);
  return out;
}
