// Tages-Challenges der Routenjagd: jeden Tag 3 andere Spielarten (für alle gleich) plus „Bezirk des Tages“.
// Eine aktive Challenge legt ALLE Einstellungen fest (eigene Haltestellen-Arten, Entfernung, Uhrzeit, Netz …) –
// was gerade in der Lobby eingestellt ist, spielt keine Rolle. Beenden → wieder Standard.
// Welche Challenges an welchem Tag kommen, steht in einem vorberechneten Plan (buildSchedule, siehe unten).
import type { GameSettings } from './types.ts';
import { NET_MODES, SLOT_DAYTYPE, SLOT_TIME, TIME_SLOTS, isNightSlot } from './rules.ts';

/** was es in diesem Spiel gibt (Uhrzeiten stellt die Admin-Seite ein) */
export interface ChallengeContext {
  /** Uhrzeit zwischen 0 und 5 Uhr (id, „02:00“) */
  night: { id: string; time: string } | null;
  /** Sonntag tagsüber */
  sunday?: { id: string; time: string } | null;
  /** Netz „Aktuell“ eingeschaltet */
  current?: boolean;
  /** Adressen vorhanden */
  addresses?: boolean;
  /** Gewässer-Daten vorhanden („Ab ins Wasser“) */
  water?: boolean;
  /** Netzplan „Zielnetz 2040“ vorhanden */
  future?: boolean;
  /** Brücken-Daten vorhanden („Brückenkenner“) */
  bridges?: boolean;
}

/** was es gibt – aus den Uhrzeiten/Netzen der Admin-Seite (Server und Browser rechnen gleich) */
export function challengeContext(addresses: boolean, water: boolean, bridges = true): ChallengeContext {
  const hhmm = (id: string) => SLOT_TIME[id].map((n) => String(n).padStart(2, '0')).join(':');
  const night = TIME_SLOTS.find((t) => isNightSlot(t.id));
  const sunday = TIME_SLOTS.find((t) => SLOT_DAYTYPE[t.id] === 'su' && !isNightSlot(t.id));
  const at = (t: { id: string } | undefined) => (t ? { id: t.id, time: hhmm(t.id) } : null);
  return { night: at(night), sunday: at(sunday), current: NET_MODES.some((m) => m.id === 'current'), addresses, water, bridges, future: NET_MODES.some((m) => m.id === FUTURE_NET) };
}

/** normale Spielarten (Tempo, Netz-Regeln) und besondere (eigene Aufgaben, eigene Karte) – je Tag von beidem */
export type ChallengeKind = 'normal' | 'special';

export interface Challenge {
  id: string;
  icon: string;
  title: string;
  text: string;
  /** alle Einstellungen der Challenge (inkl. Standard-Rundenzahl) */
  settings: Partial<GameSettings>;
  /** wählbare Rundenzahlen – ausgelegt auf etwa 5 Minuten Spiel */
  roundOptions: number[];
  /** „geschafft“ (Medaille): so viele Routenpunkte in einer Runde */
  done: number;
  kind: ChallengeKind;
}

interface ChallengeDef {
  id: string;
  icon: string;
  title: string;
  kind: ChallengeKind;
  text: (c: ChallengeContext) => string;
  /** Abweichungen von BASE – Haltestellen-Arten, Entfernung und Umstiege sind je Challenge gewählt */
  settings: (c: ChallengeContext) => Partial<GameSettings>;
  /** Standard-Rundenzahl (≈ 5 Minuten: halbwegs leicht 2, schwer 1, Sprints 3+) und Auswahl (immer bis 5) */
  rounds: number;
  roundOptions: number[];
  done?: number;
  /** zu ähnlich: nie am selben Tag, möglichst nicht am Tag davor/danach (gilt in beide Richtungen) */
  avoid?: string[];
  /** nur, wenn es das im Spiel gibt */
  needs?: (c: ChallengeContext) => boolean;
}

const STEPHANSPLATZ = { lat: 48.2085, lon: 16.3731 };
/** Netzplan der Challenge „Zielnetz 2040“ (server/ziel2040.ts) */
export const FUTURE_NET = 'plan:ziel2040' as const;
/** neue oder geänderte Linien im Zielnetz 2040 (Karte „Zielnetz einblenden“) */
export const FUTURE_LINES = ['U5', 'U2', 'S45', 'S80', 'S70', 'S60', 'S1', 'S2', 'S3', 'S4', 'VK', '15', '25', '27', '12', '29', '33', 'GE', '21A', '10', 'O', '60'];
const fixed = (text: string, settings: Partial<GameSettings>) => ({ text: () => text, settings: () => settings });
const SPRINT = [2, 3, 5];
const EASY = [1, 2, 3, 5];
const HARD = [1, 2, 3, 5];

