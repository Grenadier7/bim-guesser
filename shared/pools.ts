import type { Line, Station, StationKind } from './types.ts';

/**
 * Bekannte U-Bahn-Stationen, die bei "wichtige" zusätzlich zu Endstellen und Umstiegen dabei sind
 * (Sehenswürdigkeiten, Plätze, Orientierungspunkte).
 */
const KEY_U_EXTRA = new Set([
  'Rathaus',
  'Museumsquartier',
  'Stadion',
  'Schönbrunn',
  'Taborstraße',
  'Stubentor',
  'Herrengasse',
  'Neubaugasse',
  'Thaliastraße',
  'Alser Straße',
  'Kaisermühlen-VIC',
  'Alte Donau',
  'Erdberg',
  'Messe-Prater',
  'Pilgramgasse',
]);

const isTerminus = (s: Station, lines: Line[]) => lines.some((l) => l.patterns.some((p) => p[0] === s.id || p[p.length - 1] === s.id));

/** Gehört die Station zu den gewählten Haltestellen-Arten? (Server und Client nutzen dieselbe Regel) */
export function inStationKinds(s: Station, kinds: StationKind[], line: (id: string) => Line | undefined): boolean {
  const lines = s.lines.map(line).filter((l): l is Line => !!l);
  const dayLines = lines.filter((l) => l.mode !== 'N').length;
  const rapid = lines.filter((l) => l.mode === 'U' || l.mode === 'S');
  const ofMode = (m: string) => lines.filter((l) => l.mode === m);

  if (s.modes.includes('U')) {
    if (kinds.includes('U')) return true;
    // wichtige U-Bahn-Stationen: Endstellen, Umstiege zu anderen U/S-Linien, große Knoten, bekannte Stationen
    if (kinds.includes('Ukey')) {
      const trams = ofMode('T').length;
      if (isTerminus(s, ofMode('U')) || rapid.length >= 2 || dayLines >= 6 || trams >= 2 || KEY_U_EXTRA.has(s.name)) return true;
    }
  }
  if (s.modes.includes('S')) {
    if (kinds.includes('S')) return true;
    // wichtige S-Bahn-Stationen: Endstellen, U-Bahn-Umstiege, Stammstrecke (4+ S-Linien)
    if (kinds.includes('Skey') && (isTerminus(s, ofMode('S')) || s.modes.includes('U') || ofMode('S').length >= 4)) return true;
  }
  if (s.modes.includes('T')) {
    if (kinds.includes('T')) return true;
    // wichtige Bim-Stationen: Endstellen und Umstiege
    if (kinds.includes('Tkey')) {
      const trams = ofMode('T');
      if (isTerminus(s, trams) || trams.length >= 2 || dayLines >= 3) return true;
    }
  }
  if (!s.modes.includes('B') && !s.modes.includes('N')) return false;
  // Bus-Stufen bauen aufeinander auf: Knoten (3+ Linien) ⊂ 2+ Linien ⊂ alle
  if (kinds.includes('all')) return true;
  const busLines = ofMode('B').length;
  if (kinds.includes('bus')) return busLines >= 2 || (busLines >= 1 && dayLines >= 3);
  if (kinds.includes('hub')) return busLines >= 1 && dayLines >= 3;
  return false;
}
