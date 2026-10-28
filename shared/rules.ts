import type {
  DayType,
  Difficulty,
  DistanceRange,
  StationKind,
  GameSettings,
  Line,
  Mode,
  NetMode,
  Restriction,
  RestrictionFrequency,
  RouteGoal,
  XtremeLevel,
  TipLevel,
  RouteOption,
  ScoreBreakdown,
  SlotId,
  TimeSlot,
  TipInfo,
  TipKind,
} from './types.ts';

// ---------------------------------------------------------------- Einstellungen

export const TIME_SLOTS: TimeSlot[] = [
  { id: 'wd12', label: 'Wochentag 12:00', short: 'Mo–Fr 12 Uhr' },
  { id: 'wd17', label: 'Wochentag 17:00', short: 'Mo–Fr 17 Uhr' },
  { id: 'sa02', label: 'Samstag 02:00 (Nacht)', short: 'Sa 2 Uhr' },
  { id: 'su12', label: 'Sonntag 12:00', short: 'So 12 Uhr' },
];

export const NET_MODES: { id: NetMode; label: string; hint: string }[] = [
  { id: 'regular', label: 'Regulär', hint: 'Fahrplan eines Referenztags ohne Baustellen' },
  { id: 'current', label: 'Aktuell', hint: 'Nächster echter Tag – inkl. Sperren & Ersatzverkehr' },
];

export const SLOT_DAYTYPE: Record<SlotId, DayType> = { wd12: 'wd', wd17: 'wd', sa02: 'sa', su12: 'su' };

// ---------------------------------------------------------------- Schwierigkeit
// Drei Regler (Haltestellen, Entfernung, Umstieg); die Stufen Leicht…Profi sind nur Schnellwahlen.
// Der Punkte-Multiplikator ergibt sich aus den Reglern.

/**
 * Haltestellen: Schiene frei kombinierbar, Bus als Stufe (Knoten ⊂ 2+ Linien ⊂ alle).
 * Der Multiplikator richtet sich nach der schwierigsten gewählten Art.
 */
export interface StationLevel {
  id: StationKind;
  short: string;
  label: string;
  hint: string;
  factor: number;
}

/** Haltestellen je Verkehrsmittel: aus oder eine Stufe (von wenigen zu allen) */
export const STATION_GROUPS: { id: 'U' | 'S' | 'T' | 'B'; icon: string; label: string; levels: StationLevel[] }[] = [
  {
    id: 'U',
    icon: '🚇',
    label: 'U-Bahn',
    levels: [
      { id: 'Ukey', short: 'Wichtige', label: 'wichtige U-Bahn-Stationen', hint: 'Endstellen, Umstiege und bekannte Stationen (~60 %)', factor: 0.85 },
      { id: 'U', short: 'Alle', label: 'alle U-Bahn-Stationen', hint: 'jede U-Bahn-Station', factor: 0.9 },
    ],
  },
  {
    id: 'S',
    icon: '🚆',
    label: 'S-Bahn',
    levels: [
      { id: 'Skey', short: 'Wichtige', label: 'wichtige S-Bahn-Stationen', hint: 'Endstellen, Stammstrecke und U-Bahn-Umstiege (~60 %)', factor: 0.95 },
      { id: 'S', short: 'Alle', label: 'alle S-Bahn-Stationen', hint: 'jede S-Bahn-Station in Wien', factor: 1 },
    ],
  },
  {
    id: 'T',
    icon: '🚋',
    label: 'Bim',
    levels: [
      { id: 'Tkey', short: 'Wichtige', label: 'wichtige Bim-Stationen', hint: 'Endstellen und Umstiege (2+ Bim-Linien oder 3+ Linien insgesamt)', factor: 1.1 },
      { id: 'T', short: 'Alle', label: 'alle Bim-Stationen', hint: 'jede Straßenbahn-Haltestelle', factor: 1.2 },
    ],
  },
  {
    id: 'B',
    icon: '🚌',
    label: 'Bus',
    levels: [
      { id: 'hub', short: 'Knoten', label: 'Bus-Knoten', hint: 'Bus-Haltestellen, an denen 3+ Linien halten', factor: 1.3 },
      { id: 'bus', short: 'Viele', label: 'Bus (2+ Linien)', hint: 'Bus-Haltestellen mit mindestens 2 Linien', factor: 1.35 },
      { id: 'all', short: 'Alle', label: 'alle Bus-Haltestellen', hint: 'jede Bus-Haltestelle, auch mit nur einer Linie', factor: 1.4 },
    ],
  },
];
export const STATION_KINDS: StationLevel[] = STATION_GROUPS.flatMap((g) => g.levels);

