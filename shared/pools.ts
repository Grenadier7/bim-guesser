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

/** Admin-Seite: einzelne Stationen je Haltestellen-Art zusätzlich aufnehmen oder ausnehmen (Station-IDs) */
export const POOL_OVERRIDES: { add: Partial<Record<StationKind, Set<string>>>; remove: Partial<Record<StationKind, Set<string>>> } = { add: {}, remove: {} };

/** Gehört die Station zu den gewählten Haltestellen-Arten? (Server und Client nutzen dieselbe Regel) */
export function inStationKinds(s: Station, kinds: StationKind[], line: (id: string) => Line | undefined): boolean {
  const lines = s.lines.map(line).filter((l): l is Line => !!l);
  return kinds.some((k) => !!POOL_OVERRIDES.add[k]?.has(s.id) || (!POOL_OVERRIDES.remove[k]?.has(s.id) && matchesKind(s, k, lines)));
}

/** Regel je Haltestellen-Art (ohne die Ausnahmen der Admin-Seite) – für die Vorschau auf der Admin-Seite */
export function ruleMatches(s: Station, k: StationKind, line: (id: string) => Line | undefined): boolean {
  return matchesKind(s, k, s.lines.map(line).filter((l): l is Line => !!l));
}

function matchesKind(s: Station, k: StationKind, lines: Line[]): boolean {
  const dayLines = lines.filter((l) => l.mode !== 'N').length;
  const rapid = lines.filter((l) => l.mode === 'U' || l.mode === 'S');
  const ofMode = (m: string) => lines.filter((l) => l.mode === m);
  const busLines = ofMode('B').length;
  const bus = s.modes.includes('B') || s.modes.includes('N');
  switch (k) {
    case 'U':
      return s.modes.includes('U');
    // wichtige U-Bahn-Stationen: Endstellen, Umstiege zu anderen U/S-Linien, große Knoten, bekannte Stationen
    case 'Ukey':
      return s.modes.includes('U') && (isTerminus(s, ofMode('U')) || rapid.length >= 2 || dayLines >= 6 || ofMode('T').length >= 2 || KEY_U_EXTRA.has(s.name));
    case 'S':
      return s.modes.includes('S');
    // wichtige S-Bahn-Stationen: Endstellen, U-Bahn-Umstiege, Stammstrecke (4+ S-Linien)
    case 'Skey':
      return s.modes.includes('S') && (isTerminus(s, ofMode('S')) || s.modes.includes('U') || ofMode('S').length >= 4);
    case 'T':
      return s.modes.includes('T');
    // wichtige Bim-Stationen: Endstellen und Umstiege
    case 'Tkey':
      return s.modes.includes('T') && (isTerminus(s, ofMode('T')) || ofMode('T').length >= 2 || dayLines >= 3);
    // Bus-Stufen bauen aufeinander auf: Knoten (3+ Linien) ⊂ 2+ Linien ⊂ alle
    case 'all':
      return bus;
    case 'bus':
      return bus && (busLines >= 2 || (busLines >= 1 && dayLines >= 3));
    case 'hub':
      return bus && busLines >= 1 && dayLines >= 3;
  }
}
