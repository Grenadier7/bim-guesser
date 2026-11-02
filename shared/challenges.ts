// Tages-Challenges der Routenjagd: jeden Tag 3 andere Spielarten (für alle gleich) plus „Bezirk der Woche“.
// Eine aktive Challenge legt alle Einstellungen fest (Standard + ihre Änderungen); beenden → wieder Standard.
import type { GameSettings } from './types.ts';

/** was es in diesem Spiel gibt (Uhrzeiten und Wertungen stellt die Admin-Seite ein) */
export interface ChallengeContext {
  /** Uhrzeit zwischen 0 und 5 Uhr (id, „02:00“) */
  night: { id: string; time: string } | null;
  /** Werktag am Nachmittag/Abend (16–19 Uhr) */
  rush: { id: string; time: string } | null;
  /** Sonntag tagsüber */
  sunday?: { id: string; time: string } | null;
  /** Wertung „Umstiege vermeiden“ verfügbar */
  avoid: boolean;
}

export interface Challenge {
  id: string;
  icon: string;
  title: string;
  text: string;
  /** Änderungen gegenüber den Standard-Einstellungen */
  settings: Partial<GameSettings>;
}

interface ChallengeDef {
  id: string;
  icon: string;
  title: string;
  text: (c: ChallengeContext) => string;
  settings: (c: ChallengeContext) => Partial<GameSettings>;
  /** nur, wenn es das im Spiel gibt */
  needs?: (c: ChallengeContext) => boolean;
}

const STEPHANSPLATZ = { lat: 48.2085, lon: 16.3731 };
const fixed = (text: string, settings: Partial<GameSettings>) => ({ text: () => text, settings: () => settings });

/**
 * Katalog – nur stimmige Kombinationen (z.B. nie „Nachts“ + „Nur Bim“). Gruppen: Tempo & Format, Netz-Regeln,
 * Routen-Regeln (gelten für die ganze Route, z.B. „mind. eine S-Bahn“), Wahrnehmung, Ort & Zeit.
 */