/** gewählte Stufe eines Verkehrsmittels (null = aus) */
export function groupLevel(kinds: StationKind[], group: (typeof STATION_GROUPS)[number]['id']): StationKind | null {
  const g = STATION_GROUPS.find((x) => x.id === group)!;
  return [...g.levels].reverse().find((l) => kinds.includes(l.id))?.id ?? null;
}

/** gültige Arten in fester Reihenfolge, je Verkehrsmittel nur die höchste Stufe */
export function cleanStationKinds(v: unknown): StationKind[] | null {
  if (!Array.isArray(v)) return null;
  const out: StationKind[] = [];
  for (const g of STATION_GROUPS) {
    const hit = [...g.levels].reverse().find((l) => v.includes(l.id));
    if (hit) out.push(hit.id);
  }
  return out.length ? out : null;
}

/** alte Einstellung (Stufe 1–6) in Arten umrechnen */
export function stationKindsFromPool(pool: unknown): StationKind[] | null {
  const n = Number(pool);
  if (!Number.isInteger(n) || n < 1 || n > 6) return null;
  // alte Stufen: 1 U · 2 +S · 3 +Bim · 4 +Knoten · 5 +Bus · 6 alle
  const old: StationKind[] = ['U', 'S', 'T', 'hub', 'bus', 'all'];
  return cleanStationKinds(old.slice(0, n));
}

export const DISTANCES: { id: DistanceRange; label: string; range: [number, number]; factor: number }[] = [
  { id: 'short', label: '2–7 km', range: [2000, 7000], factor: 0.9 },
  { id: 'medium', label: '3–12 km', range: [3000, 12000], factor: 1 },
  { id: 'long', label: '6–16 km', range: [6000, 16000], factor: 1.1 },
];

/** Punkte-Faktor je Mindest-Umstiegszahl (0 · 1 · 2) */
export const MIN_TRANSFER_FACTORS = [1, 1.05, 1.1];


export function cleanMinTransfers(v: unknown): 0 | 1 | 2 | null {
  const n = Number(v);
  return n === 0 || n === 1 || n === 2 ? n : null;
}

export interface DifficultyPreset {
  id: Exclude<Difficulty, 'custom'>;
  label: string;
  stations: StationKind[];
  distance: DistanceRange;
  minTransfers: 0 | 1 | 2;
}

export const DIFFICULTY_PRESETS: DifficultyPreset[] = [
  { id: 'easy', label: 'Leicht', stations: ['Ukey', 'Skey'], distance: 'medium', minTransfers: 0 },
  { id: 'medium', label: 'Mittel', stations: ['U', 'S'], distance: 'medium', minTransfers: 1 },
  { id: 'hard', label: 'Schwer', stations: ['U', 'S', 'T'], distance: 'medium', minTransfers: 2 },
  { id: 'expert', label: 'Profi', stations: ['U', 'S', 'T', 'all'], distance: 'long', minTransfers: 2 },
];

/** Passt die Regler-Stellung zu einer Schnellwahl? Sonst "custom". */
export function matchPreset(s: Pick<GameSettings, 'stations' | 'distance' | 'minTransfers'>): Difficulty {
  const p = DIFFICULTY_PRESETS.find(
    (x) => x.stations.join() === s.stations.join() && x.distance === s.distance && x.minTransfers === s.minTransfers,
  );
  return p?.id ?? 'custom';
}

