// Gemeinsame Lobby-Logik für alle Mehrspieler-Modi (Routenjagd, Quiz):
// Spieler mit geheimem Token, Host, Live-Verbindungen, Events.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AdminLobby, ChatMessage, GameEvent, GameMode, GamePhase, LobbyState, PlayerPublic } from '../shared/types.ts';
import { cleanChat, cleanName } from './security.ts';
import { ezPhrase, isEz } from './ez.ts';
import { isOffensive, moderate } from './moderation.ts';

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
/** Chat: so viele Nachrichten bleiben gespeichert, höchstens 5 je Spieler in 10 s */
const CHAT_KEEP = 50;
const CHAT_WINDOW_MS = 10_000;
const CHAT_MAX_PER_WINDOW = 5;
/** Inaktive Lobby: nach 9 min ohne Aktivität fragt der Server die Hosts, ob sie bleiben soll (30 s Zeit) */
export const IDLE_WARN_MS = Number(process.env.LOBBY_IDLE_MS) || 9 * 60_000;
export const IDLE_ANSWER_MS = Number(process.env.LOBBY_IDLE_ANSWER_MS) || 30_000;
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
  /** angemeldeter Account (für Statistik, Medaillen, Einladungen) */
  userId?: number;
  account?: string;
}

/** Account eines Spielers beim Erstellen/Beitreten */
export interface PlayerAccount {
  id: number;
  name: string;
}

/** Admin als „Host“: Aktionen der Admin-Seite laufen über dieselben Methoden wie die des Hosts */
const ADMIN: Player = { id: 'admin', token: '', name: 'Admin', score: 0, connections: 0, lastSeen: 0 };

export abstract class Lobby extends EventEmitter {
  /** Schlüssel für Host-Aktionen im Auftrag eines Admins – bleibt im Server (nie in einer Antwort) */
  readonly adminKey = randomBytes(24).toString('base64url');
  abstract readonly mode: GameMode;
  readonly id: string;
  phase: GamePhase = 'lobby';
  /** Hosts (mehrere möglich): dürfen Einstellungen ändern, starten, kicken, andere zum Host machen */
  protected hosts = new Set<string>();
  /** IP, von der die Lobby erstellt wurde (Limit je IP) */
  creatorIp = '';
  readonly createdAt = Date.now();
  /** war je ein Spieler live verbunden? (sonst darf die Lobby bei vollem Server zuerst Platz machen) */
  everConnected = false;
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

  // -------------------------------------------------------------- Chat

  private chat: ChatMessage[] = [];
  private chatSeq = 0;
  /** je Spieler die Zeitpunkte der letzten Nachrichten (gegen Fluten) */
  private chatTimes = new Map<string, number[]>();

  get chatHistory(): ChatMessage[] {
    return this.chat;
  }

  private post(playerId: string | null, name: string, text: string) {
    const message: ChatMessage = { id: ++this.chatSeq, playerId, name, text, at: Date.now() };
    this.chat.push(message);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.emitEvent({ type: 'chat', message });
  }

