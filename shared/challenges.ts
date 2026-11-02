// Tages-Challenges der Routenjagd: jeden Tag 3 andere Spielarten (für alle gleich) plus „Bezirk der Woche“.
// Eine aktive Challenge legt alle Einstellungen fest (Standard + ihre Änderungen); beenden → wieder Standard.
import type { GameSettings } from './types.ts';

/** was es in diesem Spiel gibt (Uhrzeiten und Wertungen stellt die Admin-Seite ein) */
export interface ChallengeContext {
  /** Uhrzeit zwischen 0 und 5 Uhr (id, „02:00“) */
  night: { id: string; time: string } | null;
  /** Werktag am Nachmittag/Abend (16–19 Uhr) */
  rush: { id: string; time: string } | null;
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

/** Katalog – nur stimmige Kombinationen (z.B. nie „Nachts“ + „Nur Bim“) */
export const CHALLENGES: ChallengeDef[] = [
  { id: 'coffee', icon: '☕', title: 'Kaffeepause', text: () => '3 kurze Runden à 2 Minuten, leichte Strecken', settings: () => ({ difficulty: 'easy', rounds: 3, roundTimeLimitSec: 120 }) },
  { id: 'blitz', icon: '⚡', title: 'Blitzrunde', text: () => '5 leichte Runden mit je nur 1 Minute', settings: () => ({ difficulty: 'easy', rounds: 5, roundTimeLimitSec: 60 }) },
  { id: 'no-u', icon: '🚫', title: 'Ohne U-Bahn', text: () => 'Jede Runde ohne U-Bahn – mit Bim, Bus und S-Bahn ans Ziel', settings: () => ({ difficulty: 'medium', variant: 'noU', rounds: 5 }) },
  { id: 'rail', icon: '🚆', title: 'Schienen-Tag', text: () => 'Jede Runde ohne Bus – nur U-Bahn, S-Bahn und Bim', settings: () => ({ difficulty: 'hard', variant: 'noBus', rounds: 5 }) },
  { id: 'tram', icon: '🚋', title: 'Bim-Tour', text: () => 'Nur mit der Bim – Start und Ziel an Bim-Stationen', settings: () => ({ variant: 'tram', rounds: 5, roundTimeLimitSec: 300 }) },
  { id: 'direct', icon: '1️⃣', title: 'Direkt-Profi', text: () => 'Jede Runde höchstens 1 Umstieg – die beste Zweier-Kombination finden', settings: () => ({ difficulty: 'medium', variant: 'one', rounds: 5 }) },
  { id: 'transfers', icon: '🔀', title: 'Umsteige-Profi', text: () => 'Nur Strecken, auf denen man mindestens 2-mal umsteigt', settings: () => ({ difficulty: 'hard', rounds: 5 }) },
  { id: 'pro', icon: '🏆', title: 'Profi-Sprint', text: () => '3 Profi-Strecken (lang, alle Haltestellen) mit je 3 Minuten', settings: () => ({ difficulty: 'expert', rounds: 3, roundTimeLimitSec: 180 }) },
  { id: 'obstacles', icon: '⛔', title: 'Hindernislauf', text: () => 'Jede Runde eine andere Hürde: gesperrte Linie, ohne Bus, max. 1 Umstieg …', settings: () => ({ difficulty: 'medium', restrictions: 'always', rounds: 5 }) },
  { id: 'blind', icon: '🙈', title: 'Blindflug', text: () => 'Die Karte bleibt leer – nur die Namen von Start und Ziel', settings: () => ({ difficulty: 'easy', xtreme: 'noMap', rounds: 3 }) },
  { id: 'no-names', icon: '🕶️', title: 'Ohne Namen', text: () => 'Start und Ziel nur als Punkte auf der Karte – wo ist das?', settings: () => ({ difficulty: 'easy', xtreme: 'noNames', rounds: 3 }) },
  { id: 'locals', icon: '🧭', title: 'Ortskenner', text: () => 'Start und Ziel erst auf der Karte finden, Ein- und Ausstieg ohne Vorschläge eintippen', settings: () => ({ difficulty: 'easy', locate: true, xtreme: 'noHints', rounds: 3 }) },
  { id: 'doors', icon: '🏠', title: 'Tür zu Tür', text: () => 'Start und Ziel sind echte Adressen – erst zur richtigen Haltestelle gehen', settings: () => ({ endpoints: 'addresses', rounds: 5 }) },
  { id: 'city', icon: '🏛️', title: 'Innere Stadt', text: () => 'Kurze Strecken rund um den Stephansplatz', settings: () => ({ difficulty: 'medium', distance: 'short', focus: { ...STEPHANSPLATZ, radiusM: 2500, share: 0.9 }, rounds: 5 }) },
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
    id: 'comfy',
    icon: '🛋️',
    title: 'Gemütlich',
    text: () => 'Ohne Zeitlimit – es zählt Zeit und möglichst wenig Umsteigen',
    settings: () => ({ difficulty: 'medium', goal: 'best', roundTimeLimitSec: null, rounds: 5 }),
    needs: (c) => c.avoid,
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

/** die 3 Challenges des Tages – nur, was es im Spiel gibt */
export function dailyChallenges(day: string, ctx: ChallengeContext): Challenge[] {
  const rnd = seeded(day);
  const pool = CHALLENGES.filter((d) => !d.needs || d.needs(ctx));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3).map((d) => make(d, ctx));
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