export function distanceRange(d: DistanceRange): [number, number] {
  return DISTANCES.find((x) => x.id === d)!.range;
}

/**
 * Start/Ziel als Adressen: die Haltestellen-Auswahl gilt nicht – Faktor wie Bus-Knoten (man muss die Linien der
 * Gegend kennen und den Weg zur passenden Haltestelle finden)
 */
export const ADDRESS_FACTOR = 1.3;

export function difficultyMultiplier(s: Pick<GameSettings, 'stations' | 'distance' | 'minTransfers'> & { endpoints?: GameSettings['endpoints'] }): number {
  // schwierigste gewählte Stufe zählt; ohne Auswahl 0,9 (früher war 0,9 auch die Untergrenze → „wichtige U“ ×0,85 wirkte nie, Befund L-01)
  const factors = STATION_KINDS.filter((k) => s.stations.includes(k.id)).map((k) => k.factor);
  const pool = s.endpoints === 'addresses' ? ADDRESS_FACTOR : factors.length ? Math.max(...factors) : 0.9;
  const dist = DISTANCES.find((x) => x.id === s.distance)!.factor;
  return Math.round(pool * dist * (MIN_TRANSFER_FACTORS[s.minTransfers] ?? 1) * 100) / 100;
}

/** Fokus-Kreis: erlaubte Radien und Anteile */
export const FOCUS_RADII = [1500, 2500, 4000, 6000];
/** Anteil der Stationen aus dem Kreis: 10–90 % in 10-%-Schritten */
export const FOCUS_SHARE_MIN = 0.1;
export const FOCUS_SHARE_MAX = 0.9;

export function cleanFocusShare(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(FOCUS_SHARE_MAX, Math.max(FOCUS_SHARE_MIN, Math.round(n * 10) / 10));
}

export const TIME_LIMITS = [60, 120, 180, 240, 300, 600];

// Standardwerte: shared/defaults.ts
export { DEFAULT_SETTINGS } from './defaults.ts';

/** Haltefolgen einer Linie, die im gewählten Netz existieren */
export function linePatterns(line: Line, net: NetMode): string[][] {
  const flag = net === 'current' ? 'c' : 'r';
  return line.patterns.filter((_, i) => line.nets[i].includes(flag));
}

/** Haltefolgen im regulären Netz – Linien, die es nur im aktuellen Fahrplan gibt, mit ihren aktuellen */
export function regularPatterns(line: Line): string[][] {
  const reg = linePatterns(line, 'regular');
  return reg.length ? reg : linePatterns(line, 'current');
}

/** Regionalzüge (R, REX, CJX) aus dem eigenen Fahrplan – fahren auf S-Bahn-Strecken mit, im Spiel eingebbar */
export const isRegionalTrain = (l: { id: string }) => /^(R|REX|CJX)\d+$/.test(l.id);

/**
 * Sonderlinien wie 71E oder 26E (Ersatz-/Verstärkerverkehr) und Regionalzüge – zum Lernen, im Quiz und auf der
 * Netzkarte irreführend (die Regionalzüge lägen genau auf den S-Bahn-Strecken)
 */
export const isSpecialLine = (l: { id: string }) => /^\d+E$/.test(l.id) || isRegionalTrain(l);

export function isSlotId(v: unknown): v is SlotId {
  return TIME_SLOTS.some((s) => s.id === v);
}

// ---------------------------------------------------------------- Wertung: Modus („Was zählt?“)

/**
 * Drei klar verschiedene Wertungen statt drei einzelner Schalter (countWait, avgWait, goal – die bleiben intern):
 *  - realistic: Tür-zu-Tür mit Ø-Wartezeiten – optional „Umstiege vermeiden“ (+2 min je Umstieg = goal 'best')
 *  - info: wie die Auskunft – Tür-zu-Tür mit echten Abfahrten, nur Zeit
 *  - ride: nur Fahrzeit – ab Einstieg mit echten Abfahrten, Warten am Start egal
 * Andere Kombinationen (alte Links/Einstellungen) heißen „eigene“ und bleiben, bis man einen Modus wählt.
 */
