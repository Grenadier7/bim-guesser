import type { QuizQuestionPublic, QuizSettings } from './quiz.ts';

// Gemeinsame Typen für Server und Client.
// Alles, was über die Leitung geht (REST + Server-Sent Events), ist hier definiert.

/** U = U-Bahn, S = S-Bahn, T = Straßenbahn/Lokalbahn, B = Bus, N = Nachtbus, W = Fußweg */
export type Mode = 'U' | 'S' | 'T' | 'B' | 'N' | 'W';

export type LatLon = [number, number];

// ---------------------------------------------------------------- Netz

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Verkehrsmittel, die hier halten (ohne W) */
  modes: Mode[];
  /** Linien-IDs, die hier halten */
  lines: string[];
  /** Wiener Gemeindebezirk 1–23 */
  district: number;
}

export interface District {
  id: number;
  name: string;
  /** vereinfachte Umrisse (Ringe aus [lat, lon]) */
  rings: LatLon[][];
}

/** current = aktueller Fahrplan inkl. Baustellen, regular = Referenztag ohne Störungen */
export type NetMode = 'current' | 'regular';

export interface Line {
  id: string;
  mode: Mode;
  color: string;
  /** Haltefolgen (Station-IDs) je Richtung/Variante */
  patterns: string[][];
  /** parallel zu patterns: in welchem Netz gibt es die Haltefolge ("c", "r" oder "cr") */
  nets: string[];
}

export type DayType = 'wd' | 'sa' | 'su';

export interface ReferenceDay {
  /** YYYY-MM-DD */
  date: string;
  /** 0 = keine bekannten Störungen */
  score: number;
  note: string;
}

/** Was der Client vom Netz bekommt */
export interface NetworkPublic {
  generatedAt: string;
  /** Referenztage für das reguläre Netz */
  regularDays: Record<DayType, ReferenceDay>;
  stations: Station[];
  lines: Line[];
  districts: District[];
  /** Ø-Takt je Linie in Minuten (Schlüssel wd7, wd12, wd20, sa12, su12; null = fährt da nicht) – aus data/headways.json */
  headways?: Record<string, Record<string, number | null>>;
  /** so viele Adressen kennt der Server als Start/Ziel (0 = keine Adressdaten) */
  addressCount?: number;
}

/** data/headways.json (scripts/build-headways.ts) */
export interface Headways {
  generatedAt: string;
  lines: Record<string, Record<string, number | null>>;
}

/** Server-Variante: zusätzlich EFA-Haltestellen-IDs je Station */
export interface NetworkData extends NetworkPublic {
  /** Station-ID -> EFA-Stop-IDs (wichtigste zuerst) */
  efaIds: Record<string, string[]>;
}

// ---------------------------------------------------------------- Zeit & Einstellungen

export type SlotId = 'wd12' | 'wd17' | 'sa02' | 'su12';

export interface TimeSlot {
  id: SlotId;
  label: string;
  short: string;
}

/** Schnellwahl der Schwierigkeit; "custom" = Regler selbst eingestellt */
export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert' | 'custom';

/**
 * Welche Haltestellen als Start/Ziel vorkommen – je Verkehrsmittel höchstens EINE Stufe:
 *  U-Bahn: Ukey (wichtige) ⊂ U (alle) · S-Bahn: Skey ⊂ S · Bim: Tkey ⊂ T
 *  Bus: hub (Bus-Haltestellen mit 3+ Linien) ⊂ bus (2+ Linien) ⊂ all (jede Bus-Haltestelle)
 */
export type StationKind = 'Ukey' | 'U' | 'Skey' | 'S' | 'Tkey' | 'T' | 'hub' | 'bus' | 'all';

export type DistanceRange = 'short' | 'medium' | 'long';

/**
 * X-treme: 'off' · 'noHints' (Haltestellen selbst eintippen, keine Route auf der Karte) ·
 * 'noNames' (zusätzlich Start/Ziel nur als Punkte) · 'noMap' (zusätzlich nichts auf der Karte)
 */
export type XtremeLevel = 'off' | 'noHints' | 'noNames' | 'noMap';

/** Tipps: keine · günstig · teuer */
export type TipLevel = 'off' | 'cheap' | 'expensive';

/** Wertung: "fastest" = nur Reisezeit · "best" = Reisezeit + Strafzeit je Umstieg */
export type RouteGoal = 'fastest' | 'best';

