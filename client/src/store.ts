// App-Zustand: Sitzung (Lobby-Code + Spieler-ID), Spielzustand und Live-Verbindung (SSE).
import type { PublicConfig } from '../../shared/config.ts';
import type { GameEvent, GameSettings, GameState, LobbyState, PlayerPublic, QuizState, RoundPublic, RoundReveal } from '../../shared/types.ts';
import type { QuizSettings } from '../../shared/quiz.ts';
import { TIME_LIMITS } from '../../shared/rules.ts';
import { NOT_REMEMBERED } from '../../shared/defaults.ts';
import { api } from './api.ts';
import type { GameMap } from './map.ts';
import type { NetIndex } from './net.ts';
import { loadMerged, saveJson } from './storage.ts';

export interface Session {
  code: string;
  /** öffentliche ID (zum Erkennen des eigenen Spielers) */
  playerId: string;
  /** geheimer Token – wird nie an andere Spieler gesendet */
  token: string;
}

interface Prefs {
  name: string;
  /** zuletzt verwendete Einstellungen der Routenjagd */
  settings: Partial<GameSettings>;
  /** zuletzt verwendete Quiz-Einstellungen */
  quiz: Partial<QuizSettings>;
}

const SESSION_KEY = 'oeffi-guesser-session';
const PREFS_KEY = 'oeffi-guesser-prefs-v2';

/** Spielsitzung je Tab (sessionStorage) */
const tabStore = () => sessionStorage;

export const app = {
  net: null as unknown as NetIndex,
  /** Netzplan, zu dem app.net gehört ('regular' = Standard) */
  netPlan: 'regular',
  /** Spiel-Konfiguration vom Server (Hinweis für alle …) */
  config: null as PublicConfig | null,
  map: null as unknown as GameMap,
  session: null as Session | null,
  state: null as LobbyState | null,
  /** Serverzeit − lokale Zeit (ms) */
  clockOffset: 0,
  reveals: new Map<number, RoundReveal>(),
  /** Bildschirm außerhalb einer Lobby */
  view: 'home' as 'home' | 'learn' | 'training' | 'tutorial' | 'admin',
  prefs: loadMerged<Prefs>(PREFS_KEY, { name: '', settings: {}, quiz: {} }),
  onChange: () => {},
  /** Chat-Nachrichten und Verlauf (vom Chat-Fenster gesetzt) */
  onChat: (_e: Extract<GameEvent, { type: 'chat' | 'chatHistory' }>) => {},
  /** vom Host entfernt (main.ts zeigt eine Meldung) */
  onKicked: () => {},
  /** „Lobby behalten?“-Nachfrage (idle.ts) */
  onIdle: (_ids: string[], _deadline: number) => {},
  /** Lobby geschlossen (Inaktivität / Host) */
  onClosed: (_reason: string) => {},
};

// gespeicherte Zeitlimits, die es nicht mehr gibt (z.B. altes 1:30), verwerfen
{
  const t = app.prefs.settings.roundTimeLimitSec;
  if (t != null && !TIME_LIMITS.includes(t)) delete app.prefs.settings.roundTimeLimitSec;
  // Netz (Aktuell) und Fokus-Kreis starten immer mit dem Standard
  for (const k of NOT_REMEMBERED) delete app.prefs.settings[k];
  // Schnellwahl gespeichert? Dann bestimmt sie die Regler (die Stufen können sich geändert haben)
  const ps = app.prefs.settings;
  if (ps.difficulty && ps.difficulty !== 'custom') {
    delete ps.stations;
    delete ps.distance;
    delete ps.minTransfers;
    delete (ps as { needTransfer?: unknown }).needTransfer;
  }
}

export function savePrefs() {
  saveJson(PREFS_KEY, app.prefs);
}

export const serverNow = () => Date.now() + app.clockOffset;

/** Handy: Karte ganz ausblenden (Start, Lobby, Lern-Einstellungen) */
export function setMobileMap(visible: boolean) {
  if (document.body.classList.contains('no-map') === !visible) return;
  document.body.classList.toggle('no-map', !visible);
  if (visible) setTimeout(() => app.map.invalidate(true), 50);
}

/** Handy: Karte groß (z.B. zum Orten) oder klein */
export function setMapBig(big: boolean) {
  if (document.body.classList.contains('map-big') === big) return;
  document.body.classList.toggle('map-big', big);
  setTimeout(() => app.map.invalidate(true), 250);
}