export type ScoringMode = 'realistic' | 'info' | 'ride';

export const SCORING_MODES: { id: ScoringMode; icon: string; label: string; hint: string; settings: Pick<GameSettings, 'countWait' | 'avgWait' | 'goal'> }[] = [
  {
    id: 'realistic',
    icon: '🧭',
    label: 'Realistisch',
    hint: 'Tür zu Tür, wie im echten Leben: Fahrzeit + Umsteigeweg + durchschnittliche Wartezeit auf jede Linie (S-Bahn alle 15 min → Ø 7,5 min). Ein zufällig perfekter Anschluss bringt nichts. Am Start zählt nur die halbe Ø-Wartezeit – zur ersten Abfahrt kann man sich die Zeit einteilen.',
    settings: { countWait: true, avgWait: true, goal: 'fastest' },
  },
  {
    id: 'info',
    icon: '🕐',
    label: 'Wie die Auskunft',
    hint: 'Wie WienMobil oder AnachB „ab jetzt“: echte Abfahrten ab der Abfragezeit (zu 6 Zeitpunkten, Median) – wer einen knappen Anschluss erwischt, hat Glück.',
    settings: { countWait: true, avgWait: false, goal: 'fastest' },
  },
  {
    id: 'ride',
    icon: '🚇',
    label: 'Nur Fahrzeit',
    hint: 'Nur die Zeit ab dem Einsteigen zählt (echte Abfahrten) – wie lange man am Start wartet, ist egal. Für reines Linienwissen.',
    settings: { countWait: false, avgWait: false, goal: 'fastest' },
  },
];

/** Welcher Modus? null = eigene Kombination (z.B. aus einem alten geteilten Link) */
export function scoringModeOf(s: Pick<GameSettings, 'countWait' | 'avgWait' | 'goal'>): ScoringMode | null {
  if (s.countWait && s.avgWait) return 'realistic';
  if (s.goal !== 'fastest') return null;
  if (s.countWait && !s.avgWait) return 'info';
  if (!s.countWait && !s.avgWait) return 'ride';
  return null;
}

// ---------------------------------------------------------------- Wertung: schnellste oder beste Route

export const ROUTE_GOALS: { id: RouteGoal; label: string; hint: string }[] = [
  { id: 'best', label: '🏅 Beste Route', hint: 'Reisezeit + Aufschlag je Umstieg – bequemere Wege zählen mit' },
  { id: 'fastest', label: '⚡ Schnellste Route', hint: 'nur die Reisezeit zählt' },
];

/**
 * Aufschlag je Umstieg bei "beste Route". Mit Ø-Wartezeiten ist das Warten schon eingerechnet –
 * dann steht der Aufschlag nur noch für Aufwand/Risiko (2 min). Mit echtem Fahrplan 4 min.
 */
export const TRANSFER_PENALTY_AVG_MIN = 2;
export const TRANSFER_PENALTY_FIXED_MIN = 4;

export type RouteScoring = Pick<GameSettings, 'goal' | 'avgWait'>;

export function transferPenalty(s: RouteScoring): number {
  if (s.goal !== 'best') return 0;
  return s.avgWait ? TRANSFER_PENALTY_AVG_MIN : TRANSFER_PENALTY_FIXED_MIN;
}

export function transfersOf(route: Pick<RouteOption, 'legs'>): number {
  return Math.max(0, route.legs.filter((l) => l.mode !== 'W').length - 1);
}

/** Gewertete Minuten einer Route */
export function routeCost(minutes: number, transfers: number, s: RouteScoring): number {
  return minutes + transferPenalty(s) * transfers;
}