export interface FocusArea {
  lat: number;
  lon: number;
  radiusM: number;
  /** Anteil (0–1), mit dem eine Station aus dem Kreis gezogen wird – der Rest aus ganz Wien */
  share: number;
}

/** Einschränkungs-Runden */
export type Restriction = 'noU' | 'noBus' | 'oneTransfer' | 'banLines';

/** Wie oft Einschränkungs-Runden vorkommen */
export type RestrictionFrequency = 'never' | 'sometimes' | 'always';

export interface GameSettings {
  slot: SlotId;
  network: NetMode;
  difficulty: Difficulty;
  stations: StationKind[];
  distance: DistanceRange;
  /** Schnellste Verbindung muss mindestens einen Umstieg haben */
  minTransfers: 0 | 1 | 2;
  /** Fokus-Gebiet: Stationen darin werden häufiger gezogen (null = ganz Wien gleichmäßig) */
  focus: FocusArea | null;
  rounds: number;
  /** null = kein Zeitlimit */
  roundTimeLimitSec: number | null;
  /** "Wo liegt das?" – Start und Ziel vorher auf der Karte tippen */
  locate: boolean;
  /** Wartezeit an der Starthaltestelle mitzählen (Tür-zu-Tür ab Abfragezeit) */
  countWait: boolean;
  /** Wartezeiten als Durchschnitt (halber Takt) statt nach dem zufällig passenden Fahrplan */
  avgWait: boolean;
  /** Was zählt: schnellste Route oder beste (Zeit + Umstiege) */
  goal: RouteGoal;
  /** X-treme-Stufe (doppelte Zeit) */
  xtreme: XtremeLevel;
  /** Manche Runden mit Einschränkung (ohne U-Bahn, ohne Bus, max. 1 Umstieg) */
  restrictions: RestrictionFrequency;
  /** Tipps erlaubt */
  /** Tipps: keine / günstig / teuer */
  tips: TipLevel;
  /** Start und Ziel: Haltestellen oder zufällige Adressen (Punkt 13) */
  endpoints: 'stations' | 'addresses';
}

// ---------------------------------------------------------------- Routen

/** Eine Teilstrecke, wie der User sie eingibt */
export interface UserLeg {
  line: string;
  from: string; // Station-ID
  to: string; // Station-ID
}

export interface RouteLeg {
  mode: Mode;
  /** Liniennummer, bei S-Bahn evtl. "S1/S2"; null bei Fußweg */
  line: string | null;
  color: string;
  fromName: string;
  toName: string;
  fromStation: string | null;
  toStation: string | null;
  /** "HH:MM" */
  dep: string;
  arr: string;
  path: LatLon[];
  /** S-Bahn-Abschnitt: Regionalzüge, die hier mitzählen (Takt gilt für alle zusammen), z.B. ["REX4", "REX41"] */
  with?: string[];
}

export interface RouteOption {
  /** Signatur: Linien + Umstiegsstationen */
  key: string;
  legs: RouteLeg[];
  /** Median der gewerteten Reisezeit (je nach Einstellung inkl. Wartezeit), Minuten */
  medianMin: number;
  minMin: number;
  maxMin: number;
  /** Median der reinen Reisezeit ab Abfahrt (ohne Warten am Start) */
  rideMin: number;
  /** Wie oft diese Verbindungsart in den Stichproben vorkam */
  samples: number;
  /** bei Ø-Wartezeiten: der berechnete Zeitplan, aus dem medianMin entsteht */
  steps?: RouteStep[];
}

/** Ein Schritt des berechneten Zeitplans (Ø-Wartezeiten) */
export interface RouteStep {
  kind: 'walk' | 'transfer' | 'wait' | 'ride';
  /** Beginn "HH:MM" (berechnet ab der Abfragezeit) */
  at: string;
  min: number;
  /** walk/transfer: Ziel · wait: Station · ride: Ausstieg */
  to: string;
  /** ride: Einstieg */
  from?: string;
  line?: string;
  mode?: Mode;
  color?: string;
  /** wait: Takt (im Schnitt alle … min) */
  every?: number;
  /** wait/ride: Regionalzüge, die im Takt mitzählen (S-Bahn + REX/R zusammen) */
  with?: string[];
}

export interface Guesses {
  from: LatLon | null;
  to: LatLon | null;
}

export interface ScoreBreakdown {
  /** Routenpunkte vor Tipps (0–1000) */
  route: number;
  /** Anteil, den die Tipps abziehen (0–1) */
  tipShare: number;
  routeAfterTips: number;
  timeBonus: number;
  locate: number;
  multiplier: number;
  total: number;
}

