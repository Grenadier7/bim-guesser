// Verwaltung aller Lobbys (Routenjagd und Quiz) über ihren Code
import type { GameMode } from '../shared/types.ts';
import { Game } from './game.ts';
import { GameError, type Lobby } from './lobby.ts';
import type { Network } from './network.ts';
import { QuizGame, quizNet } from './quiz.ts';

/** Gleichzeitig existierende Lobbys (schützt Speicher und die Wiener-Linien-API) */
const MAX_GAMES = 100;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class GameManager {
  private games = new Map<string, Lobby>();
  private net: Network;
  private qnet;

  constructor(net: Network) {
    this.net = net;
    this.qnet = quizNet(net);
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
  }

  create(mode: GameMode, settings: unknown): Lobby {
    if (this.games.size >= MAX_GAMES) {
      this.cleanup();
      if (this.games.size >= MAX_GAMES) throw new GameError('Server ist gerade voll – bitte später nochmal.', 503);
    }
    let code = '';
    do code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    while (this.games.has(code));
    const g = mode === 'quiz' ? new QuizGame(code, this.qnet, settings) : new Game(code, this.net, settings as never);
    this.games.set(code, g);
    return g;
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