export function routeCostOf(route: RouteOption, s: RouteScoring): number {
  return routeCost(route.medianMin, transfersOf(route), s);
}

/** Top-Verbindungen nach Wertung sortieren (stabil: bei Gleichstand bleibt die schnellere vorne) */
export function sortRoutes(routes: RouteOption[], s: RouteScoring): RouteOption[] {
  return routes
    .map((r, i) => ({ r, i, c: routeCostOf(r, s) }))
    .sort((a, b) => a.c - b.c || a.i - b.i)
    .map((x) => x.r);
}

// ---------------------------------------------------------------- X-treme

export const XTREME_LEVELS: { id: XtremeLevel; label: string; hint: string }[] = [
  { id: 'off', label: 'Aus', hint: 'normales Spiel' },
  {
    id: 'noHints',
    label: 'Ohne Vorschläge',
    hint: 'Ein- und Ausstieg selbst eintippen (Auto-Vervollständigung aller Stationen), auf der Karte nur Start und Ziel – keine Route.',
  },
  { id: 'noNames', label: 'Ohne Namen', hint: 'Wie „Ohne Vorschläge“ – und Start und Ziel sind nur Punkte auf der Karte, ohne Namen.' },
  { id: 'noMap', label: 'Ohne Karte', hint: 'Wie „Ohne Vorschläge“ – und auf der Karte ist gar nichts eingezeichnet, nur die Namen von Start und Ziel.' },
];
/** X-treme verdoppelt die Zeit */
export const XTREME_TIME_FACTOR = 2;

/** Zeitlimit einer normalen Runde (mit X-treme verdoppelt) */
export function baseLimitSec(s: Pick<GameSettings, 'roundTimeLimitSec' | 'xtreme'>): number | null {
  if (!s.roundTimeLimitSec) return null;
  return s.roundTimeLimitSec * (s.xtreme !== 'off' ? XTREME_TIME_FACTOR : 1);
}

/** Bei "ohne Namen" und "ohne Karte" gibt es kein "Wo liegt das?" */
export const xtremeBlocksLocate = (x: XtremeLevel) => x === 'noNames' || x === 'noMap';

// ---------------------------------------------------------------- Einschränkungen

export const RESTRICTIONS: Record<Restriction, { label: string; hint: string; icon: string }> = {
  noU: { label: 'Ohne U-Bahn', hint: 'Diese Runde darfst du keine U-Bahn verwenden.', icon: '🚫🚇' },
  noBus: { label: 'Ohne Bus', hint: 'Diese Runde darfst du keinen Bus verwenden.', icon: '🚫🚌' },
  oneTransfer: { label: 'Max. 1 Umstieg', hint: 'Höchstens zwei Linien – also maximal ein Umstieg.', icon: '1️⃣' },
  banLines: { label: 'Linie gesperrt', hint: 'Eine Linie der schnellsten Verbindung ist gesperrt – finde eine Alternative.', icon: '⛔' },
};

export const RESTRICTION_FREQUENCIES: { id: RestrictionFrequency; label: string }[] = [
  { id: 'never', label: 'Nie' },
  { id: 'sometimes', label: 'Manchmal' },
  { id: 'always', label: 'Immer' },
];

/** "Manchmal": Anteil der Runden mit Einschränkung – mindestens eine pro Spiel */
export const RESTRICTION_CHANCE = 0.3;
/** Einschränkungs-Runden haben doppelte Zeit, aber höchstens 2:30 mehr … */
export const RESTRICTION_EXTRA_MAX_SEC = 150;
/** … schwere Einschränkungen (ohne U-Bahn) bekommen fix 4 Minuten mehr */
export const HARD_RESTRICTIONS: Restriction[] = ['noU'];
export const HARD_RESTRICTION_EXTRA_SEC = 240;

export function roundLimitSec(base: number | null, restriction: Restriction | null): number | null {
  if (!base) return null;
  if (!restriction) return base;
  if (HARD_RESTRICTIONS.includes(restriction)) return base + HARD_RESTRICTION_EXTRA_SEC;
  return base + Math.min(base, RESTRICTION_EXTRA_MAX_SEC);
}