export interface Evaluation {
  playerId: string;
  playerName: string;
  legs: UserLeg[];
  /** Nachgerechnete Route des Users (null bei Fehler / nicht abgegeben) */
  route: RouteOption | null;
  durationMin: number | null;
  /** Gewertete Minuten: bei "beste Route" inkl. Strafzeit für Umstiege */
  costMin: number | null;
  /** Rang in den Top-Verbindungen (0 = schnellste), null wenn nicht dabei */
  matchedRank: number | null;
  /** "top" = aus Stichprobe übernommen, "computed" = selbst nachgerechnet */
  source: 'top' | 'computed' | 'none';
  error: string | null;
  /** Benötigte Zeit in Sekunden (null = nicht abgegeben) */
  elapsedSec: number | null;
  timedOut: boolean;
  tips: TipKind[];
  guesses: Guesses | null;
  /** Abstand der Schätzungen zu den echten Stationen (m) */
  locateDist: { from: number | null; to: number | null } | null;
  score: ScoreBreakdown;
}

// ---------------------------------------------------------------- Tipps

export type TipKind = 'startLines' | 'endLines' | 'modeChain' | 'transfers';

export interface TipInfo {
  kind: TipKind;
  label: string;
  /** Anteil der Routenpunkte, den der Tipp kostet */
  share: number;
}

export type TipResult =
  | { kind: 'startLines' | 'endLines'; station: string; lines: { id: string; mode: Mode; color: string }[] }
  | { kind: 'modeChain'; modes: Mode[]; transfers: number; medianMin: number }
  | {
      kind: 'transfers';
      /** name ist bei X-treme "ohne Namen" leer – dann zeigen die Linien, wo umgestiegen wird */
      stops: { name: string; lat: number; lon: number; from?: TipLine; to?: TipLine }[];
    };

export interface TipLine {
  id: string;
  mode: Mode;
  color: string;
}

// ---------------------------------------------------------------- Spiel