export function me(): PlayerPublic | undefined {
  return app.state?.players.find((p) => p.id === app.session?.playerId);
}

export function isHost(): boolean {
  return !!me()?.isHost;
}

/** Zustand als Routenjagd (wirft nicht – Bildschirme werden nur im passenden Modus geöffnet) */
export const routeState = () => app.state as GameState;
export const quizState = () => app.state as QuizState;


export function currentRound(): RoundPublic | null {
  const s = app.state;
  if (!s || s.mode !== 'route') return null;
  return s.currentRound >= 0 ? (s.rounds[s.currentRound] ?? null) : null;
}

/** Offene Runde/Frage mit Zeitlimit – für Countdown, Pause und Host-Knöpfe (beide Modi) */
export function openTimer(): { deadline: number | null; pausedAt: number | null } | null {
  const s = app.state;
  if (!s || s.phase !== 'playing') return null;
  if (s.mode === 'quiz') return s.status === 'open' ? { deadline: s.deadline, pausedAt: s.pausedAt } : null;
  const r = currentRound();
  return r?.status === 'open' ? { deadline: r.deadline, pausedAt: r.pausedAt } : null;
}

export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}?code=${code}`;
}

// ---------------------------------------------------------------- Sitzung & Live-Verbindung

let es: EventSource | null = null;
let checking = false;

export function setState(s: LobbyState) {
  app.clockOffset = s.serverNow - Date.now();
  // veraltete Auflösungen verwerfen (z.B. nach "Zurück zur Lobby")
  if (s.phase === 'lobby') app.reveals.clear();
  app.state = s;
  app.onChange();
}

export function startSession(session: Session, state: LobbyState) {
  app.session = session;
  saveJson(SESSION_KEY, session, tabStore);
  history.replaceState(null, '', `?code=${session.code}`);
  setState(state);
  connect();
}

export function endSession() {
  es?.close();
  es = null;
  app.session = null;
  app.state = null;
  app.reveals.clear();
  saveJson(SESSION_KEY, null, tabStore);
  history.replaceState(null, '', location.pathname);
  app.onChange();
}

/** Nach Neuladen der Seite wieder in die Lobby einsteigen */
export async function restoreSession(): Promise<boolean> {
  const saved = loadMerged<Partial<Session>>(SESSION_KEY, {}, tabStore);
  if (!saved.code || !saved.token) return false;
  // Einladungslink zu einer ANDEREN Lobby geöffnet → nicht in die alte zurück, sondern beitreten lassen
  const linkCode = new URLSearchParams(location.search).get('code')?.toUpperCase();
  if (linkCode && linkCode !== saved.code) {
    saveJson(SESSION_KEY, null, tabStore);
    return false;
  }
  try {
    const res = await api.state({ code: saved.code, token: saved.token });
    startSession({ code: saved.code, token: saved.token, playerId: res.playerId }, res.state);
    return true;
  } catch {
    saveJson(SESSION_KEY, null, tabStore);
    return false;
  }
}

function connect() {
  es?.close();
  const auth = app.session!;
  es = new EventSource(api.eventsUrl(auth));
  es.onmessage = (m) => {
    const e = JSON.parse(m.data) as GameEvent;
    if (e.type === 'state') setState(e.state);
    if (e.type === 'chat' || e.type === 'chatHistory') app.onChat(e);
    if (e.type === 'kicked' && e.playerId === app.session?.playerId) {
      endSession();
      app.onKicked();
    }
    if (e.type === 'idleCheck') app.onIdle(e.playerIds, e.deadline);
    if (e.type === 'closed') {
      endSession();
      app.onClosed(e.reason);
    }
    if (e.type === 'revealed') {
      app.reveals.set(e.reveal.index, e.reveal);
      app.onChange();
    }
  };
  es.onerror = async () => {
    // EventSource verbindet sich selbst neu – prüfen, ob es die Lobby/den Spieler noch gibt
    if (checking || !app.session) return;
    checking = true;
    try {
      await api.state(auth);
      if (es?.readyState === EventSource.CLOSED) connect();
    } catch (err) {
      // 403: nicht mehr in der Lobby, 404: Lobby existiert nicht mehr
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) endSession();
    } finally {
      checking = false;
    }
  };
}

export async function getReveal(index: number): Promise<RoundReveal> {
  const hit = app.reveals.get(index);
  if (hit) return hit;
  const r = await api.reveal(app.session!, index);
  app.reveals.set(index, r);
  return r;
}