/** Text für eine Einschränkung, z.B. "Ohne Linie U6" */
export function restrictionLabel(r: Restriction, banned: string[]): string {
  if (r === 'banLines') return `Ohne ${banned.length > 1 ? 'Linien' : 'Linie'} ${banned.join(', ')}`;
  return RESTRICTIONS[r].label;
}

export function restrictionAllowsLine(r: Restriction | null, banned: string[], line: { id: string; mode: Mode }): boolean {
  if (r === 'banLines' && banned.includes(line.id)) return false;
  return restrictionAllowsMode(r, line.mode);
}

export function restrictionAllowsMode(r: Restriction | null, mode: Mode): boolean {
  if (r === 'noU') return mode !== 'U';
  if (r === 'noBus') return mode !== 'B' && mode !== 'N';
  return true;
}

export function restrictionMaxLegs(r: Restriction | null): number {
  return r === 'oneTransfer' ? 2 : 8;
}

// ---------------------------------------------------------------- Tipps
// Tipps kosten einen Anteil der Routenpunkte statt fixer Punkte:
// so kostet ein Tipp nie mehr, als er einbringt.

export const TIPS: Record<TipKind, TipInfo> = {
  startLines: { kind: 'startLines', label: 'Linien am Start', share: 0.45 },
  endLines: { kind: 'endLines', label: 'Linien am Ziel', share: 0.45 },
  modeChain: { kind: 'modeChain', label: 'Verkehrsmittel der schnellsten Route', share: 0.45 },
  transfers: { kind: 'transfers', label: 'Umstiegsorte auf der Karte', share: 0.55 },
};

// ---------------------------------------------------------------- Punkte
//
// Pro Runde (vor Multiplikator):
//   Route        0–1000  relativ zur schnellsten Verbindung
//   − Tipps      Anteil der Routenpunkte (45/45/45/55 %). Mehrere Tipps verrechnen sich multiplikativ
//                (Start + Ziel: 55 % von 55 % ≈ 30 % bleiben), mindestens 10 % bleiben immer.
//                Bei 30 min optimal entspricht das ungefähr: Start ≈ 38 min ohne Tipp, Start+Ziel ≈ 43,
//                Umstiegsorte ≈ 40, Start+Ziel+Verkehrsmittel ≈ 46, alle Tipps = 10 %
//   + Zeitbonus  bis +10 % der Routenpunkte, linear mit Restzeit (ohne Limit: an 3:00 gemessen)
//   + Ortung     bis 150 (75 je Station) bei "Wo liegt das?"
//   × Schwierigkeit  aus den Reglern (Haltestellen × Entfernung × Umstieg), ca. 0,8–1,5

export const MAX_ROUTE_POINTS = 1000;
export const TIME_BONUS_SHARE = 0.1;
/** Referenzzeit für den Zeitbonus, wenn kein Zeitlimit gesetzt ist */
export const TIME_BONUS_REF_SEC = 180;
export const LOCATE_POINTS_PER_STATION = 75;
const LOCATE_FULL_M = 250;
const LOCATE_ZERO_M = 3000;

/** Ab diesem relativen Umweg gibt es 0 Punkte */
export const ROUTE_ZERO_REL = 0.7;
/** Besser als die beste gefundene Route: je 1 % besser +2 % Punkte … */
export const BEAT_BONUS_FACTOR = 2;
/** … höchstens so viele Extrapunkte */
export const BEAT_BONUS_MAX = 300;

/**
 * Routenpunkte. Toleranz: max(1 min, 4 %) – danach fällt es ab,
 * bei +70 % Reisezeit gibt's nichts mehr.
 *   30 vs 38 min -> ~560,  30 vs 45 min -> ~200,  40 vs 60 min -> ~200
 * Besser als die beste Route der Auskunft → über 1000:
 *   30 vs 29 min -> ~1067,  30 vs 27 min -> 1200,  30 vs 24 min -> 1300 (Maximum)
 */
