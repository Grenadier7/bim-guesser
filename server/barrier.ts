// Donau als Hindernis für Fußwege (shared/barrier.ts) – einmal aus data/water.json und data/bridges.json gebaut
import { barrierJson, makeBarrier, walkRoute, type Barrier, type BarrierJson } from '../shared/barrier.ts';
import { bridgeData } from './bridges.ts';
import { waterData } from './water.ts';

let json: BarrierJson | null | undefined;
let barrier: Barrier | null = null;

/** null = keine Daten (dann sind Fußwege wie bisher Luftlinie) */
export function barrierData(): BarrierJson | null {
  if (json === undefined) {
    const w = waterData();
    const b = bridgeData();
    json = w && b ? barrierJson(w, b) : null;
    barrier = json ? makeBarrier(json) : null;
  }
  return json;
}

/** Fußweg in Metern – über die Donau nur über eine Brücke */
export function walkDistM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  barrierData();
  return walkRoute(barrier, a, b).m;
}
