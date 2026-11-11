// „Ab ins Wasser“: Gewässer (Donau, Donaukanal, Wienfluss, Alte Donau, Mühlwasser, Asperner See, Prater-Wässer, Bäche …) und Bäder aus OpenStreetMap
// (scripts/build-water.ts → data/water.json). Nächstes Wasser zu einem Punkt – Server und Browser rechnen gleich.

export interface WaterData {
  waters: { name: string; kind: 'river' | 'lake' | 'bath'; lines: [number, number][][] }[];
  baths: { name: string; lat: number; lon: number }[];
}

export interface WaterHit {
  name: string;
  /** Entfernung (m) */
  dist: number;
  lat: number;
  lon: number;
}

/** so schnell geht man (wie in der Routenberechnung): Umweg-Faktor 1,3, 80 m/min */
export const walkMinutes = (m: number) => Math.max(1, Math.round((m * 1.3) / 80));

/** nächstes Wasser (Fluss/See-Ufer oder Bad) zu einem Punkt – `kind` 'bath': nur Bäder („Ab ins Bad“) */
export function nearestWater(w: WaterData, p: { lat: number; lon: number }, kind: 'all' | 'bath' = 'all'): WaterHit {
  const k = Math.cos((p.lat * Math.PI) / 180) * 111_320;
  let best: WaterHit = { name: '', dist: Infinity, lat: 0, lon: 0 };
  const check = (name: string, lat: number, lon: number) => {
    const d = Math.hypot((lon - p.lon) * k, (lat - p.lat) * 111_320);
    if (d < best.dist) best = { name, dist: d, lat, lon };
  };
  if (kind === 'all') for (const x of w.waters) for (const line of x.lines) for (const [lat, lon] of line) check(x.name, lat, lon);
  for (const b of w.baths) check(b.name, b.lat, b.lon);
  return { ...best, dist: Math.round(best.dist) };
}