export function scoreRoute(userMin: number, bestMin: number): number {
  if (!Number.isFinite(userMin) || !Number.isFinite(bestMin)) return 0;
  if (userMin < bestMin) {
    const better = (bestMin - userMin) / Math.max(bestMin, 10);
    return Math.round(MAX_ROUTE_POINTS + Math.min(BEAT_BONUS_MAX, MAX_ROUTE_POINTS * better * BEAT_BONUS_FACTOR));
  }
  const grace = Math.max(1, bestMin * 0.04);
  const delta = Math.max(0, userMin - bestMin - grace);
  const rel = delta / Math.max(bestMin, 10);
  const f = Math.max(0, 1 - rel / ROUTE_ZERO_REL);
  return Math.round(MAX_ROUTE_POINTS * f ** 1.5);
}

export function locatePoints(distM: number | null): number {
  if (distM == null) return 0;
  const f = Math.min(1, Math.max(0, (LOCATE_ZERO_M - distM) / (LOCATE_ZERO_M - LOCATE_FULL_M)));
  return Math.round(LOCATE_POINTS_PER_STATION * f);
}

export function timeBonus(routeAfterTips: number, elapsedSec: number | null, limitSec: number | null): number {
  if (elapsedSec == null) return 0;
  const ref = limitSec ?? TIME_BONUS_REF_SEC;
  // 0…1 – auch bei negativer Zeit (Uhrenversatz) nie mehr als 10 % (Befund L-04)
  const f = Math.min(1, Math.max(0, 1 - elapsedSec / ref));
  return Math.round(routeAfterTips * TIME_BONUS_SHARE * f);
}

/** Tipp-Stufen: günstig = 5 Prozentpunkte billiger, teuer = 20 Prozentpunkte teurer als die Grundwerte */
export const TIP_LEVELS: { id: TipLevel; label: string; delta: number }[] = [
  { id: 'off', label: 'Keine', delta: 0 },
  { id: 'cheap', label: 'Günstig', delta: -0.05 },
  { id: 'expensive', label: 'Teuer', delta: 0.2 },
];

/** Abzug eines Tipps auf dieser Stufe (0–0.95) */
export function tipShare(kind: TipKind, level: TipLevel): number {
  const d = TIP_LEVELS.find((x) => x.id === level)?.delta ?? 0;
  return Math.max(0, Math.min(0.95, Math.round((TIPS[kind].share + d) * 100) / 100));
}

/** Mindestens so viel der Routenpunkte bleibt auch mit allen Tipps */
export const TIP_MIN_KEEP = 0.1;

/** Gesamtabzug der Tipps: multiplikativ, damit sich Tipps nicht auf über 100 % summieren */
export function tipShareOf(tips: TipKind[], level: TipLevel = 'cheap'): number {
  const keep = tips.reduce((k, t) => k * (1 - tipShare(t, level)), 1);
  return Math.round((1 - Math.max(TIP_MIN_KEEP, keep)) * 1000) / 1000;
}

export function computeScore(o: {
  routePoints: number;
  tips: TipKind[];
  elapsedSec: number | null;
  limitSec: number | null;
  locateDist: { from: number | null; to: number | null } | null;
  multiplier: number;
  tipLevel?: TipLevel;
}): ScoreBreakdown {
  const tipShare = tipShareOf(o.tips, o.tipLevel);
  const routeAfterTips = Math.round(o.routePoints * (1 - tipShare));
  const tb = timeBonus(routeAfterTips, o.elapsedSec, o.limitSec);
  const locate = o.locateDist ? locatePoints(o.locateDist.from) + locatePoints(o.locateDist.to) : 0;
  const multiplier = o.multiplier;
  return {
    route: o.routePoints,
    tipShare,
    routeAfterTips,
    timeBonus: tb,
    locate,
    multiplier,
    total: Math.round((routeAfterTips + tb + locate) * multiplier),
  };
}

