// ================================================================
//  ALLE STANDARD-EINSTELLUNGEN AN EINEM ORT
//  Hier ändern – Server, Lobby, Training und Lernmodus lesen diese Werte.
//  (Spielregeln wie Punkte, Tipp-Abzüge oder Umstiegs-Aufschlag stehen in shared/rules.ts.)
// ================================================================
import type { GameSettings, Mode, SlotId } from './types.ts';
import type { QuizSettings } from './quiz.ts';

// ---------------------------------------------------------------- 🏁 Routenjagd (Lobby)

export const DEFAULT_SETTINGS: GameSettings = {
  /** Uhrzeit: 'wd12' Mo–Fr 12 Uhr · 'wd17' Mo–Fr 17 Uhr · 'sa02' Sa 2 Uhr · 'su12' So 12 Uhr */
  slot: 'wd12',
  /** 'regular' = Referenztag ohne Baustellen · 'current' = nächster echter Tag inkl. Sperren */
  network: 'regular',
  /** Schnellwahl: 'easy' · 'medium' · 'hard' · 'expert' (muss zu stations/distance/needTransfer passen) */
  difficulty: 'medium',
  /** Haltestellen: 'U' 'S' 'T' (Bim) + höchstens eine Bus-Stufe 'hub' (3+ Linien) · 'bus' (2+) · 'all' */
  stations: ['U', 'S', 'T'],
  /** Entfernung: 'short' 2–7 km · 'medium' 3–12 km · 'long' 6–16 km */
  distance: 'medium',
  /** nur Strecken, deren beste Verbindung einen Umstieg hat */
  needTransfer: false,
  /** Fokus-Kreis (null = aus) */
  focus: null,
  /** Runden: 3 · 5 · 7 · 10 */
  rounds: 5,
  /** Zeitlimit in Sekunden (60 · 120 · 180 · 240 · 300 · 600) oder null = ohne */
  roundTimeLimitSec: 180,
  /** "Wo liegt das?" vor jeder Runde */
  locate: true,
  /** Wartezeit ab Abfragezeit mitzählen */
  countWait: true,
  /** Ø-Wartezeiten (halber Takt) statt Fahrplan-Glück */
  avgWait: true,
  /** 'best' = Zeit + Aufschlag je Umstieg · 'fastest' = nur Zeit */
  goal: 'best',
  /** Einschränkungs-Runden: 'never' · 'sometimes' · 'always' */
  restrictions: 'never',
  /** Tipps erlaubt */
  tips: true,
};

/** Diese Einstellungen werden NICHT für die nächste Lobby gemerkt – sie starten immer mit dem Standard */
export const NOT_REMEMBERED: (keyof GameSettings)[] = ['network', 'focus'];

// ---------------------------------------------------------------- 🧠 Quiz (Lobby)

export const DEFAULT_QUIZ_SETTINGS: QuizSettings = {
  /** Fragen: 5 · 10 · 15 · 20 */
  questions: 10,
  /** Sekunden pro Frage: 10 · 15 · 20 · 30 · 45 ("Linie zeichnen" bekommt das Doppelte, mind. 40) */
  timeSec: 20,
  /** 0 = ganz Wien, sonst Bezirksnummer */
  area: 0,
  /** Verkehrsmittel: 'U' 'S' 'T' 'B' 'N' */
  modes: ['U', 'S', 'T', 'B'],
  /** Häufigkeit je Fragetyp: 1 = gar nicht · 4 = normal · 7 = sehr häufig */
  weights: { locate: 3, direct: 4, transfer: 6, stopLines: 4, termini: 4, lineShape: 5, draw: 3, district: 2, nextStop: 1 },
};

// ---------------------------------------------------------------- 🏋️ Training

export const DEFAULT_TRAINING: { slot: SlotId; preset: 'easy' | 'medium' | 'hard' | 'expert'; area: number; coach: boolean } = {
  slot: 'wd12',
  preset: 'medium',
  /** 0 = ganz Wien, sonst Schwerpunkt-Bezirk */
  area: 0,
  /** Coach-Rückmeldungen nach jeder Teilstrecke */
  coach: true,
};

// ---------------------------------------------------------------- 📚 Lernen

export const DEFAULT_LEARN = {
  /** 'area' · 'lines' · 'all' */
  kind: 'area' as 'area' | 'lines' | 'all',
  /** 'district' · 'circle' */
  areaType: 'district' as 'district' | 'circle',
  /** Bezirk bei "Gebiet" */
  district: 2,
  circle: null as { lat: number; lon: number; radiusM: number } | null,
  lines: [] as string[],
  modes: ['U', 'S', 'T', 'B'] as Mode[],
};