/**
 * Grundeinstellungen jeder Challenge – unabhängig von den Standard-Einstellungen und dem, was in der Lobby gerade
 * eingestellt ist. Haltestellen: alle U- und S-Bahn-Stationen + wichtige Bim-Haltestellen, 3–12 km, mind. 1 Umstieg.
 */
export const CHALLENGE_BASE: Partial<GameSettings> = {
  slot: 'wd12',
  network: 'regular',
  stations: ['U', 'S', 'Tkey'],
  distance: 'medium',
  minTransfers: 1,
  focus: null,
  districts: null,
  roundTimeLimitSec: 240,
  locate: false,
  countWait: true,
  avgWait: true,
  goal: 'fastest',
  xtreme: 'off',
  restrictions: 'never',
  tips: 'cheap',
  endpoints: 'stations',
  variant: 'none',
  task: 'normal',
  start: null,
  onlyRunning: true,
  scooter: false,
};

/**
 * Katalog. Haltestellen-Arten je Challenge so, dass es nicht zu leicht und nicht zu schwer ist (z.B. Busfahrer an
 * Bus-Knoten, S-Bahn-Fan an S-Bahn-Stationen, Insider ohne U-Bahn-Stationen). Jede ist auf etwa 5 Minuten ausgelegt.
 */