export const CHALLENGES: ChallengeDef[] = [
  // ---- Tempo & Format
  { id: 'coffee', icon: '☕', title: 'Kaffeepause', ...fixed('3 kurze Runden à 2 Minuten, leichte Strecken', { difficulty: 'easy', rounds: 3, roundTimeLimitSec: 120 }) },
  { id: 'blitz', icon: '⚡', title: 'Blitzrunde', ...fixed('5 leichte Runden mit je nur 1 Minute', { difficulty: 'easy', rounds: 5, roundTimeLimitSec: 60 }) },
  { id: 'thriller', icon: '⏱️', title: 'Sekundenkrimi', ...fixed('3 Runden, je 40 Sekunden – Bauchgefühl statt Nachdenken', { difficulty: 'easy', rounds: 3, roundTimeLimitSec: 40 }) },
  { id: 'marathon', icon: '🏃', title: 'Marathon', ...fixed('10 Runden quer durch Wien – Ausdauer zählt', { difficulty: 'medium', rounds: 10, roundTimeLimitSec: 180 }) },
  { id: 'pro', icon: '🏆', title: 'Profi-Sprint', ...fixed('3 Profi-Strecken (lang, alle Haltestellen) mit je 3 Minuten', { difficulty: 'expert', rounds: 3, roundTimeLimitSec: 180 }) },
  { id: 'purist', icon: '🧘', title: 'Puristen-Runde', ...fixed('Keine Joker, kein Zeitlimit – nur dein Wissen zählt', { difficulty: 'medium', tips: 'off', roundTimeLimitSec: null, rounds: 5 }) },
  {
    id: 'comfy',
    icon: '🛋️',
    title: 'Gemütlich',
    ...fixed('Ohne Zeitlimit – es zählt Zeit und möglichst wenig Umsteigen', { difficulty: 'medium', goal: 'best', roundTimeLimitSec: null, rounds: 5 }),
    needs: (c) => c.avoid,
  },
  // ---- Netz-Regeln (je Linie)
  { id: 'no-u', icon: '🚫', title: 'Ohne U-Bahn', ...fixed('Jede Runde ohne U-Bahn – mit Bim, Bus und S-Bahn ans Ziel', { difficulty: 'medium', variant: 'noU', rounds: 5 }) },
  { id: 'rail', icon: '🛤️', title: 'Schienen-Tag', ...fixed('Jede Runde ohne Bus – nur U-Bahn, S-Bahn und Bim', { difficulty: 'hard', variant: 'noBus', rounds: 5 }) },
  { id: 'tram', icon: '🚋', title: 'Bim-Tour', ...fixed('Nur mit der Bim – Start und Ziel an Bim-Stationen', { variant: 'tram', rounds: 5, roundTimeLimitSec: 300 }) },
  { id: 'insider', icon: '🕵️', title: 'Insider', ...fixed('Keine U-Bahn, keine bekannte S-Bahn – nur Bim, Bus und die S-Bahnen, die kaum wer kennt', { difficulty: 'medium', variant: 'insider', rounds: 3 }) },
  { id: 'direct', icon: '1️⃣', title: 'Direkt-Profi', ...fixed('Jede Runde höchstens 1 Umstieg – die beste Zweier-Kombination finden', { difficulty: 'medium', variant: 'one', rounds: 5 }) },
  { id: 'transfers', icon: '🔀', title: 'Umsteige-Profi', ...fixed('Nur Strecken, auf denen man mindestens 2-mal umsteigt', { difficulty: 'hard', rounds: 5 }) },
  { id: 'obstacles', icon: '⛔', title: 'Hindernislauf', ...fixed('Jede Runde eine andere Hürde: gesperrte Linie, ohne Bus, max. 1 Umstieg …', { difficulty: 'medium', restrictions: 'always', rounds: 5 }) },
  // ---- Routen-Regeln (für die ganze Route)
  { id: 's-fan', icon: '🚆', title: 'S-Bahn-Fan', ...fixed('Start und Ziel an der S-Bahn – und jede Route mit mindestens einer S-Bahn', { stations: ['S'], variant: 'needS', rounds: 5 }) },
  { id: 'bus-driver', icon: '🚌', title: 'Busfahrer', ...fixed('Jede Route mit mindestens einem Stück Bus', { difficulty: 'medium', variant: 'needBus', rounds: 5 }) },
  { id: 'one-u', icon: '☝️', title: 'Eine U reicht', ...fixed('Höchstens eine U-Bahn-Fahrt pro Route – von U zu U umsteigen ist tabu', { difficulty: 'hard', variant: 'maxOneU', rounds: 5 }) },
  { id: 'mix', icon: '🎨', title: 'Bunt gemischt', ...fixed('Jede Route mit mindestens zwei verschiedenen Verkehrsmitteln', { difficulty: 'medium', variant: 'mixModes', rounds: 5 }) },
  { id: 'no-same', icon: '🔁', title: 'Nie zweimal dasselbe', ...fixed('Nach der U-Bahn keine U-Bahn, nach der Bim keine Bim – immer wechseln', { difficulty: 'hard', variant: 'noSameMode', rounds: 5 }) },
  { id: 'tram-hop', icon: '🦘', title: 'Bim-Hüpfer', ...fixed('Start und Ziel an der Bim – und mindestens zweimal mit der Bim fahren', { stations: ['T'], variant: 'twoTrams', rounds: 5, roundTimeLimitSec: 300 }) },
  // ---- Wahrnehmung
  { id: 'blind', icon: '🙈', title: 'Blindflug', ...fixed('Die Karte bleibt leer – nur die Namen von Start und Ziel', { difficulty: 'easy', xtreme: 'noMap', rounds: 3 }) },
  { id: 'no-names', icon: '🕶️', title: 'Ohne Namen', ...fixed('Start und Ziel nur als Punkte auf der Karte – wo ist das?', { difficulty: 'easy', xtreme: 'noNames', rounds: 3 }) },
  { id: 'locals', icon: '🧭', title: 'Ortskenner', ...fixed('Start und Ziel erst auf der Karte finden, Ein- und Ausstieg ohne Vorschläge eintippen', { difficulty: 'easy', locate: true, xtreme: 'noHints', rounds: 3 }) },
  // ---- Ort & Zeit
  { id: 'doors', icon: '🏠', title: 'Tür zu Tür', ...fixed('Start und Ziel sind echte Adressen – erst zur richtigen Haltestelle gehen', { endpoints: 'addresses', rounds: 5 }) },
  { id: 'city', icon: '🏛️', title: 'Innere Stadt', ...fixed('Kurze Strecken rund um den Stephansplatz', { difficulty: 'medium', distance: 'short', focus: { ...STEPHANSPLATZ, radiusM: 2500, share: 0.9 }, rounds: 5 }) },
  { id: 'outskirts', icon: '🌄', title: 'Stadtrand-Tour', ...fixed('Lange Strecken (6–16 km) von Rand zu Rand', { stations: ['U', 'S', 'Tkey'], distance: 'long', minTransfers: 1, rounds: 5, roundTimeLimitSec: 300 }) },
  { id: 'timetable', icon: '🧮', title: 'Fahrplan-Fuchs', ...fixed('Echte Abfahrten statt Durchschnitt – wer den Anschluss erwischt, gewinnt', { difficulty: 'medium', avgWait: false, countWait: true, rounds: 5 }) },
  {
    id: 'night',
    icon: '🌙',
    title: 'Nachtschicht',
    text: (c) => `Unterwegs um ${c.night!.time} – Nachtbus und Nacht-U-Bahn`,
    settings: (c) => ({ difficulty: 'medium', slot: c.night!.id, rounds: 5 }),
    needs: (c) => !!c.night,
  },
  {
    id: 'rush',
    icon: '🚦',
    title: 'Stoßzeit',
    text: (c) => `Werktag, ${c.rush!.time} – dichter Takt, viele Möglichkeiten`,
    settings: (c) => ({ difficulty: 'hard', slot: c.rush!.id, rounds: 5 }),
    needs: (c) => !!c.rush,
  },
  {
    id: 'sunday',
    icon: '☀️',
    title: 'Sonntagsausflug',
    text: (c) => `Sonntag, ${c.sunday!.time} – weniger Fahrten, längere Wartezeiten`,
    settings: (c) => ({ difficulty: 'medium', slot: c.sunday!.id, rounds: 5 }),
    needs: (c) => !!c.sunday,
  },
];