export interface StationRef {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface PlayerPublic {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
  connected: boolean;
  /** angemeldet: Benutzername des Accounts (Profil antippbar) */
  account?: string;
}

export type RoundStatus = 'preparing' | 'open' | 'revealed';

export interface RoundPublic {
  index: number;
  status: RoundStatus;
  from: StationRef | null;
  to: StationRef | null;
  /** Datum/Uhrzeit der Abfrage, z.B. "Mi 21.10. 12:00" */
  when: string | null;
  restriction: Restriction | null;
  /** bei "banLines": diese Linien sind in der Runde verboten */
  bannedLines: string[];
  /** Zeitlimit dieser Runde (Einschränkungs-Runden haben mehr Zeit) */
  limitSec: number | null;
  /** Spieler-IDs, die schon abgegeben haben */
  submitted: string[];
  /** Server-Zeitstempel (ms) */
  startedAt: number | null;
  deadline: number | null;
  /** vom Host pausiert seit (Serverzeit, ms) */
  pausedAt: number | null;
}

export type GamePhase = 'lobby' | 'playing' | 'finished';

/** Spielmodus einer Lobby */
export type GameMode = 'route' | 'quiz';

export interface GameState {
  mode: 'route';
  /** Lobby-Code */
  id: string;
  /** Serverzeit beim Senden (ms) – für den Countdown im Client */
  serverNow: number;
  settings: GameSettings;
  phase: GamePhase;
  players: PlayerPublic[];
  currentRound: number;
  rounds: RoundPublic[];
}

export interface RoundReveal {
  index: number;
  routes: RouteOption[];
  evaluations: Evaluation[];
  /** vom Host abgebrochen – keine Punkte */
  cancelled: boolean;
}

// ---------------------------------------------------------------- Quiz (Mehrspieler)

export interface QuizAnswerResult {
  playerId: string;
  playerName: string;
  /** Antwort des Spielers (Option-ID, Liste von IDs oder Koordinate) */
  answer: string | string[] | LatLon | LatLon[] | null;
  /** Anteil richtig 0–1 */
  base: number;
  points: number;
  elapsedSec: number | null;
}

export interface QuizRevealPublic {
  correct: string | string[] | LatLon | LatLon[];
  explanation: string;
  revealStationId: string | null;
  revealLineId: string | null;
  /** Linien, die in der Auflösung farbig gezeichnet werden (vorher nicht im Zustand – sie verraten die Lösung) */
  drawLines?: string[];
  results: QuizAnswerResult[];
  cancelled: boolean;
}

export interface QuizState {
  mode: 'quiz';
  id: string;
  serverNow: number;
  settings: QuizSettings;
  phase: GamePhase;
  players: PlayerPublic[];
  /** Index der aktuellen Frage (-1 in der Lobby) */
  current: number;
  total: number;
  status: 'open' | 'revealed' | null;
  question: QuizQuestionPublic | null;
  answered: string[];
  startedAt: number | null;
  deadline: number | null;
  pausedAt: number | null;
  reveal: QuizRevealPublic | null;
}

/** Zustand einer Lobby – je nach Modus */
export type LobbyState = GameState | QuizState;

/** Events, die ein Spiel aussendet (für SSE/WebSocket) */
/** Nachricht im Lobby-Chat; ohne playerId = Hinweis vom System (z.B. „X wurde entfernt“) */
export interface ChatMessage {
  id: number;
  playerId: string | null;
  name: string;
  text: string;
  /** Serverzeit (ms) */
  at: number;
}

export type GameEvent =
  | { type: 'state'; state: LobbyState }
  | { type: 'submitted'; round: number; playerId: string }
  | { type: 'revealed'; reveal: RoundReveal }
  | { type: 'chat'; message: ChatMessage }
  /** beim Verbinden: die letzten Nachrichten */
  | { type: 'chatHistory'; messages: ChatMessage[] }
  /** vom Host entfernt – der betroffene Client verlässt die Lobby */
  | { type: 'kicked'; playerId: string }
  /** Lobby lange inaktiv: diese Spieler werden gefragt „Lobby behalten?“ (leer = Nachfrage erledigt) */
  | { type: 'idleCheck'; playerIds: string[]; deadline: number }
  /** Lobby geschlossen (Inaktivität oder vom Host) */
  | { type: 'closed'; reason: string };

// ---------------------------------------------------------------- API

export interface CreateGameRequest {
  playerName: string;
  mode?: GameMode;
  settings: Partial<GameSettings> | Partial<QuizSettings>;
}

export interface JoinResponse {
  /** öffentliche Spieler-ID */
  playerId: string;
  /** geheimer Token – berechtigt zu allen Aktionen dieses Spielers */
  token: string;
  state: LobbyState;
}

export interface SubmitRequest {
  token: string;
  legs: UserLeg[];
  guesses: Guesses | null;
}

export interface SubmitResponse {
  state: GameState;
  /** gesetzt, sobald alle Spieler abgegeben haben */
  reveal: RoundReveal | null;
}

// ---------------------------------------------------------------- Training (ohne Lobby, ohne Punkte)

export interface TrainingRound {
  id: string;
  from: StationRef;
  to: StationRef;
  when: string;
  settings: GameSettings;
  /** Top-Verbindungen – der Client nutzt sie für Coach-Hinweise, zeigt sie aber erst am Ende */
  routes: RouteOption[];
}

export interface TrainingResult {
  route: RouteOption | null;
  durationMin: number | null;
  matchedRank: number | null;
  error: string | null;
}

// ---------------------------------------------------------------- Accounts

export interface LevelInfo {
  level: number;
  xp: number;
  /** XP, ab denen das aktuelle bzw. nächste Level beginnt */
  levelXp: number;
  nextXp: number;
}

export interface MedalPublic {
  id: string;
  icon: string;
  title: string;
  text: string;
  /** Zeitpunkt (ms); null = noch nicht erreicht */
  at: number | null;
}

export interface FavoriteLine {
  id: string;
  mode: Mode;
  color: string;
  /** wie oft gefahren */
  count: number;
}

export interface FavoriteStation {
  id: string;
  name: string;
  count: number;
}

export interface AccountStats {
  games: number;
  wins: number;
  rounds: number;
  /** Ø Routenpunkte je Runde (0–1300) */
  avgRoute: number;
  bestRound: number;
  perfectRounds: number;
  beatApi: number;
  quizGames: number;
  quizWins: number;
  trainings: number;
  /** Minuten in Öffis (eigene Routen) */
  minutes: number;
  coursesDone: number;
  coursesMastered: number;
  /** Lieblingslinien je Verkehrsmittel – zählt mehr, wenn es an der Station Alternativen gab */
  favorites: { U: FavoriteLine | null; S: FavoriteLine | null; T: FavoriteLine | null; B: FavoriteLine | null };
  favoriteStation: FavoriteStation | null;
  recent: { kind: 'game' | 'quiz' | 'training'; at: number; points: number; rank: number | null; players: number | null }[];
}

export type Relation = 'self' | 'friend' | 'incoming' | 'outgoing' | null;

export interface UserListItem {
  name: string;
  level: number;
  online: boolean;
  relation: Relation;
}

export interface Profile {
  name: string;
  created: number;
  level: LevelInfo;
  online: boolean;
  relation: Relation;
  medals: MedalPublic[];
  /** nur für Freunde und sich selbst */
  stats: AccountStats | null;
}

export interface InvitePublic {
  id: number;
  from: string;
  code: string;
  mode: GameMode;
  at: number;
}

export interface Me {
  name: string;
  email: string | null;
  level: LevelInfo;
  medals: MedalPublic[];
  /** synchronisierter Spielstand aus dem Browser (Lernstand, Tutorial, Einstellungen …) */
  data: Record<string, unknown>;
  friendRequests: number;
  friendsOnline: string[];
  invites: InvitePublic[];
  /** darf die Admin-Seite sehen (vergeben nur über die Kommandozeile) */
  admin?: boolean;
}

// ---------------------------------------------------------------- Admin

export interface AdminUserRow {
  name: string;
  email: string | null;
  admin: boolean;
  created: number;
  lastSeen: number;
  online: boolean;
  level: number;
  games: number;
  sessions: number;
}

export interface AdminUserDetail extends AdminUserRow {
  xp: number;
  stats: AccountStats;
  medals: MedalPublic[];
  friends: string[];
  incoming: string[];
  outgoing: string[];
  /** synchronisierter Spielstand: Schlüssel → Größe in Bytes */
  data: Record<string, number>;
  invites: number;
}

export interface AdminLogEntry {
  at: number;
  admin: string;
  action: string;
  target: string | null;
  detail: string | null;
}

export interface AdminLobby {
  code: string;
  mode: GameMode;
  phase: string;
  /** „Runde 2/5“ bzw. „Frage 3/10“ */
  progress: string;
  /** Zeit gerade angehalten */
  paused: boolean;
  players: { id: string; name: string; account?: string; connected: boolean; host: boolean; score: number }[];
  chat: { name: string; text: string; at: number }[];
  createdAt: number;
  lastActivity: number;
}

export interface AdminOverview {
  version: string;
  uptimeSec: number;
  memoryMb: number;
  users: { total: number; online: number; new7d: number; admins: number; withEmail: number };
  lobbies: AdminLobby[];
  activeGames: number;
  mail: boolean;
  warnings: string[];
  timetable: { loaded: boolean; validUntil: string | null };
}

/** Stellschrauben der Routenberechnung (Standardwerte siehe server/overrides.ts) */
export interface RoutingParams {
  /** Umsteigen an derselben Haltestelle (min) */
  changeMin: number;
  /** Fußweg zu einer anderen Haltestelle höchstens (m) */
  transferWalkM: number;
  /** von/zu einer Adresse höchstens zu Fuß (m) */
  accessWalkM: number;
  /** ganz zu Fuß bis (m) */
  walkOnlyM: number;
  /** höchstens so viele Fahrten in einer Verbindung */
  maxRides: number;
  /** „Realistisch“: Anteil der Ø-Wartezeit an der ersten Haltestelle */
  firstWaitFactor: number;
}

/** Änderung an einer Linie im Referenzfahrplan – Stationen als Netz-IDs */
export type LineEdit =
  /** über die bisherige Endstation `at` hinaus weiterfahren: `stops` der Reihe nach, `min` = Fahrzeit ab dem vorigen Halt */
  | { kind: 'extend'; line: string; at: string; stops: { station: string; min: number }[] }
  /** bei `at` enden: den Teil Richtung `beyond` weglassen */
  | { kind: 'cut'; line: string; at: string; beyond: string }
  /** Fahrzeit zwischen zwei aufeinanderfolgenden Halten (beide Richtungen) */
  | { kind: 'time'; line: string; from: string; to: string; min: number };

export interface RoutingOverrides {
  params: Partial<RoutingParams>;
  edits: LineEdit[];
  updatedAt?: number;
  updatedBy?: string;
}

export interface RoutingAdminState {
  overrides: RoutingOverrides;
  defaults: RoutingParams;
  /** Ergebnis beim Anwenden: je Änderung, wie viele Fahrten/Haltefolgen betroffen waren, oder ein Fehler */
  report: string[];
}

export interface FriendsList {
  friends: UserListItem[];
  incoming: UserListItem[];
  outgoing: UserListItem[];
}