export const CHALLENGES: ChallengeDef[] = [
  // ---- Tempo
  { id: 'blitz', icon: '⚡', title: 'Blitzrunde', kind: 'normal', ...fixed('Leichte Strecken mit je nur 1 Minute', { stations: ['Ukey', 'Skey'], minTransfers: 0, roundTimeLimitSec: 60 }), rounds: 3, roundOptions: SPRINT, avoid: ['thriller'] },
  { id: 'thriller', icon: '⏱️', title: 'Sekundenkrimi', kind: 'normal', ...fixed('Je 40 Sekunden – Bauchgefühl statt Nachdenken', { stations: ['Ukey', 'Skey'], distance: 'short', minTransfers: 0, roundTimeLimitSec: 40 }), rounds: 4, roundOptions: [3, 4, 5, 7] },
  { id: 'pro', icon: '🏆', title: 'Profi-Sprint', kind: 'normal', ...fixed('Profi-Strecken (lang, alle Haltestellen) mit 3 Minuten', { stations: ['U', 'S', 'T', 'all'], distance: 'long', minTransfers: 2, roundTimeLimitSec: 180 }), rounds: 1, roundOptions: HARD, done: 900, avoid: ['outskirts'] },
  // ---- Netz-Regeln (je Linie)
  { id: 'no-u', icon: '🚫', title: 'Ohne U-Bahn', kind: 'normal', ...fixed('Ans Ziel mit Bim, Bus und S-Bahn – die U-Bahn bleibt heute im Depot', { variant: 'noU' }), rounds: 2, roundOptions: EASY, avoid: ['insider', 'sunny', 'ring-round'] },
  { id: 'tram', icon: '🚋', title: 'Bim-Tour', kind: 'normal', ...fixed('Nur mit der Bim – Start und Ziel an Bim-Stationen', { stations: ['T'], distance: 'short', minTransfers: 0, variant: 'tram' }), rounds: 2, roundOptions: EASY, avoid: ['tram-hop', 'ring-round'] },
  {
    id: 'insider',
    icon: '🕵️',
    title: 'Insider',
    kind: 'normal',
    ...fixed('Verboten: U-Bahn und die bekannten S-Bahnen (S1–S4, S7, S45, S80). Erlaubt: Bim, Bus, S40, S50, S60 …', { stations: ['S', 'Tkey', 'hub'], variant: 'insider' }),
    rounds: 1,
    roundOptions: HARD,
    done: 900,
    avoid: ['ring-round'],
  },
  { id: 'direct', icon: '1️⃣', title: 'Direkt-Profi', kind: 'normal', ...fixed('Höchstens 1 Umstieg – die beste Zweier-Kombination finden', { variant: 'one' }), rounds: 2, roundOptions: EASY, avoid: ['foot-bus'] },
  { id: 'transfers', icon: '🔀', title: 'Umsteige-Profi', kind: 'normal', ...fixed('Mindestens 2-mal umsteigen – kürzer geht nicht', { minTransfers: 0, variant: 'min2Transfers' }), rounds: 1, roundOptions: HARD },
  { id: 'obstacles', icon: '⛔', title: 'Hindernislauf', kind: 'normal', ...fixed('Jede Runde eine andere Hürde: gesperrte Linie, ohne Bus, max. 1 Umstieg …', { restrictions: 'always' }), rounds: 2, roundOptions: EASY },
  { id: 'bus-trip', icon: '🚐', title: 'Busreise', kind: 'normal', ...fixed('Nur Busse – kurze Strecken mit 1–2 Umstiegen', { stations: ['hub'], distance: 'short', variant: 'busOnly' }), rounds: 2, roundOptions: EASY, avoid: ['bus-driver'] },
  {
    id: 'foot-bus',
    icon: '🚶',
    title: 'Fußbus',
    kind: 'special',
    ...fixed('Der Fußbus fährt immer: genau eine Linie, den Rest gehst du. Welche bringt dich insgesamt am schnellsten hin?', { distance: 'short', minTransfers: 0, variant: 'oneLeg' }),
    rounds: 2,
    roundOptions: HARD,
  },
  {
    id: 'sunny',
    icon: '☀️',
    title: 'Sonnenschein',
    kind: 'special',
    ...fixed('Nichts Unterirdisches: keine U3, keine U-Bahn-Tunnel, keine S-Bahn-Stammstrecke (Praterstern–Hauptbahnhof), kein 18er am Hauptbahnhof', { variant: 'sunny' }),
    rounds: 2,
    roundOptions: HARD,
    done: 900,
  },
  {
    id: 'ring-road',
    icon: '🍩',
    title: 'Innenstadt umfahren',
    kind: 'special',
    ...fixed('Quer durch Wien, aber keine Station in den Bezirken 1, 4–9 – auch nicht durchfahren', { distance: 'long', variant: 'avoidInner', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
    done: 900,
    avoid: ['patchwork'],
  },
  {
    id: 'patchwork',
    icon: '🧩',
    title: 'Fleckerlteppich',
    kind: 'special',
    ...fixed('Ein paar Bezirke sind rot und gesperrt – genau die, die du brauchen könntest. Finde den Weg drumherum', { distance: 'long', minTransfers: 0, variant: 'avoidDistricts' }),
    rounds: 2,
    roundOptions: EASY,
  },
  {
    id: 'lockdown',
    icon: '🟥',
    title: 'Sperrzone XXL',
    kind: 'special',
    ...fixed('Fast halb Wien ist gesperrt (rot schraffiert) – dort nicht ein-, aus- oder durchfahren. Finde den Weg durch die Lücken', { distance: 'long', minTransfers: 0, variant: 'avoidMany', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
    avoid: ['patchwork'],
  },
  {
    id: 'district-tour',
    icon: '🗺️',
    title: 'Bezirkstour',
    kind: 'special',
    ...fixed('Ein paar Bezirke sind grün markiert – deine Route muss durch jeden davon führen (einsteigen, umsteigen oder durchfahren). Die Reihenfolge ist egal', { distance: 'long', minTransfers: 0, variant: 'visitDistricts', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
    avoid: ['visit3', 'lockdown'],
  },
  {
    id: 'scooter',
    icon: '🛴',
    title: 'E-Scooter',
    kind: 'special',
    ...fixed('Du hast einen schnellen E-Scooter: jeder Weg zu und zwischen den Haltestellen mit 20 km/h – nur bei U- und S-Bahn kosten die Treppen 30 Sekunden. Wann lohnen sich die Öffis überhaupt?', { stations: ['U', 'S'], distance: 'xlong', minTransfers: 0, scooter: true, roundTimeLimitSec: 300 }),
    rounds: 2,
    roundOptions: EASY,
    avoid: ['foot-bus'],
  },
  {
    id: 'heli',
    icon: '🚁',
    title: 'Hubschrauber',
    kind: 'special',
    ...fixed('Drei Hubschrauber-Linien stehen bereit (rosa auf der Karte) – „H1“ eintippen wie eine Linie, die Flugzeit steht am Strich. Einer davon bringt dich schneller ans Ziel. Welcher?', { distance: 'long', minTransfers: 0, task: 'heli', tips: 'off', roundTimeLimitSec: 300 }),
    rounds: 2,
    roundOptions: EASY,
    avoid: ['scooter'],
  },
  {
    id: 'bridges',
    icon: '🌉',
    title: 'Brückenkenner',
    kind: 'special',
    ...fixed('Über Donau, Donaukanal, Wienfluss und Alte Donau: Überquere mehr Brücken als die schnellste Verbindung – so schnell wie möglich', { distance: 'long', minTransfers: 0, variant: 'minBridges', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
    avoid: ['water'],
    needs: (c) => c.bridges !== false,
  },
  {
    id: 'future',
    icon: '🔮',
    title: 'Zielnetz 2040',
    kind: 'special',
    ...fixed('Wien um 2040: U5, U2 zum Wienerberg, S-Bahn-Ring, S45 und S80 im dichten Takt, neue Bim-Linien. „Zielnetz einblenden“ zeigt, was neu ist – finde die schnellste Route im Netz der Zukunft', { network: FUTURE_NET, minTransfers: 0, task: 'future', roundTimeLimitSec: 300 }),
    rounds: 2,
    roundOptions: EASY,
    avoid: ['current'],
    needs: (c) => !!c.future,
  },
  // ---- Routen-Regeln (ganze Route)
  { id: 's-fan', icon: '🚆', title: 'S-Bahn-Fan', kind: 'normal', ...fixed('Start und Ziel an der S-Bahn – und mindestens eine S-Bahn-Fahrt', { stations: ['S'], variant: 'needS' }), rounds: 2, roundOptions: EASY, avoid: ['umland'] },
  { id: 'bus-driver', icon: '🚌', title: 'Busfahrer', kind: 'normal', ...fixed('Strecken, auf denen der Bus König ist – mindestens eine Bus-Fahrt', { stations: ['hub'], variant: 'needBus' }), rounds: 2, roundOptions: EASY },
  { id: 'one-u', icon: '☝️', title: 'Eine U reicht', kind: 'normal', ...fixed('Höchstens eine U-Bahn-Fahrt – von U zu U umsteigen ist tabu', { stations: ['U'], variant: 'maxOneU' }), rounds: 2, roundOptions: EASY },
  { id: 'mix', icon: '🎨', title: 'Bunt gemischt', kind: 'normal', ...fixed('Mindestens 3 verschiedene Verkehrsmittel (U-Bahn, S-Bahn, Bim, Bus)', { stations: ['U', 'S', 'Tkey', 'hub'], variant: 'mixModes' }), rounds: 2, roundOptions: HARD, avoid: ['no-same'] },
  { id: 'no-same', icon: '🔁', title: 'Nie zweimal dasselbe', kind: 'normal', ...fixed('Nach der U-Bahn keine U-Bahn, nach der Bim keine Bim – immer wechseln', { variant: 'noSameMode' }), rounds: 2, roundOptions: HARD },
  { id: 'tram-hop', icon: '🦘', title: 'Bim-Hüpfer', kind: 'normal', ...fixed('Erste und letzte Fahrt mit der Bim – Start und Ziel an der Bim', { stations: ['T'], variant: 'tramEnds' }), rounds: 2, roundOptions: HARD },
  { id: 'must-line', icon: '📌', title: 'Pflicht-Linie', kind: 'special', ...fixed('Eine bestimmte Linie muss dabei sein – sie liegt dir garantiert im Weg', { variant: 'mustLine' }), rounds: 2, roundOptions: HARD, avoid: ['any-line'] },
  { id: 'any-line', icon: '🎲', title: 'Eine von drei', kind: 'special', ...fixed('Eine von drei lästigen Linien muss dabei sein – welche kostet am wenigsten Umweg?', { variant: 'anyLine' }), rounds: 1, roundOptions: HARD },
  // ---- Aufgaben
  { id: 'choose3', icon: '🎯', title: 'Drei Ziele', kind: 'special', ...fixed('Drei Ziele – du musst nur zu einem. Welches erreichst du am schnellsten?', { minTransfers: 0, task: 'choose3', tips: 'off' }), rounds: 2, roundOptions: HARD, avoid: ['visit3'] },
  { id: 'visit3', icon: '📍', title: 'Drei Punkte', kind: 'special', ...fixed('Fahr bei allen drei Punkten vorbei – die Reihenfolge ist egal', { stations: ['U', 'S'], minTransfers: 0, task: 'visit3', tips: 'off', roundTimeLimitSec: 300 }), rounds: 1, roundOptions: HARD, done: 900 },
  {
    id: 'water',
    icon: '🏊',
    title: 'Ab ins Wasser',
    kind: 'special',
    ...fixed('Zum nächsten Wasser – Donau, Donaukanal, Wienfluss, Alte Donau, Liesing oder ein Bad. Wo steigst du aus?', { minTransfers: 0, task: 'water', tips: 'off' }),
    rounds: 2,
    roundOptions: EASY,
    avoid: ['bath'],
    needs: (c) => !!c.water,
  },
  {
    id: 'bath',
    icon: '🩱',
    title: 'Ab ins Bad',
    kind: 'special',
    ...fixed('Zum nächsten Bad – Strandbad, Freibad oder Hallenbad (blau auf der Karte). Flüsse zählen nicht', { minTransfers: 0, task: 'bath', tips: 'off' }),
    rounds: 2,
    roundOptions: EASY,
    needs: (c) => !!c.water,
  },
  // ---- Ort & Zeit
  {
    id: 'umland',
    icon: '🚆',
    title: 'Aus dem Umland',
    kind: 'special',
    ...fixed('Du startest in einem Ort in Niederösterreich – nimm den richtigen Zug nach Wien und steig geschickt um', { minTransfers: 0, variant: 'umland' }),
    rounds: 2,
    roundOptions: EASY,
  },
  {
    id: 'ring-round',
    icon: '🎡',
    title: 'Ring-Runde',
    kind: 'normal',
    ...fixed('Kurze Strecken rund um die Innere Stadt – ohne U- und S-Bahn, nur mit Bim und Bus rund um den Ring', { stations: ['T', 'hub'], distance: 'short', minTransfers: 0, variant: 'noRail', focus: { ...STEPHANSPLATZ, radiusM: 2500, share: 0.9 } }),
    rounds: 2,
    roundOptions: EASY,
  },
  { id: 'doors', icon: '🏠', title: 'Tür zu Tür', kind: 'normal', ...fixed('Start und Ziel sind echte Adressen – erst zur richtigen Haltestelle gehen', { endpoints: 'addresses' }), rounds: 2, roundOptions: EASY, avoid: ['dickmacks'], needs: (c) => c.addresses !== false },
  { id: 'outskirts', icon: '🌄', title: 'Stadtrand-Tour', kind: 'normal', ...fixed('Von Rand zu Rand: 12 bis 25 Kilometer quer durch Wien', { distance: 'xlong', roundTimeLimitSec: 300 }), rounds: 1, roundOptions: HARD },
  { id: 'current', icon: '🚧', title: 'Aktuelles Netz', kind: 'normal', ...fixed('Mit allen Baustellen, Sperren und Ersatzverkehren von heute', { network: 'current' }), rounds: 2, roundOptions: EASY, needs: (c) => !!c.current },
  {
    id: 'dickmacks',
    icon: '🍻',
    title: 'Dickmacks Donnerstag',
    kind: 'special',
    ...fixed('Unter der Woche, 01:30: vom Schwedenplatz heim zu einer zufälligen Adresse – keine U-Bahn mehr, nur Nightline', { start: 'Schwedenplatz', endpoints: 'addresses', slot: 'wd-night', distance: 'medium', onlyRunning: true }),
    rounds: 2,
    roundOptions: HARD,
    avoid: ['night'],
    needs: (c) => c.addresses !== false,
  },
  {
    id: 'night',
    icon: '🌙',
    title: 'Nachtschicht',
    kind: 'normal',
    text: (c) => `Unterwegs um ${c.night!.time} am Wochenende – Nachtbus und Nacht-U-Bahn`,
    settings: (c) => ({ slot: c.night!.id, onlyRunning: true }),
    rounds: 2,
    roundOptions: HARD,
    needs: (c) => !!c.night,
  },
  {
    id: 'sunday',
    icon: '🧺',
    title: 'Sonntagsausflug',
    kind: 'normal',
    text: (c) => `Sonntag, ${c.sunday!.time} – weniger Fahrten, längere Wartezeiten`,
    settings: (c) => ({ slot: c.sunday!.id }),
    rounds: 2,
    roundOptions: EASY,
    needs: (c) => !!c.sunday,
  },
];

const make = (d: ChallengeDef, c: ChallengeContext): Challenge => ({
  id: d.id,
  icon: d.icon,
  title: d.title,
  text: d.text(c),
  settings: { ...CHALLENGE_BASE, ...d.settings(c), rounds: d.rounds },
  roundOptions: d.roundOptions,
  done: d.done ?? 1000,
  kind: d.kind,
});

const pool = (c: ChallengeContext) => CHALLENGES.filter((d) => !d.needs || d.needs(c));

/** alle Challenges (Testseite, Medaillen) */
export const allChallenges = (c: ChallengeContext) => pool(c).map((d) => make(d, c));

/** zu ähnlich? (Blacklist gilt in beide Richtungen) */
export function similar(a: string, b: string): boolean {
  const da = CHALLENGES.find((d) => d.id === a);
  const db = CHALLENGES.find((d) => d.id === b);
  return !!(da?.avoid?.includes(b) || db?.avoid?.includes(a));
}

// ---------------------------------------------------------------- Bezirk des Tages

/**
 * Bezirke des Tages: große Bezirke allein, kleine innere paarweise (sonst gibt es kaum Strecken, auf denen man
 * mehr als eine U-Bahn-Station lernt). 18 Gruppen – der Plan (180 Tage) ist ein Vielfaches davon.
 */
export const DISTRICT_GROUPS: number[][] = [[1], [2, 20], [3], [4, 5], [6, 7], [8, 9], [10], [11], [12], [13], [14], [15, 16], [17], [18], [19], [21], [22], [23]];

/** an Tagen mit diesem Bezirk nicht: die Ring-Runde spielt ohnehin nur im 1. */
const DISTRICT_AVOID: Record<string, string[]> = { '1': ['ring-round'] };

export const districtGroupId = (g: number[]) => `district-${g.join('-')}`;

/** Bezirk des Tages als Challenge: Start und Ziel in diesen Bezirken, Bim und Busse zählen, kurze Wege */
export function districtChallenge(group: number[], names: string[]): Challenge {
  const label = names.join(' & ');
  const nums = group.length > 1 ? `${group.slice(0, -1).join('., ')}. und ${group.at(-1)}.` : `${group[0]}.`;
  return {
    id: districtGroupId(group),
    icon: '🏘️',
    title: `Bezirk des Tages: ${label}`,
    text: `Start und Ziel im ${nums} Bezirk – lerne die Verbindungen dort, Bim und Bus inklusive`,
    settings: { ...CHALLENGE_BASE, stations: ['U', 'S', 'T', 'bus'], distance: 'local', minTransfers: 0, districts: group, rounds: 2 },
    roundOptions: EASY,
    done: 1000,
    kind: 'normal',
  };
}

// ---------------------------------------------------------------- Plan: welche Challenges an welchem Tag

/** so viele Challenges aus der Rotation je Tag – dazu kommt immer der Bezirk des Tages (zusammen 4) */
export const DAILY_COUNT = 3;
/** nach so vielen Tagen wiederholt sich der Plan exakt (Vielfaches von 30 und von 18 Bezirksgruppen) */
export const SCHEDULE_DAYS = 180;
/** Beginn des Plans (Tag 0) */
const ROTATION_START = Math.round(Date.parse('2026-01-01T12:00:00Z') / 86_400_000);

export interface Schedule {
  /** Kennung der Challenge-Liste (ändert sich → Plan neu berechnen) */
  key: string;
  /** je Tag die 3 Challenge-IDs */
  days: string[][];
  /** je Tag die Bezirksgruppe (Index in DISTRICT_GROUPS) */
  districts: number[];
}

/** einfache, für alle gleiche Zufallszahl */
function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function shuffled<T>(list: T[], rnd: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Kennung: Challenges mit Kategorie und Blacklist – gleiche Liste → gleicher Plan */
export function scheduleKey(c: ChallengeContext): string {
  const items = pool(c).map((d) => `${d.id}:${d.kind}:${(d.avoid ?? []).join('+')}`);
  return `v1|${SCHEDULE_DAYS}|${DISTRICT_GROUPS.map((g) => g.join('-')).join(',')}|${items.join(',')}`;
}

/**
 * Plan für SCHEDULE_DAYS Tage berechnen (deterministisch: gleiche Challenges → gleicher Plan).
 * - gleich oft: jede Challenge sammelt täglich „Guthaben“ (3 / Anzahl); gewählt werden die mit dem meisten –
 *   so kommt jede in jedem Monat fast gleich oft und in fast gleichem Abstand dran (auch mit mehr Challenges)
 * - nie am selben Tag: zu ähnliche (Blacklist); möglichst auch nicht am Tag davor/danach
 * - je Tag mindestens eine normale und eine besondere (wenn es geht)
 * - wechselnde Gruppen: wer schon oft zusammen war, kommt seltener wieder zusammen
 * - Bezirk des Tages: alle Gruppen der Reihe nach (gemischt); am Tag mit dem 1. keine Ring-Runde
 * Gerechnet werden zwei Durchläufe; der zweite ist der Plan (eingeschwungen), danach wird die Nahtstelle
 * (letzter → erster Tag) repariert, damit sich der Plan nahtlos wiederholt.
 */
export function buildSchedule(c: ChallengeContext): Schedule {
  const key = scheduleKey(c);
  const defs = pool(c);
  const ids = defs.map((d) => d.id);
  const kind = new Map(defs.map((d) => [d.id, d.kind]));
  const rnd = seeded(key);
  const G = DISTRICT_GROUPS.length;
  // Bezirke: jede Runde alle Gruppen gemischt, nie zweimal hintereinander dieselbe
  const districts: number[] = [];
  while (districts.length < SCHEDULE_DAYS) {
    let order = shuffled([...Array(G).keys()], rnd);
    if (order[0] === districts.at(-1)) order = [...order.slice(1), order[0]];
    districts.push(...order);
  }
  districts.length = SCHEDULE_DAYS;
  const banOn = (g: number) => new Set(DISTRICT_GROUPS[g].flatMap((d) => DISTRICT_AVOID[d] ?? []));

  const n = ids.length;
  const perDay = Math.min(DAILY_COUNT, n);
  const rate = perDay / n;
  const credit = new Map(ids.map((id) => [id, rnd()]));
  const kindCredit = new Map<ChallengeKind, number>();
  const together = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const all: string[][] = [];
  for (let g = 0; g < 2 * SCHEDULE_DAYS; g++) {
    for (const id of ids) credit.set(id, credit.get(id)! + rate);
    const prev = all[g - 1] ?? [];
    const banned = banOn(districts[g % SCHEDULE_DAYS]);
    // Plätze je Kategorie: jede bekommt täglich Guthaben (ihr Anteil an allen); mindestens je eine, der Rest an die,
    // die am meisten gut hat – so bleibt das Verhältnis über den Monat stimmig
    const kinds = [...new Set(ids.map((id) => kind.get(id)!))];
    for (const k of kinds) kindCredit.set(k, (kindCredit.get(k) ?? 0) + (perDay * ids.filter((id) => kind.get(id) === k).length) / n);
    // mindestens eine je Kategorie – außer eine ist so selten, dass sie heute nicht dran ist (großes Ungleichgewicht)
    const quota = new Map(kinds.map((k) => [k, kinds.length > 1 && perDay > 1 && kindCredit.get(k)! >= 0.5 ? 1 : 0]));
    for (let left = perDay - [...quota.values()].reduce((a, b) => a + b, 0); left > 0; left--) {
      const k = [...kinds].sort((a, b) => kindCredit.get(b)! - quota.get(b)! - (kindCredit.get(a)! - quota.get(a)!))[0];
      quota.set(k, quota.get(k)! + 1);
    }
    // gestern dran → heute nicht (außer es gäbe sonst zu wenige)
    const ok = (id: string) => !banned.has(id) && !prev.includes(id);
    const cand = kinds.flatMap((k) => {
      const list = ids.filter((id) => kind.get(id) === k && ok(id));
      return list.sort((a, b) => credit.get(b)! - credit.get(a)!).slice(0, quota.get(k)! + 5);
    });
    let best: { pick: string[]; score: number } | null = null;
    const combos = (start: number, pick: string[]) => {
      if (pick.length === perDay) {
        if (kinds.some((k) => pick.filter((id) => kind.get(id) === k).length !== quota.get(k))) return;
        let score = pick.reduce((s, id) => s + credit.get(id)!, 0);
        for (const id of pick) for (const p of prev) if (similar(id, p)) score -= 0.3;
        for (let i = 0; i < pick.length; i++) for (let j = i + 1; j < pick.length; j++) score -= 0.03 * (together.get(pairKey(pick[i], pick[j])) ?? 0);
        score += rnd() * 0.05;
        if (!best || score > best.score) best = { pick: [...pick], score };
        return;
      }
      for (let i = start; i < cand.length; i++) {
        if (pick.some((p) => similar(p, cand[i]))) continue;
        pick.push(cand[i]);
        combos(i + 1, pick);
        pick.pop();
      }
    };
    combos(0, []);
    const pick = (best as { pick: string[] } | null)?.pick ?? cand.slice(0, perDay);
    for (const id of pick) credit.set(id, credit.get(id)! - 1);
    for (const id of pick) kindCredit.set(kind.get(id)!, kindCredit.get(kind.get(id)!)! - 1);
    for (let i = 0; i < pick.length; i++) for (let j = i + 1; j < pick.length; j++) together.set(pairKey(pick[i], pick[j]), (together.get(pairKey(pick[i], pick[j])) ?? 0) + 1);
    all.push(pick);
  }
  const days = all.slice(SCHEDULE_DAYS);
  smooth(days, districts, banOn, kind, rnd);
  return { key, days, districts };
}

/**
 * Glätten (ringförmig – der Plan wiederholt sich, auch letzter → erster Tag zählt): Challenges derselben Kategorie
 * zwischen zwei Tagen tauschen, wenn danach die Abstände gleichmäßiger sind (Summe der quadrierten Abweichungen vom
 * idealen Abstand). Getauscht wird nur, wenn alle Regeln halten: kein Doppel, nichts Ähnliches am selben Tag, nicht
 * an zwei Tagen hintereinander, nichts Ähnliches am Nachbartag, keine Ring-Runde am Tag des 1. Bezirks.
 */
function smooth(days: string[][], districts: number[], banOn: (g: number) => Set<string>, kind: Map<string, ChallengeKind>, rnd: () => number) {
  const D = days.length;
  const at = (i: number) => days[((i % D) + D) % D];
  const pos = new Map<string, number[]>();
  days.forEach((d, i) => d.forEach((id) => pos.set(id, [...(pos.get(id) ?? []), i])));
  const cost = (list: number[]) => {
    const ideal = D / list.length;
    const sorted = [...list].sort((a, b) => a - b);
    const n = sorted.length;
    const gaps = sorted.map((x, k) => (k + 1 < n ? sorted[k + 1] : sorted[0] + D) - x);
    let c = 0;
    for (let k = 0; k < n; k++) {
      const gap = gaps[k];
      // große Lücken (ein Monat fast ohne) und sehr kurze kosten extra
      c += (gap - ideal) ** 2 + Math.max(0, Math.abs(gap - ideal) - 2) ** 4 + (gap < 3 ? 50 : 0);
      // ein 30-Tage-Fenster mit nur einem Mal (zwei Lücken zusammen > 30) bzw. viermal (drei Lücken ≤ 29) – nur, wenn
      // im Schnitt 2–3 Mal je Monat drin sind
      if (ideal > 9 && ideal < 15) {
        if (gap + gaps[(k + 1) % n] > 30) c += 60;
        if (gap + gaps[(k + 1) % n] + gaps[(k + 2) % n] <= 29) c += 60;
      }
    }
    return c;
  };
  const fits = (id: string, i: number, without: string) => {
    const d = at(i).filter((x) => x !== without);
    if (d.includes(id) || d.some((x) => similar(x, id))) return false;
    if (banOn(districts[((i % D) + D) % D]).has(id)) return false;
    return ![at(i - 1), at(i + 1)].some((n) => n.some((x) => x === id || similar(x, id)));
  };
  for (let round = 0; round < 150000; round++) {
    const i = Math.floor(rnd() * D);
    const j = (i + 2 + Math.floor(rnd() * 20)) % D;
    const a = at(i)[Math.floor(rnd() * at(i).length)];
    const b = at(j)[Math.floor(rnd() * at(j).length)];
    if (a === b || kind.get(a) !== kind.get(b)) continue;
    if (!fits(b, i, a) || !fits(a, j, b)) continue;
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    const na = pa.map((x) => (x === i ? j : x));
    const nb = pb.map((x) => (x === j ? i : x));
    if (cost(na) + cost(nb) >= cost(pa) + cost(pb)) continue;
    at(i)[at(i).indexOf(a)] = b;
    at(j)[at(j).indexOf(b)] = a;
    pos.set(a, na);
    pos.set(b, nb);
  }
}

const dayIndex = (day: string) => Math.max(0, Math.round(Date.parse(`${day}T12:00:00Z`) / 86_400_000) - ROTATION_START);

/** Plan je Liste nur einmal rechnen (der Server legt ihn zusätzlich als Datei ab, siehe server/challengeSchedule.ts) */
const plans = new Map<string, Schedule>();

export function scheduleFor(c: ChallengeContext, cached?: Schedule | null): Schedule {
  const key = scheduleKey(c);
  if (cached?.key === key) plans.set(key, cached);
  let s = plans.get(key);
  if (!s) plans.set(key, (s = buildSchedule(c)));
  return s;
}

/** Bezirksgruppe des Tages (Index in DISTRICT_GROUPS) */
export function districtOfDay(day: string, c: ChallengeContext, cached?: Schedule | null): number {
  const s = scheduleFor(c, cached);
  return s.districts[dayIndex(day) % s.districts.length];
}

/**
 * Die Challenges des Tages – für alle gleich: 3 aus dem Plan + der Bezirk des Tages, zufällig gemischt (die erste
 * ist der Vorschlag).
 */
export function dailyChallenges(day: string, c: ChallengeContext, district?: Challenge, cached?: Schedule | null): Challenge[] {
  const s = scheduleFor(c, cached);
  const ids = s.days[dayIndex(day) % s.days.length];
  const today = ids.map((id) => make(CHALLENGES.find((d) => d.id === id)!, c));
  return shuffled(district ? [...today, district] : today, seeded(day));
}
