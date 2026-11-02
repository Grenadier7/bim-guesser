// Tages-Challenges der Routenjagd: jeden Tag 3 andere Spielarten (für alle gleich) plus „Bezirk des Tages“.
// Eine aktive Challenge legt alle Einstellungen fest (Standard + ihre Änderungen); beenden → wieder Standard.
import type { GameSettings } from './types.ts';

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
}

export interface Challenge {
  id: string;
  icon: string;
  title: string;
  text: string;
  /** Änderungen gegenüber den Standard-Einstellungen (inkl. Standard-Rundenzahl) */
  settings: Partial<GameSettings>;
  /** wählbare Rundenzahlen – ausgelegt auf etwa 5 Minuten Spiel */
  roundOptions: number[];
  /** „geschafft“ (Medaille): so viele Routenpunkte in einer Runde */
  done: number;
}

interface ChallengeDef {
  id: string;
  icon: string;
  title: string;
  text: (c: ChallengeContext) => string;
  settings: (c: ChallengeContext) => Partial<GameSettings>;
  /** Standard-Rundenzahl (≈ 5 Minuten: leicht 2, schwer 1, Sprints 3+) und Auswahl */
  rounds: number;
  roundOptions: number[];
  done?: number;
  /** nur, wenn es das im Spiel gibt */
  needs?: (c: ChallengeContext) => boolean;
}

const STEPHANSPLATZ = { lat: 48.2085, lon: 16.3731 };
const fixed = (text: string, settings: Partial<GameSettings>) => ({ text: () => text, settings: () => settings });
const SPRINT = [2, 3, 5];
const EASY = [1, 2, 3, 5];
const HARD = [1, 2, 3];

/**
 * Katalog – nur stimmige Kombinationen. Jede Challenge ist auf etwa 5 Minuten ausgelegt (Standard-Rundenzahl).
 * Gruppen: Tempo, Netz-Regeln (je Linie), Routen-Regeln (ganze Route), Aufgaben (Ziele/Punkte/Wasser), Ort & Zeit.
 */