/**
 * Höchstpunkte einer Runde mit der besten Route der Auskunft (Anzeige „Max. … Punkte“, Prozent-Balken).
 * Wer eine noch bessere Route findet, bekommt bis zu +30 % Bonus darüber hinaus – siehe maxRoundPointsWithBonus.
 */
export function maxRoundPoints(s: GameSettings): number {
  const base = MAX_ROUTE_POINTS * (1 + TIME_BONUS_SHARE) + (s.locate ? 2 * LOCATE_POINTS_PER_STATION : 0);
  return Math.round(base * difficultyMultiplier(s));
}

/** absolutes Maximum inkl. Bonus für eine bessere Route als die der Auskunft (Befund L-02) */
export function maxRoundPointsWithBonus(s: GameSettings): number {
  const base = (MAX_ROUTE_POINTS + BEAT_BONUS_MAX) * (1 + TIME_BONUS_SHARE) + (s.locate ? 2 * LOCATE_POINTS_PER_STATION : 0);
  return Math.round(base * difficultyMultiplier(s));
}

// ---------------------------------------------------------------- Darstellung

export const MODE_LABEL: Record<Mode, string> = {
  U: 'U-Bahn',
  S: 'S-Bahn',
  T: 'Straßenbahn',
  B: 'Bus',
  N: 'Nachtbus',
  W: 'Fußweg',
};

export const MODE_ICON: Record<Mode, string> = {
  U: '🚇',
  S: '🚆',
  T: '🚋',
  B: '🚌',
  N: '🌙',
  W: '🚶',
};

const U_COLORS: Record<string, string> = {
  U1: '#e3000f',
  U2: '#a762a3',
  U3: '#ee7d00',
  U4: '#319f49',
  U5: '#2cb1b1',
  U6: '#9d6930',
};

export const MODE_COLOR: Record<Mode, string> = {
  U: '#555555',
  S: '#1e6fbf',
  // dunkles Bim-Rot – klar unterscheidbar vom hellen Rot der U1 (#e3000f)
  T: '#9e1b32',
  B: '#0a295d',
  N: '#3b2a7a',
  W: '#7a7a7a',
};

/** Badner Bahn: eigenes Blau – dunkler als die S-Bahn, damit man sie nicht verwechselt */
export const BB_COLOR = '#2b4c9b';

export function lineColor(mode: Mode, line: string | null): string {
  if (mode === 'U' && line) return U_COLORS[line.slice(0, 2)] ?? MODE_COLOR.U;
  if (line === 'BB') return BB_COLOR;
  return MODE_COLOR[mode];
}

/**
 * Linien, die im Spiel als gleichwertig gelten: auf demselben Abschnitt (gleiche Ein- und
 * Ausstiegsstation) zählt jede S-Bahn, jede Bim bzw. jeder Bus gleich – z.B. S1/S2/S3 auf der
 * Stammstrecke oder 30/31 zwischen Brünner Straße und Floridsdorf. U-Bahn-Linien bleiben getrennt.
 */
export function lineKey(mode: Mode, line: string): string {
  if (mode === 'U') return line;
  if (mode === 'N') return 'B';
  return mode;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Restzeit statt benötigter Zeit (Wunsch N-4): „2:10 / 3:00 übrig“ bzw. bei kurzen Limits „7 / 15 s übrig“.
 * Ohne Zeitlimit gibt es keine Restzeit – dann die benötigte Zeit („in 0:50“).
 */
export function fmtTimeLeft(elapsedSec: number, limitSec: number | null | undefined): string {
  if (!limitSec) return `in ${fmtDuration(elapsedSec)}`;
  const left = Math.max(0, limitSec - elapsedSec);
  if (limitSec < 60) return `${Math.round(left)} / ${limitSec} s übrig`;
  return `${fmtDuration(left)} / ${fmtDuration(limitSec)} übrig`;
}