  say(token: string, raw: unknown): ChatMessage {
    const p = this.auth(token);
    // Chat-Moderation: gesperrte Wörter werden zu Sternchen; „/ez“ wird zu einem zufälligen Spruch
    const clean = cleanChat(raw);
    const text = isEz(clean) ? ezPhrase(this) : moderate(clean);
    if (!text) throw new GameError('Leere Nachricht.');
    const now = Date.now();
    const recent = (this.chatTimes.get(p.id) ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
    if (recent.length >= CHAT_MAX_PER_WINDOW) throw new GameError('Nicht so schnell – kurz warten.', 429);
    this.chatTimes.set(p.id, [...recent, now]);
    this.touch();
    this.post(p.id, p.name, text);
    return this.chat[this.chat.length - 1];
  }

  /** Host entfernt einen Spieler (auch mitten im Spiel – wie „Verlassen“) */
  kick(token: string, playerId: string) {
    const host = this.requireHost(token);
    const p = this.players.get(String(playerId));
    if (!p) throw new GameError('Diesen Spieler gibt es nicht (mehr).', 404);
    if (p.id === host.id) throw new GameError('Du kannst dich nicht selbst entfernen – nimm „Lobby verlassen“.');
    this.players.delete(p.id);
    this.byToken.delete(p.token);
    this.hosts.delete(p.id);
    this.emitEvent({ type: 'kicked', playerId: p.id });
    this.post(null, '', `${p.name} wurde ${host === ADMIN ? 'von der Spielleitung' : 'vom Host'} entfernt.`);
    this.touch();
    this.checkPresence();
  }

  /** Host macht einen Spieler zum (weiteren) Host oder nimmt ihm die Host-Rechte – mindestens ein Host bleibt */
  setHost(token: string, playerId: string, on: boolean) {
    this.requireHost(token);
    const p = this.players.get(String(playerId));
    if (!p) throw new GameError('Diesen Spieler gibt es nicht (mehr).', 404);
    if (on) this.hosts.add(p.id);
    else {
      if (this.hosts.has(p.id) && this.hosts.size === 1) throw new GameError('Es muss mindestens einen Host geben.');
      this.hosts.delete(p.id);
    }
    this.post(null, '', on ? `${p.name} ist jetzt Host.` : `${p.name} ist kein Host mehr.`);
    this.touch();
    this.emitState();
  }

  // -------------------------------------------------------------- Inaktivität

  /** laufende Nachfrage „Lobby behalten?“: wer gefragt wird und bis wann */
  private idle: { asked: Set<string>; deadline: number; timer: NodeJS.Timeout } | null = null;
  /** schon gefragt (und nicht geantwortet) – kommen nicht nochmal dran */
  private idleSkipped = new Set<string>();

  /** vom Manager regelmäßig aufgerufen; true = Lobby ist geschlossen und kann weg */
  closed = false;

  tickIdle(now = Date.now()) {
    if (this.closed || this.idle || this.phase === 'playing' || !this.players.size) return;
    if (now - this.lastActivity < IDLE_WARN_MS) return;
    this.idleSkipped.clear();
    this.askIdle([...this.hosts]);
  }

  private askIdle(ids: string[]) {
    const deadline = Date.now() + IDLE_ANSWER_MS;
    const timer = setTimeout(() => this.idleTimeout(), IDLE_ANSWER_MS);
    timer.unref?.();
    this.idle = { asked: new Set(ids), deadline, timer };
    this.emitEvent({ type: 'idleCheck', playerIds: ids, deadline });
  }

  /** niemand geantwortet: Gefragte verlieren den Host, der nächste Spieler wird Host und gefragt – sonst schließen */
  private idleTimeout() {
    if (!this.idle) return;
    for (const id of this.idle.asked) {
      this.hosts.delete(id);
      this.idleSkipped.add(id);
    }
    const next = [...this.players.values()].find((p) => !this.idleSkipped.has(p.id) && this.isConnected(p));
    this.idle = null;
    if (!next) return this.close('Die Lobby wurde wegen Inaktivität geschlossen.');
    this.hosts.add(next.id);
    this.post(null, '', `${next.name} ist jetzt Host (der bisherige Host hat nicht reagiert).`);
    this.emitState();
    this.askIdle([next.id]);
  }

  private clearIdle() {
    if (!this.idle) return;
    clearTimeout(this.idle.timer);
    this.idle = null;
    this.emitEvent({ type: 'idleCheck', playerIds: [], deadline: 0 });
  }

  /** Antwort auf die Nachfrage: behalten oder löschen */
  answerIdle(token: string, keep: boolean) {
    const p = this.auth(token);
    if (!this.hosts.has(p.id) && !this.idle?.asked.has(p.id)) throw new GameError('Nur der Host kann das.', 403);
    if (!keep) return this.close(`${p.name} hat die Lobby geschlossen.`);
    this.touch();
  }

  close(reason: string) {
    if (this.closed) return;
    if (this.idle) clearTimeout(this.idle.timer);
    this.idle = null;
    this.closed = true;
    this.emitEvent({ type: 'closed', reason });
    this.emit('closed');
  }

  addPlayer(name: unknown, account?: PlayerAccount | null): { id: string; token: string } {
    if (this.players.size >= MAX_PLAYERS) throw new GameError('Lobby ist voll.', 409);
    let id: string;
    do id = randomBytes(6).toString('base64url');
    while (this.players.has(id));
    const token = randomBytes(24).toString('base64url');
    let clean = cleanName(name) || `Spieler ${this.players.size + 1}`;
    if (isOffensive(clean)) throw new GameError('Dieser Name ist nicht erlaubt – bitte einen anderen wählen.');
    const taken = new Set([...this.players.values()].map((p) => p.name));
    for (let i = 2; taken.has(clean); i++) clean = `${clean.replace(/ \d+$/, '').slice(0, 17)} ${i}`;
    const player: Player = { id, token, name: clean, score: 0, connections: 0, lastSeen: Date.now(), userId: account?.id, account: account?.name };
    this.players.set(id, player);
    this.byToken.set(token, player);
    if (!this.hosts.size) this.hosts.add(id);
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

  /** für die Admin-Übersicht: wer ist drin, wie weit, was wird geschrieben? */
  adminInfo(): AdminLobby {
    const s = this.state() as unknown as {
      currentRound?: number;
      current?: number;
      pausedAt?: number | null;
      rounds?: { pausedAt: number | null }[];
      settings: { rounds?: number; questions?: number };
    };
    const paused = this.mode === 'quiz' ? !!s.pausedAt : !!s.rounds?.[s.currentRound ?? -1]?.pausedAt;
    const progress =
      this.phase === 'lobby' ? '' : this.mode === 'quiz' ? `Frage ${Math.max(0, s.current ?? 0) + 1}/${s.settings.questions}` : `Runde ${Math.max(0, s.currentRound ?? 0) + 1}/${s.settings.rounds}`;
    return {
      code: this.id,
      mode: this.mode,
      phase: this.phase,
      progress,
      paused,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.account ? { account: p.account } : {}),
        connected: p.connections > 0,
        host: this.hosts.has(p.id),
        score: p.score,
      })),
      chat: this.chat.slice(-30).map((m) => ({ name: m.name, text: m.text, at: m.at })),
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    };
  }

  /** Nachricht der Spielleitung in den Lobby-Chat */
  adminSay(raw: unknown) {
    const text = cleanChat(raw);
    if (!text) throw new GameError('Leere Nachricht.');
    this.post(null, '', `Spielleitung: ${text}`);
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
    if (token === this.adminKey) return ADMIN;
    const p = this.auth(token);
    if (!this.hosts.has(p.id)) throw new GameError('Nur der Host kann das.', 403);
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
      isHost: this.hosts.has(p.id),
      connected: this.isConnected(p),
      ...(p.account ? { account: p.account } : {}),
    }));
  }

  /** Spieler mit Account: Spieler-ID → Account-ID (für die Statistik) */
  accounts(): { playerId: string; userId: number; score: number }[] {
    return [...this.players.values()].filter((p) => p.userId != null).map((p) => ({ playerId: p.id, userId: p.userId!, score: p.score }));
  }

  /** Endstand: alle Spieler nach Punkten (für Rang und „Sieg“) */
  ranking(): { playerId: string; score: number }[] {
    return [...this.players.values()].map((p) => ({ playerId: p.id, score: p.score })).sort((a, b) => b.score - a.score);
  }

  /** Spiel ist aus – Accounts zählen es (Event 'finished') */
  protected finishGame() {
    this.phase = 'finished';
    this.emit('finished');
  }

  // -------------------------------------------------------------- Verbindungen

  /** Neue Live-Verbindung; false wenn zu viele offen sind */
  connect(token: string): boolean {
    const p = this.byToken.get(String(token));
    if (!p || p.connections >= MAX_STREAMS_PER_PLAYER) return false;
    p.connections++;
    this.everConnected = true;
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
    this.hosts.delete(p.id);
    this.checkPresence();
  }

  /** Host weitergeben (wenn kein Host mehr da/verbunden ist) und offene Runde auflösen, wenn nur noch Abwesende fehlen */
  protected checkPresence() {
    for (const id of this.hosts) if (!this.players.has(id)) this.hosts.delete(id);
    const hostOnline = [...this.hosts].some((id) => this.isConnected(this.players.get(id)!));
    if (!hostOnline) {
      const next = [...this.players.values()].find((p) => this.isConnected(p));
      if (next) {
        // getrennte Hosts geben ab – sonst könnte niemand starten
        this.hosts.clear();
        this.hosts.add(next.id);
      } else if (!this.hosts.size && this.players.size) this.hosts.add([...this.players.keys()][0]);
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
    this.clearIdle();
  }
}