export const CHALLENGES: ChallengeDef[] = [
  // ---- Tempo
  { id: 'blitz', icon: '⚡', title: 'Blitzrunde', ...fixed('Leichte Strecken mit je nur 1 Minute', { difficulty: 'easy', roundTimeLimitSec: 60 }), rounds: 3, roundOptions: SPRINT },
  { id: 'thriller', icon: '⏱️', title: 'Sekundenkrimi', ...fixed('Je 40 Sekunden – Bauchgefühl statt Nachdenken', { difficulty: 'easy', roundTimeLimitSec: 40 }), rounds: 4, roundOptions: [3, 4, 5, 7] },
  { id: 'pro', icon: '🏆', title: 'Profi-Sprint', ...fixed('Profi-Strecken (lang, alle Haltestellen) mit 3 Minuten', { difficulty: 'expert', roundTimeLimitSec: 180 }), rounds: 1, roundOptions: HARD, done: 900 },
  // ---- Netz-Regeln (je Linie)
  { id: 'no-u', icon: '🚫', title: 'Ohne U-Bahn', ...fixed('Ans Ziel mit Bim, Bus und S-Bahn – die U-Bahn bleibt heute im Depot', { difficulty: 'medium', variant: 'noU' }), rounds: 2, roundOptions: EASY },
  { id: 'tram', icon: '🚋', title: 'Bim-Tour', ...fixed('Nur mit der Bim – Start und Ziel an Bim-Stationen', { variant: 'tram', roundTimeLimitSec: 300 }), rounds: 2, roundOptions: EASY },
  {
    id: 'insider',
    icon: '🕵️',
    title: 'Insider',
    ...fixed('Verboten: U-Bahn und die bekannten S-Bahnen (S1–S4, S7, S45, S80). Erlaubt: Bim, Bus, S40, S50, S60 …', { difficulty: 'medium', variant: 'insider' }),
    rounds: 1,
    roundOptions: HARD,
    done: 900,
  },
  { id: 'direct', icon: '1️⃣', title: 'Direkt-Profi', ...fixed('Höchstens 1 Umstieg – die beste Zweier-Kombination finden', { difficulty: 'medium', variant: 'one' }), rounds: 2, roundOptions: EASY },
  { id: 'transfers', icon: '🔀', title: 'Umsteige-Profi', ...fixed('Mindestens 2-mal umsteigen – kürzer geht nicht', { difficulty: 'hard', variant: 'min2Transfers' }), rounds: 1, roundOptions: HARD },
  { id: 'obstacles', icon: '⛔', title: 'Hindernislauf', ...fixed('Jede Runde eine andere Hürde: gesperrte Linie, ohne Bus, max. 1 Umstieg …', { difficulty: 'medium', restrictions: 'always' }), rounds: 2, roundOptions: EASY },
  { id: 'bus-trip', icon: '🚐', title: 'Busreise', ...fixed('Nur Busse – kurze Strecken mit 1–2 Umstiegen', { stations: ['hub'], distance: 'short', minTransfers: 1, variant: 'busOnly', roundTimeLimitSec: 300 }), rounds: 2, roundOptions: EASY },
  {
    id: 'foot-bus',
    icon: '🚶',
    title: 'Fußbus',
    ...fixed('Der Fußbus fährt immer: genau eine Linie, den Rest gehst du. Welche bringt dich insgesamt am schnellsten hin?', { stations: ['U', 'S', 'Tkey'], distance: 'short', minTransfers: 0, variant: 'oneLeg', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
  },
  {
    id: 'sunny',
    icon: '☀️',
    title: 'Sonnenschein',
    ...fixed('Nichts Unterirdisches: keine U3, keine U-Bahn-Tunnel, keine S-Bahn-Stammstrecke, kein 18er am Hauptbahnhof', { difficulty: 'medium', variant: 'sunny', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
    done: 900,
  },
  {
    id: 'ring-road',
    icon: '🍩',
    title: 'Innenstadt umfahren',
    ...fixed('Quer durch Wien, aber keine Station in den Bezirken 1, 4–9 – auch nicht durchfahren', { stations: ['U', 'S', 'Tkey'], distance: 'long', minTransfers: 1, variant: 'avoidInner', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
    done: 900,
  },
  // ---- Routen-Regeln (ganze Route)
  { id: 's-fan', icon: '🚆', title: 'S-Bahn-Fan', ...fixed('Start und Ziel an der S-Bahn – und mindestens eine S-Bahn-Fahrt', { stations: ['S'], variant: 'needS' }), rounds: 2, roundOptions: EASY },
  { id: 'bus-driver', icon: '🚌', title: 'Busfahrer', ...fixed('Strecken, auf denen der Bus König ist – mindestens eine Bus-Fahrt', { stations: ['hub'], distance: 'medium', minTransfers: 1, variant: 'needBus' }), rounds: 2, roundOptions: EASY },
  { id: 'one-u', icon: '☝️', title: 'Eine U reicht', ...fixed('Höchstens eine U-Bahn-Fahrt – von U zu U umsteigen ist tabu', { difficulty: 'hard', variant: 'maxOneU' }), rounds: 2, roundOptions: EASY },
  { id: 'mix', icon: '🎨', title: 'Bunt gemischt', ...fixed('Mindestens 3 verschiedene Verkehrsmittel (U-Bahn, S-Bahn, Bim, Bus)', { difficulty: 'hard', variant: 'mixModes', roundTimeLimitSec: 300 }), rounds: 1, roundOptions: HARD },
  { id: 'no-same', icon: '🔁', title: 'Nie zweimal dasselbe', ...fixed('Nach der U-Bahn keine U-Bahn, nach der Bim keine Bim – immer wechseln', { difficulty: 'hard', variant: 'noSameMode' }), rounds: 1, roundOptions: HARD },
  { id: 'tram-hop', icon: '🦘', title: 'Bim-Hüpfer', ...fixed('Erste und letzte Fahrt mit der Bim – Start und Ziel an der Bim', { stations: ['T'], variant: 'tramEnds', roundTimeLimitSec: 300 }), rounds: 1, roundOptions: HARD },
  { id: 'must-line', icon: '📌', title: 'Pflicht-Linie', ...fixed('Eine bestimmte Linie muss dabei sein – sie liegt dir garantiert im Weg', { difficulty: 'medium', variant: 'mustLine', roundTimeLimitSec: 300 }), rounds: 1, roundOptions: HARD },
  { id: 'any-line', icon: '🎲', title: 'Eine von drei', ...fixed('Eine von drei Linien muss dabei sein – welche ist die klügste?', { difficulty: 'medium', variant: 'anyLine', roundTimeLimitSec: 300 }), rounds: 1, roundOptions: HARD },
  // ---- Aufgaben
  { id: 'choose3', icon: '🎯', title: 'Drei Ziele', ...fixed('Drei Ziele – du musst nur zu einem. Welches erreichst du am schnellsten?', { difficulty: 'medium', task: 'choose3', tips: 'off', roundTimeLimitSec: 300 }), rounds: 1, roundOptions: HARD },
  { id: 'visit3', icon: '📍', title: 'Drei Punkte', ...fixed('Fahr bei allen drei Punkten vorbei – die Reihenfolge ist egal', { difficulty: 'medium', task: 'visit3', tips: 'off', roundTimeLimitSec: 420 }), rounds: 1, roundOptions: [1, 2], done: 900 },
  {
    id: 'water',
    icon: '🏊',
    title: 'Ab ins Wasser',
    ...fixed('Zum nächsten Wasser – Donau, Donaukanal, Wienfluss, Alte Donau oder ein Bad. Wo steigst du aus?', { difficulty: 'medium', task: 'water', tips: 'off', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
    needs: (c) => !!c.water,
  },
  // ---- Ort & Zeit
  { id: 'umland', icon: '🚆', title: 'Aus dem Umland', ...fixed('Du sitzt im Zug aus Niederösterreich – wo steigst du in Wien am besten um?', { stations: ['U', 'S', 'Tkey'], distance: 'medium', minTransfers: 1, variant: 'umland' }), rounds: 1, roundOptions: HARD },
  {
    id: 'ring-round',
    icon: '🎡',
    title: 'Ring-Runde',
    ...fixed('Kurze Strecken rund um die Innere Stadt – ohne U-Bahn, mit Bim und Bus rund um den Ring', { stations: ['Tkey', 'S'], distance: 'short', variant: 'noU', focus: { ...STEPHANSPLATZ, radiusM: 2500, share: 0.9 } }),
    rounds: 2,
    roundOptions: EASY,
  },
  { id: 'doors', icon: '🏠', title: 'Tür zu Tür', ...fixed('Start und Ziel sind echte Adressen – erst zur richtigen Haltestelle gehen', { endpoints: 'addresses' }), rounds: 2, roundOptions: EASY, needs: (c) => c.addresses !== false },
  { id: 'outskirts', icon: '🌄', title: 'Stadtrand-Tour', ...fixed('Von Rand zu Rand: 12 bis 25 Kilometer quer durch Wien', { stations: ['U', 'S', 'Tkey'], distance: 'xlong', minTransfers: 1, roundTimeLimitSec: 300 }), rounds: 1, roundOptions: HARD },
  { id: 'timetable', icon: '🧮', title: 'Fahrplan-Fuchs', ...fixed('Echte Abfahrten statt Durchschnitt – wer den Anschluss erwischt, gewinnt', { difficulty: 'medium', avgWait: false, countWait: true }), rounds: 2, roundOptions: EASY },
  { id: 'current', icon: '🚧', title: 'Aktuelles Netz', ...fixed('Mit allen Baustellen, Sperren und Ersatzverkehren von heute', { difficulty: 'medium', network: 'current' }), rounds: 2, roundOptions: EASY, needs: (c) => !!c.current },
  {
    id: 'dickmacks',
    icon: '🍔',
    title: 'Dickmacks Donnerstag',
    ...fixed('Unter der Woche, 01:30: vom Schwedenplatz heim zu einer zufälligen Adresse – keine U-Bahn mehr, nur Nightline', { start: 'Schwedenplatz', endpoints: 'addresses', slot: 'wd-night', distance: 'short', roundTimeLimitSec: 300 }),
    rounds: 1,
    roundOptions: HARD,
    needs: (c) => c.addresses !== false,
  },
  {
    id: 'night',
    icon: '🌙',
    title: 'Nachtschicht',
    text: (c) => `Unterwegs um ${c.night!.time} am Wochenende – Nachtbus und Nacht-U-Bahn`,
    settings: (c) => ({ difficulty: 'medium', slot: c.night!.id }),
    rounds: 1,
    roundOptions: HARD,
    needs: (c) => !!c.night,
  },
  {
    id: 'sunday',
    icon: '🧺',
    title: 'Sonntagsausflug',
    text: (c) => `Sonntag, ${c.sunday!.time} – weniger Fahrten, längere Wartezeiten`,
    settings: (c) => ({ difficulty: 'medium', slot: c.sunday!.id }),
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
  settings: { ...d.settings(c), rounds: d.rounds },
  roundOptions: d.roundOptions,
  done: d.done ?? 1000,
});

/** alle Challenges (Testseite, Medaillen) */
export const allChallenges = (c: ChallengeContext) => CHALLENGES.filter((d) => !d.needs || d.needs(c)).map((d) => make(d, c));

/** einfache, für alle gleiche Zufallszahl je Tag */
function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** so viele Challenges aus der Rotation je Tag – dazu kommt immer der Bezirk des Tages (zusammen 4) */
export const DAILY_COUNT = 3;

function shuffled<T>(list: T[], rnd: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Beginn der Rotation (Tag 0) */
const ROTATION_START = Math.round(Date.parse('2026-01-01T12:00:00Z') / 86_400_000);
/** so weit (Plätze) darf eine Challenge je Durchlauf wandern – neue Gruppen, Abstände bleiben fast gleich */
const JITTER = 8;
const orders = new Map<string, string[][]>();

/** Reihenfolge im Durchlauf `block`: Start gemischt, danach jeder Durchlauf leicht umgestellt */
function orderFor(ids: string[], block: number): string[] {
  const key = ids.join();
  let list = orders.get(key);
  if (!list) orders.set(key, (list = [shuffled(ids, seeded('bimguesser-rotation'))]));
  while (list.length <= block) {
    const prev = list[list.length - 1];
    const rnd = seeded(`bimguesser-rotation-${list.length}`);
    list.push(prev.map((id, i) => ({ id, k: i + rnd() * JITTER })).sort((a, b) => a.k - b.k).map((x) => x.id));
  }
  return list[block];
}

const dayIndex = (day: string) => Math.max(0, Math.round(Date.parse(`${day}T12:00:00Z`) / 86_400_000) - ROTATION_START);

/**
 * Die Challenges des Tages – für alle gleich: 3 aus der Rotation + der Bezirk des Tages, zufällig gemischt (die erste
 * ist der Vorschlag). Rotation: alle (die es im Spiel gibt) stehen in einer Reihenfolge, jeden Tag sind die nächsten 3
 * dran; nach jedem Durchlauf wird leicht umgestellt (jede wandert höchstens ein paar Plätze). So kommt jede gleich oft
 * und in fast gleichem Abstand, aufeinanderfolgende Tage überschneiden sich nie, und die Gruppen wechseln.
 */
export function dailyChallenges(day: string, ctx: ChallengeContext, district?: Challenge): Challenge[] {
  const pool = CHALLENGES.filter((d) => !d.needs || d.needs(ctx));
  const ids = pool.map((d) => d.id);
  const n = dayIndex(day);
  const today = Array.from({ length: Math.min(DAILY_COUNT, ids.length) }, (_, k) => {
    const m = n * DAILY_COUNT + k;
    const id = orderFor(ids, Math.floor(m / ids.length))[m % ids.length];
    return make(pool.find((d) => d.id === id)!, ctx);
  });
  return shuffled(district ? [...today, district] : today, seeded(day));
}

/** Bezirk des Tages: jeden Tag ein anderer der 23 Bezirke, alle kommen der Reihe nach (gemischt) dran */
export function districtOfDay(day: string): number {
  const n = dayIndex(day);
  return Number(orderFor(Array.from({ length: 23 }, (_, i) => String(i + 1)), Math.floor(n / 23))[n % 23]);
}

export function districtChallenge(id: number, name: string, center: [number, number]): Challenge {
  return {
    id: `district-${id}`,
    icon: '🏘️',
    title: `Bezirk des Tages: ${name}`,
    text: `Start und Ziel meist im ${id}. Bezirk – kurze Strecken, jeden Tag ein anderer`,
    settings: { difficulty: 'medium', distance: 'short', focus: { lat: center[0], lon: center[1], radiusM: 2500, share: 0.9 }, rounds: 2 },
    roundOptions: [1, 2, 3, 5],
    done: 1000,
  };
}