const make = (d: ChallengeDef, c: ChallengeContext): Challenge => ({ id: d.id, icon: d.icon, title: d.title, text: d.text(c), settings: d.settings(c) });

/** einfache, für alle gleiche Zufallszahl je Tag */
function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** so viele Challenges je Tag (die erste ist der Tagesvorschlag; der Bezirk der Woche ist einer davon, wenn er dran ist) */
export const DAILY_COUNT = 4;

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
/** so weit (Plätze) darf eine Challenge je Durchlauf wandern – neue Vierergruppen, Abstände bleiben fast gleich */
const JITTER = 5;
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

/**
 * Die Challenges des Tages – für alle gleich. Rotation: alle (die es im Spiel gibt) stehen in einer Reihenfolge, jeden
 * Tag sind die nächsten 4 dran; nach jedem Durchlauf wird die Reihenfolge leicht umgestellt (jede wandert höchstens ein
 * paar Plätze). So kommt jede gleich oft und in fast gleichem Abstand (Anzahl / 4 Tage, ±2), aufeinanderfolgende Tage
 * überschneiden sich nie, und es sind nicht immer dieselben 4 zusammen. Innerhalb des Tages zufällig gemischt – die
 * erste ist der Vorschlag.
 */
export function dailyChallenges(day: string, ctx: ChallengeContext, district?: Challenge): Challenge[] {
  const pool = CHALLENGES.filter((d) => !d.needs || d.needs(ctx));
  // Bezirk der Woche läuft in der Rotation mit (kommt so etwa einmal pro Woche)
  const ids = [...pool.map((d) => d.id), ...(district ? ['district'] : [])];
  const n = Math.max(0, Math.round(Date.parse(`${day}T12:00:00Z`) / 86_400_000) - ROTATION_START);
  const today = Array.from({ length: Math.min(DAILY_COUNT, ids.length) }, (_, k) => {
    const m = n * DAILY_COUNT + k;
    const id = orderFor(ids, Math.floor(m / ids.length))[m % ids.length];
    return id === 'district' ? district! : make(pool.find((d) => d.id === id)!, ctx);
  });
  return shuffled(today, seeded(day));
}

/** Bezirk der Woche: jede Kalenderwoche ein anderer der 23 Bezirke (für alle gleich) */
export function districtOfWeek(t = Date.now()): number {
  const week = Math.floor((t / 86_400_000 + 3) / 7); // Wochen seit Montag, 5.1.1970
  return (week % 23) + 1;
}

export function districtChallenge(id: number, name: string, center: [number, number]): Challenge {
  return {
    id: `district-${id}`,
    icon: '🏘️',
    title: `Bezirk der Woche: ${name}`,
    text: 'Start und Ziel meist im Bezirk – kurze Strecken, jede Woche ein anderer',
    settings: { difficulty: 'medium', distance: 'short', focus: { lat: center[0], lon: center[1], radiusM: 2500, share: 0.9 }, rounds: 5 },
  };
}
