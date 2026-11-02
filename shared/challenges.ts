// Tages-Challenges der Routenjagd: jeden Tag 3 andere Spielarten (für alle gleich) plus „Bezirk der Woche“.
// Eine aktive Challenge legt alle Einstellungen fest (Standard + ihre Änderungen); beenden → wieder Standard.
import type { GameSettings } from './types.ts';

export interface Challenge {
  id: string;
  icon: string;
  title: string;
  text: string;
  /** Änderungen gegenüber den Standard-Einstellungen */
  settings: Partial<GameSettings>;
}

/** Katalog – nur stimmige Kombinationen (z.B. nie „Nachts“ + „Nur Bim“) */
export const CHALLENGES: Challenge[] = [
  { id: 'coffee', icon: '☕', title: 'Kaffeepause', text: '3 kurze Runden à 2 Minuten, leicht', settings: { difficulty: 'easy', rounds: 3, roundTimeLimitSec: 120 } },
  { id: 'no-u', icon: '🚫', title: 'Ohne U-Bahn', text: 'Jede Runde ohne U-Bahn – Bim, Bus und S-Bahn', settings: { difficulty: 'medium', variant: 'noU', rounds: 5 } },
  { id: 'tram', icon: '🚋', title: 'Bim-Tour', text: 'Nur mit der Bim – Start und Ziel an Bim-Stationen', settings: { variant: 'tram', rounds: 5, roundTimeLimitSec: 300 } },
  { id: 'night', icon: '🌙', title: 'Nachtschicht', text: 'Unterwegs zwischen 0 und 5 Uhr – Nachtbus und Nacht-U-Bahn', settings: { difficulty: 'medium', rounds: 5 } },
  { id: 'blind', icon: '🙈', title: 'Blindflug', text: 'Ohne Karte – nur die Namen von Start und Ziel', settings: { difficulty: 'easy', xtreme: 'noMap', rounds: 3 } },
  { id: 'pro', icon: '🏆', title: 'Profi-Sprint', text: '3 Profi-Strecken, je 3 Minuten', settings: { difficulty: 'expert', rounds: 3, roundTimeLimitSec: 180 } },
  { id: 'transfers', icon: '🔀', title: 'Umsteige-Profi', text: 'Nur Strecken mit mindestens 2 Umstiegen', settings: { difficulty: 'hard', rounds: 5 } },
  { id: 'doors', icon: '🏠', title: 'Tür zu Tür', text: 'Start und Ziel sind echte Adressen', settings: { endpoints: 'addresses', rounds: 5 } },
  { id: 'locate', icon: '📍', title: 'Ortskenner', text: 'Vor jeder Runde Start und Ziel auf der Karte finden', settings: { difficulty: 'medium', locate: true, rounds: 5 } },
  { id: 'obstacles', icon: '⛔', title: 'Hindernislauf', text: 'Jede Runde mit Einschränkung – gesperrte Linie, ohne Bus …', settings: { difficulty: 'medium', restrictions: 'always', rounds: 5 } },
];

/** einfache, für alle gleiche Zufallszahl je Tag */
function seeded(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** die 3 Challenges des Tages (`hasNight`: gibt es eine Uhrzeit zwischen 0 und 5 Uhr?) */
export function dailyChallenges(day: string, hasNight: boolean): Challenge[] {
  const rnd = seeded(day);
  const pool = CHALLENGES.filter((c) => c.id !== 'night' || hasNight);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}

/** Bezirk der Woche: jede Kalenderwoche ein anderer der 23 Bezirke (für alle gleich) */
export function districtOfWeek(t = Date.now()): number {
  const week = Math.floor((t / 86_400_000 + 3) / 7); // Wochen seit Montag, 5.1.1970
  return (week % 23) + 1;
}
