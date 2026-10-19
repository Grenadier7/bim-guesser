// Geometrie und Stationsnamen – gemeinsam für Server, Client und Build-Skript

/** Stadtmitte (Stephansplatz) – für „innen/außen“, Himmelsrichtungen und Beschriftungs-Gewichtung */
export const CENTER = { lat: 48.2085, lon: 16.3731 };

/** Abstand in Metern (lokale Näherung, für Wien völlig ausreichend) */
export function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** Stationsname zum Vergleichen: ohne Klammerzusätze und „S U“-Endungen, klein geschrieben */
export function normName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+(S\s*U|U\s*S|S|U)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
