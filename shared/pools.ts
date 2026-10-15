import type { Line, Station, StationKind } from './types.ts';

/** Gehört die Station zu den gewählten Haltestellen-Arten? (Server und Client nutzen dieselbe Regel) */
export function inStationKinds(s: Station, kinds: StationKind[], line: (id: string) => Line | undefined): boolean {
  if (kinds.includes('U') && s.modes.includes('U')) return true;
  if (kinds.includes('S') && s.modes.includes('S')) return true;
  if (kinds.includes('T') && s.modes.includes('T')) return true;
  if (!s.modes.includes('B') && !s.modes.includes('N')) return false;
  // Bus-Stufen bauen aufeinander auf: Knoten (3+ Linien) ⊂ 2+ Linien ⊂ alle
  if (kinds.includes('all')) return true;
  const dayLines = s.lines.filter((id) => line(id) && line(id)!.mode !== 'N').length;
  const busLines = s.lines.filter((id) => line(id)?.mode === 'B').length;
  if (kinds.includes('bus')) return busLines >= 2 || (busLines >= 1 && dayLines >= 3);
  if (kinds.includes('hub')) return busLines >= 1 && dayLines >= 3;
  return false;
}
