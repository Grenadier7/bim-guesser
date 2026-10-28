// Verwaltung aller Lobbys (Routenjagd und Quiz) über ihren Code
import type { GameMode } from '../shared/types.ts';
import { Game } from './game.ts';
import { GameError, IDLE_WARN_MS, type Lobby } from './lobby.ts';
import type { Network } from './network.ts';
import { QuizGame, quizNet } from './quiz.ts';
import { SCALE } from './security.ts';

/** Gleichzeitig existierende Lobbys (schützt Speicher und die Wiener-Linien-API) */
/** Eine ungestartete Lobby kostet kaum etwas (die Auskunft fragt erst der Spielstart, eigenes Rate-Limit) */
const MAX_GAMES = 500;
/**
 * offene Lobbys je IP – damit wenige Clients den Server nicht für alle füllen (Befund M-02). Nicht kleiner:
 * eine Schulklasse hinter einer gemeinsamen IP spielt sonst nicht jede/r allein.
 */
export const MAX_GAMES_PER_IP = 20 * SCALE;
/** Server voll: Lobbys, mit denen nie jemand verbunden war, machen nach 10 s Platz, verlassene nach 2 min */
const EVICT_NEVER_MS = 10_000;
const EVICT_IDLE_MS = 2 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class GameManager {
  private games = new Map<string, Lobby>();
  private net: Network;
  private qnet;

  constructor(net: Network) {
    this.net = net;
    this.qnet = quizNet(net);
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
    // inaktive Lobbys nachfragen lassen
    setInterval(() => {
      for (const g of this.games.values()) g.tickIdle();
    }, Math.min(10_000, IDLE_WARN_MS / 3)).unref();
  }

  create(mode: GameMode, settings: unknown, ip = ''): Lobby {
    const mine = [...this.games.values()].filter((g) => g.creatorIp === ip && ip);
    if (mine.length >= MAX_GAMES_PER_IP) throw new GameError(`Du hast schon ${MAX_GAMES_PER_IP} offene Lobbys – bitte eine davon nutzen oder kurz warten.`, 429);
    if (this.games.size >= MAX_GAMES) {
      this.cleanup();
      if (this.games.size >= MAX_GAMES) this.evictIdle();
      if (this.games.size >= MAX_GAMES) throw new GameError('Server ist gerade voll – bitte später nochmal.', 503);
    }
    let code = '';
    do code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    while (this.games.has(code));
    const g = mode === 'quiz' ? new QuizGame(code, this.qnet, settings) : new Game(code, this.net, settings as never);
    g.creatorIp = ip;
    // geschlossen (Inaktivität / vom Host) → weg damit
    g.once('closed', () => {
      g.removeAllListeners();
      this.games.delete(code);
    });
    this.games.set(code, g);
    return g;
  }

  /** Server voll: die älteste Lobby ohne verbundene Spieler (noch nicht gestartet) räumt den Platz */
  private evictIdle() {
    const cutoff = Date.now() - EVICT_IDLE_MS;
    const now = Date.now();
    const idle = [...this.games.entries()]
      .filter(([, g]) => g.phase === 'lobby' && !g.hasConnections && (g.everConnected ? g.lastActivity < cutoff : g.createdAt < now - EVICT_NEVER_MS))
      .sort(([, a], [, b]) => Number(a.everConnected) - Number(b.everConnected) || a.lastActivity - b.lastActivity)[0];
    if (!idle) return;
    idle[1].removeAllListeners();
    this.games.delete(idle[0]);
  }

  has(code: string): boolean {
    return this.games.has(String(code).trim().toUpperCase());
  }

  get(code: string): Lobby {
    const g = this.games.get(String(code).trim().toUpperCase());
    if (!g) throw new GameError('Lobby nicht gefunden – Code prüfen.', 404);
    return g;
  }

  /** Laufende Spiele mit verbundenen Spielern – ein Update wartet, bis das 0 ist */
  activeGames(): number {
    let n = 0;
    for (const g of this.games.values()) if (g.phase === 'playing' && g.hasConnections) n++;
    return n;
  }

  get lobbyCount(): number {
    return this.games.size;
  }

  private cleanup() {
    const cutoff = Date.now() - 3 * 3600 * 1000;
    const idleLobby = Date.now() - 20 * 60 * 1000;
    for (const [id, g] of this.games)
      if (g.lastActivity < cutoff || g.playerCount === 0 || (g.phase === 'lobby' && g.lastActivity < idleLobby && !g.hasConnections)) {
        g.removeAllListeners();
        this.games.delete(id);
      }
  }
}
