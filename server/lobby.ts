// Gemeinsame Lobby-Logik für alle Mehrspieler-Modi (Routenjagd, Quiz):
// Spieler mit geheimem Token, Host, Live-Verbindungen, Events.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { GameEvent, GameMode, GamePhase, LobbyState, PlayerPublic } from '../shared/types.ts';
import { cleanName } from './security.ts';

export class GameError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_PLAYERS = 12;
/** Live-Verbindungen pro Spieler (mehrere Tabs) */
const MAX_STREAMS_PER_PLAYER = 3;
/** Ohne offene Verbindung gilt ein Spieler danach als weg */
const DISCONNECT_AFTER_MS = 15000;
/** Kulanz nach Ablauf des Zeitlimits (Netzwerk-Latenz) */
export const DEADLINE_GRACE_MS = 3000;

export interface Player {
  /** öffentlich – sehen alle Mitspieler */
  id: string;
  /** geheim – nur der Spieler selbst kennt ihn, berechtigt zu allen Aktionen */
  token: string;
  name: string;
  score: number;
  connections: number;
  lastSeen: number;
}

export abstract class Lobby extends EventEmitter {
  abstract readonly mode: GameMode;
  readonly id: string;
  phase: GamePhase = 'lobby';
  hostId = '';
  lastActivity = Date.now();
  protected players = new Map<string, Player>();
  protected byToken = new Map<string, Player>();

  constructor(id: string) {
    super();
    this.setMaxListeners(50);
    this.id = id;
  }

  // -------------------------------------------------------------- je Modus

  abstract state(): LobbyState;
  abstract updateSettings(token: string, s: unknown): void;
  abstract start(token: string): Promise<void>;
  abstract next(token: string): Promise<void>;
  abstract backToLobby(token: string): void;
  abstract pause(token: string): void;
  abstract resume(token: string): void;
  abstract cancelRound(token: string): void;
  /** Ein Spieler ist weg/gegangen – evtl. offene Runde auflösen */
  protected abstract onPresenceChange(): void;

  // -------------------------------------------------------------- Spieler

  addPlayer(name: unknown): { id: string; token: string } {
    if (this.players.size >= MAX_PLAYERS) throw new GameError('Lobby ist voll.', 409);
    let id: string;
    do id = randomBytes(6).toString('base64url');
    while (this.players.has(id));
    const token = randomBytes(24).toString('base64url');
    let clean = cleanName(name) || `Spieler ${this.players.size + 1}`;
    const taken = new Set([...this.players.values()].map((p) => p.name));
    for (let i = 2; taken.has(clean); i++) clean = `${clean.replace(/ \d+$/, '').slice(0, 17)} ${i}`;
    const player: Player = { id, token, name: clean, score: 0, connections: 0, lastSeen: Date.now() };
    this.players.set(id, player);
    this.byToken.set(token, player);
    if (!this.hostId) this.hostId = id;
    this.touch();
    this.emitState();
    return { id, token };
  }

  /** Gehört der Token zu einem Spieler dieser Lobby? */
  isMember(token: string): boolean {
    return this.byToken.has(String(token));
  }

  /** Öffentliche ID zum Token (für die eigene Anzeige im Client) */
  playerIdFor(token: string): string {
    return this.auth(token).id;
  }

  get playerCount(): number {
    return this.players.size;
  }

  get hasConnections(): boolean {
    return [...this.players.values()].some((p) => p.connections > 0);
  }

  protected auth(token: string): Player {
    const p = this.byToken.get(String(token));
    if (!p) throw new GameError('Du bist nicht (mehr) in dieser Lobby.', 403);
    return p;
  }

  protected requireHost(token: string): Player {
    const p = this.auth(token);
    if (p.id !== this.hostId) throw new GameError('Nur der Host kann das.', 403);
    return p;
  }

  protected isConnected(p: Player): boolean {
    return p.connections > 0 || Date.now() - p.lastSeen < DISCONNECT_AFTER_MS;
  }

  protected playersPublic(): PlayerPublic[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      isHost: p.id === this.hostId,
      connected: this.isConnected(p),
    }));
  }

  // -------------------------------------------------------------- Verbindungen

  /** Neue Live-Verbindung; false wenn zu viele offen sind */
  connect(token: string): boolean {
    const p = this.byToken.get(String(token));
    if (!p || p.connections >= MAX_STREAMS_PER_PLAYER) return false;
    p.connections++;
    p.lastSeen = Date.now();
    this.emitState();
    return true;
  }

  disconnect(token: string) {
    const p = this.byToken.get(String(token));
    if (!p) return;
    p.connections = Math.max(0, p.connections - 1);
    p.lastSeen = Date.now();
    setTimeout(() => this.checkPresence(), DISCONNECT_AFTER_MS + 500).unref();
  }

  leave(token: string) {
    const p = this.byToken.get(String(token));
    if (!p) return;
    this.players.delete(p.id);
    this.byToken.delete(p.token);
    this.checkPresence();
  }

  /** Host weitergeben und offene Runde auflösen, wenn nur noch Abwesende fehlen */
  protected checkPresence() {
    const host = this.players.get(this.hostId);
    if (!host || !this.isConnected(host)) {
      const next = [...this.players.values()].find((p) => this.isConnected(p));
      if (next) this.hostId = next.id;
      else if (!host) this.hostId = [...this.players.keys()][0] ?? '';
    }
    this.onPresenceChange();
    this.emitState();
  }

  // -------------------------------------------------------------- Events

  protected emitEvent(e: GameEvent) {
    this.emit('event', e);
  }

  protected emitState() {
    this.emitEvent({ type: 'state', state: this.state() });
  }

  protected touch() {
    this.lastActivity = Date.now();
  }
}
