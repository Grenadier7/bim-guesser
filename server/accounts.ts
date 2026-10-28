// Accounts: Benutzer, Sitzungen („angemeldet bleiben“), Passwort-Reset per E-Mail, Freunde, Einladungen in Lobbys,
// Statistik (Level/XP, Lieblingslinien, Medaillen) und der synchronisierte Spielstand aus dem Browser.
//
// Speicher: SQLite (node:sqlite) in STATE_DIR/accounts.db. Passwörter mit Argon2id (node:crypto), Sitzungs- und
// Reset-Tokens nur als SHA-256 gespeichert – ein geleakter DB-Inhalt erlaubt keine Anmeldung.
import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AccountStats,
  FavoriteLine,
  FriendsList,
  GameMode,
  InvitePublic,
  LevelInfo,
  Me,
  MedalPublic,
  Mode,
  Profile,
  QuizAnswerResult,
  Relation,
  RoundReveal,
  TrainingResult,
  UserLeg,
  UserListItem,
} from '../shared/types.ts';
import { isSpecialLine } from '../shared/rules.ts';
import { MONOTONE_KEYS, mergeProgress } from '../shared/progress.ts';
import { GameError, type Lobby } from './lobby.ts';
import type { Network } from './network.ts';
import { STATE_DIR } from './paths.ts';

// ---------------------------------------------------------------- Regeln

export const SESSION_DAYS = 180;
const DAY = 86_400_000;
const RESET_MS = 60 * 60_000;
/** online = in den letzten 2 Minuten etwas vom Server geholt (der Client fragt alle 20 s) */
const ONLINE_MS = 2 * 60_000;
/** Einladungen gelten, solange die Lobby besteht – höchstens 2 Stunden */
const INVITE_MS = 2 * 3600_000;
/** synchronisierter Spielstand: höchstens so groß (Lernstand, Einstellungen …) */
const DATA_MAX = 200_000;
const NAME_RE = /^[\p{L}\d_.-]{3,20}$/u;

const COURSES_KEY = 'oeffi-courses-v1';
const PROGRESS_KEY = 'oeffi-progress-v1';

/** XP bis zum nächsten Level: 100, 150, 200, … */
export function levelOf(xp: number): LevelInfo {
  let level = 1;
  let start = 0;
  for (let need = 100; xp >= start + need; need += 50) {
    start += need;
    level++;
  }
  return { level, xp, levelXp: start, nextXp: start + 100 + 50 * (level - 1) };
}

const MEDALS: { id: string; icon: string; title: string; text: string }[] = [
  { id: 'first-game', icon: '🎟', title: 'Erstes Spiel', text: 'Eine Routenjagd zu Ende gespielt' },
  { id: 'games-10', icon: '🎫', title: 'Stammgast', text: '10 Routenjagden gespielt' },
  { id: 'games-50', icon: '🏟', title: 'Dauerkarte', text: '50 Routenjagden gespielt' },
  { id: 'perfect', icon: '🎯', title: 'Volltreffer', text: 'Eine Runde so schnell wie die beste Verbindung (1000 Routenpunkte)' },
  { id: 'beat-api', icon: '🧠', title: 'Schlauer als die Auskunft', text: 'Eine schnellere Route als die beste der Auskunft gefunden' },
  { id: 'max-route', icon: '💎', title: 'Volle 1300', text: 'Alle 1300 Routenpunkte in einer Runde' },
  { id: 'winner', icon: '🏆', title: 'Sieger', text: 'Eine Routenjagd gegen andere gewonnen' },
  { id: 'quiz-ace', icon: '🥇', title: 'Quiz-Ass', text: 'Ein Quiz ohne einen Fehler' },
  { id: 'trainer', icon: '🏋', title: 'Trainingsfleißig', text: '25 Trainingsstrecken' },
  { id: 'tutorial', icon: '🎓', title: 'Angekommen', text: 'Tutorial geschafft' },
  { id: 'all-courses', icon: '📚', title: 'Netzkenner', text: 'Alle Kurse im Lernpfad gemacht' },
  { id: 'master', icon: '⭐', title: 'Netzmeister', text: 'Alle Kurse gemeistert (Prüfung bestanden)' },
  { id: 'friends-3', icon: '🤝', title: 'Gesellig', text: '3 Freunde' },
  { id: 'level-10', icon: '🚀', title: 'Level 10', text: 'Level 10 erreicht' },
];

// ---------------------------------------------------------------- Passwörter & Tokens

const ARGON = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };

function argon(password: string, salt: Buffer, p = ARGON): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, ...p }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await argon(password, salt);
  return `argon2id$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
  if (!m) return false;
  const want = Buffer.from(m[5], 'base64');
  const got = await argon(password, Buffer.from(m[4], 'base64'), { memory: +m[1], passes: +m[2], parallelism: +m[3], tagLength: want.length });
  return got.length === want.length && timingSafeEqual(got, want);
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------- Datenbank

interface UserRow {
  id: number;
  name: string;
  email: string | null;
  pw: string;
  created: number;
  last_seen: number;
  game_xp: number;
  data: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT COLLATE NOCASE,
  pw TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  game_xp INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS users_email ON users(email);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS resets (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS friends (
  a INTEGER NOT NULL, b INTEGER NOT NULL, requester INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, code TEXT NOT NULL, mode TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS invites_to ON invites(to_id);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0, route INTEGER, rank INTEGER, players INTEGER, minutes INTEGER, extra TEXT
);
CREATE INDEX IF NOT EXISTS results_user ON results(user_id, kind);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, key)
);
CREATE TABLE IF NOT EXISTS medals (user_id INTEGER NOT NULL, medal TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, medal));
`;

export interface AccountUser {
  id: number;
  name: string;
}

export interface AccountsOptions {
  /** Pfad der Datenbank; ':memory:' für Tests. Standard: STATE_DIR/accounts.db (oder ACCOUNTS_DB) */
  file?: string;
  /** Mail verschicken (Passwort-Reset) */
  mail?: (to: string, subject: string, text: string) => Promise<void>;
}

export class Accounts {
  private db: DatabaseSync;
  private net: Network;
  readonly mail: AccountsOptions['mail'];
  /** Quiz: richtige Antworten je Lobby und Spieler (bis zum Spielende) */
  private quizTally = new WeakMap<Lobby, Map<string, { right: number; asked: number }>>();
  /** Training: jede Strecke zählt je Account nur einmal */
  private trainingSeen = new Map<string, number>();

  constructor(net: Network, opts: AccountsOptions = {}) {
    this.net = net;
    this.mail = opts.mail;
    const file = opts.file ?? process.env.ACCOUNTS_DB ?? path.join(STATE_DIR, 'accounts.db');
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.cleanup();
  }

  close() {
    this.db.close();
  }

  /** abgelaufene Sitzungen, Reset-Links und Einladungen löschen */
  cleanup() {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
    this.db.prepare('DELETE FROM resets WHERE expires < ?').run(now);
    this.db.prepare('DELETE FROM invites WHERE created < ?').run(now - INVITE_MS);
    for (const [k, t] of this.trainingSeen) if (now - t > DAY) this.trainingSeen.delete(k);
  }

  private row(id: number): UserRow {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!u) throw new GameError('Account nicht gefunden.', 404);
    return u;
  }

  private exists(id: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
  }

  private byName(name: string): UserRow {
    const u = this.db.prepare('SELECT * FROM users WHERE name = ?').get(String(name ?? '').trim()) as UserRow | undefined;
    if (!u) throw new GameError('Diesen Account gibt es nicht.', 404);
    return u;
  }

  // -------------------------------------------------------------- Registrieren, Anmelden, Sitzungen

  async register(name: unknown, password: unknown, email: unknown): Promise<{ user: AccountUser; token: string }> {
    const n = String(name ?? '').trim();
    const pw = String(password ?? '');
    const mail = cleanEmail(email);
    if (!NAME_RE.test(n)) throw new GameError('Benutzername: 3–20 Zeichen, nur Buchstaben, Ziffern und _ . -');
    if (pw.length < 8 || pw.length > 200) throw new GameError('Passwort: mindestens 8 Zeichen.');
    if (mail === undefined) throw new GameError('Diese E-Mail-Adresse sieht nicht gültig aus.');
    if (this.db.prepare('SELECT 1 FROM users WHERE name = ?').get(n)) throw new GameError('Diesen Benutzernamen gibt es schon.', 409);
    const hash = await hashPassword(pw);
    const now = Date.now();
    let id: number;
    try {
      id = Number(this.db.prepare('INSERT INTO users (name, email, pw, created, last_seen) VALUES (?, ?, ?, ?, ?)').run(n, mail, hash, now, now).lastInsertRowid);
    } catch {
      throw new GameError('Diesen Benutzernamen gibt es schon.', 409);
    }
    return { user: { id, name: n }, token: this.createSession(id) };
  }

  async login(name: unknown, password: unknown): Promise<{ user: AccountUser; token: string }> {
    const n = String(name ?? '').trim();
    const pw = String(password ?? '');
    // Name oder E-Mail
    const u = (this.db.prepare('SELECT * FROM users WHERE name = ? OR (email = ? AND email IS NOT NULL) ORDER BY name = ? DESC LIMIT 1').get(n, n, n) ?? null) as UserRow | null;
    // auch ohne Account gleich lange rechnen – sonst verrät die Antwortzeit, ob es den Namen gibt
    const ok = u ? await verifyPassword(pw, u.pw) : (await hashPassword(pw), false);
    if (!u || !ok) throw new GameError('Benutzername oder Passwort stimmt nicht.', 401);
    return { user: { id: u.id, name: u.name }, token: this.createSession(u.id) };
  }

  createSession(userId: number): string {
    const t = newToken();
    this.db.prepare('INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)').run(sha(t), userId, Date.now() + SESSION_DAYS * DAY);
    return t;
  }

  /** Account zur Sitzung (oder null); verlängert die Sitzung höchstens einmal am Tag */
  userFor(token: string | null | undefined): AccountUser | null {
    if (!token) return null;
    const s = this.db.prepare('SELECT s.user_id AS id, s.expires AS expires, u.name AS name, u.last_seen AS seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?').get(sha(token)) as
      | { id: number; expires: number; name: string; seen: number }
      | undefined;
    const now = Date.now();
    if (!s || s.expires < now) return null;
    if (s.expires - now < (SESSION_DAYS - 1) * DAY) this.db.prepare('UPDATE sessions SET expires = ? WHERE hash = ?').run(now + SESSION_DAYS * DAY, sha(token));
    if (now - s.seen > 15_000) this.db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, s.id);
    return { id: s.id, name: s.name };
  }

  logout(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha(token));
  }

  async changePassword(userId: number, oldPw: unknown, newPw: unknown, keepToken: string) {
    const u = this.row(userId);
    if (!(await verifyPassword(String(oldPw ?? ''), u.pw))) throw new GameError('Das bisherige Passwort stimmt nicht.', 401);
    const pw = String(newPw ?? '');
    if (pw.length < 8 || pw.length > 200) throw new GameError('Passwort: mindestens 8 Zeichen.');
    this.db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(await hashPassword(pw), userId);
    // andere Geräte abmelden
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND hash != ?').run(userId, sha(keepToken));
  }

  setEmail(userId: number, email: unknown) {
    const mail = cleanEmail(email);
    if (mail === undefined) throw new GameError('Diese E-Mail-Adresse sieht nicht gültig aus.');
    this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(mail, userId);
  }

  // -------------------------------------------------------------- Passwort vergessen

  /** Reset-Link per Mail; antwortet immer gleich (verrät nicht, ob es die Adresse gibt) */
  async forgot(email: unknown, baseUrl: string): Promise<void> {
    const mail = cleanEmail(email);
    if (!mail) return;
    const users = this.db.prepare('SELECT * FROM users WHERE email = ?').all(mail) as unknown as UserRow[];
    if (!users.length || !this.mail) {
      if (users.length) console.warn('Passwort-Reset angefragt, aber kein Mailversand eingerichtet (SMTP_URL).');
      return;
    }
    const links: string[] = [];
    for (const u of users) {
      const t = newToken();
      this.db.prepare('INSERT INTO resets (hash, user_id, expires) VALUES (?, ?, ?)').run(sha(t), u.id, Date.now() + RESET_MS);
      links.push(`${u.name}: ${baseUrl}/?reset=${t}`);
    }
    await this.mail(
      mail,
      'BimGuesser – Passwort zurücksetzen',
      `Hallo!\n\nJemand (hoffentlich du) möchte das Passwort für BimGuesser zurücksetzen. Der Link gilt 1 Stunde:\n\n${links.join('\n')}\n\nWarst du das nicht? Dann einfach ignorieren – dein Passwort bleibt, wie es ist.\n`,
    );
  }

  async reset(token: unknown, password: unknown): Promise<{ user: AccountUser; token: string }> {
    const t = String(token ?? '');
    const r = this.db.prepare('SELECT user_id, expires FROM resets WHERE hash = ?').get(sha(t)) as { user_id: number; expires: number } | undefined;
    if (!r || r.expires < Date.now()) throw new GameError('Der Link ist abgelaufen oder wurde schon benutzt – bitte neu anfordern.', 400);
    const pw = String(password ?? '');
    if (pw.length < 8 || pw.length > 200) throw new GameError('Passwort: mindestens 8 Zeichen.');
    this.db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(await hashPassword(pw), r.user_id);
    this.db.prepare('DELETE FROM resets WHERE user_id = ?').run(r.user_id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id);
    const u = this.row(r.user_id);
    return { user: { id: u.id, name: u.name }, token: this.createSession(u.id) };
  }

  // -------------------------------------------------------------- Spielstand aus dem Browser

  /** Schlüssel/Werte übernehmen (null löscht); Grenze für die Gesamtgröße */
  saveData(userId: number, patch: unknown) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new GameError('Ungültige Daten');
    const data = this.data(userId);
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (!/^oeffi-[a-z0-9-]{1,40}$/.test(k)) continue;
      // Kurse/Tutorial: nie zurück – ein zweites Gerät mit älterem Stand überschreibt nichts
      if (MONOTONE_KEYS.includes(k)) data[k] = v == null ? data[k] : mergeProgress(data[k], v);
      else if (v == null) delete data[k];
      else data[k] = v;
    }
    const json = JSON.stringify(data);
    if (json.length > DATA_MAX) throw new GameError('Zu viele Daten.', 413);
    this.db.prepare('UPDATE users SET data = ? WHERE id = ?').run(json, userId);
    this.checkMedals(userId);
  }

  private data(userId: number): Record<string, unknown> {
    try {
      const d = JSON.parse(this.row(userId).data);
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  }

  /** Kurse aus dem synchronisierten Lernstand */
  private courses(userId: number): { done: number; mastered: number; total: number } {
    const c = this.data(userId)[COURSES_KEY];
    const list = c && typeof c === 'object' ? Object.values(c as Record<string, { done?: boolean; mastered?: boolean }>) : [];
    return { done: list.filter((x) => x?.done).length, mastered: list.filter((x) => x?.mastered).length, total: COURSE_COUNT };
  }

  private tutorialDone(userId: number): boolean {
    const p = this.data(userId)[PROGRESS_KEY] as { tutorialDone?: boolean } | undefined;
    return !!p?.tutorialDone;
  }

  // -------------------------------------------------------------- Level, Medaillen

  level(userId: number): LevelInfo {
    const u = this.row(userId);
    const c = this.courses(userId);
    // Lernen zählt auch: Kurs geschafft 40, gemeistert +60, Tutorial 50
    return levelOf(u.game_xp + c.done * 40 + c.mastered * 60 + (this.tutorialDone(userId) ? 50 : 0));
  }

  private addXp(userId: number, xp: number) {
    if (xp > 0) this.db.prepare('UPDATE users SET game_xp = game_xp + ? WHERE id = ?').run(Math.round(xp), userId);
  }

  medals(userId: number): MedalPublic[] {
    const got = new Map((this.db.prepare('SELECT medal, at FROM medals WHERE user_id = ?').all(userId) as { medal: string; at: number }[]).map((m) => [m.medal, m.at]));
    return MEDALS.map((m) => ({ ...m, at: got.get(m.id) ?? null }));
  }

  /** neu erreichte Medaillen eintragen */
  checkMedals(userId: number) {
    const count = (sql: string) => Number((this.db.prepare(sql).get(userId) as { n: number }).n);
    const games = count("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND kind = 'game'");
    const c = this.courses(userId);
    const reached: Record<string, boolean> = {
      'first-game': games >= 1,
      'games-10': games >= 10,
      'games-50': games >= 50,
      perfect: count("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND kind = 'round' AND route >= 1000") > 0,
      'beat-api': count("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND kind = 'round' AND route > 1000") > 0,
      'max-route': count("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND kind = 'round' AND route >= 1300") > 0,
      winner: count("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND kind = 'game' AND rank = 1 AND players >= 2") > 0,
      'quiz-ace': count("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND kind = 'quiz' AND extra = 'ace'") > 0,
      trainer: count("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND kind = 'training'") >= 25,
      tutorial: this.tutorialDone(userId),
      'all-courses': c.done >= c.total,
      master: c.mastered >= c.total,
      'friends-3': count('SELECT COUNT(*) AS n FROM friends WHERE (a = ?1 OR b = ?1) AND accepted = 1') >= 3,
      'level-10': this.level(userId).level >= 10,
    };
    const ins = this.db.prepare('INSERT OR IGNORE INTO medals (user_id, medal, at) VALUES (?, ?, ?)');
    for (const [id, ok] of Object.entries(reached)) if (ok) ins.run(userId, id, Date.now());
  }

  // -------------------------------------------------------------- Statistik aus Spielen

  /** Lobby beobachten: Runden und Spielende den angemeldeten Spielern gutschreiben */
  watch(g: Lobby) {
    // Statistik darf nie ein Spiel stören: Fehler nur loggen (die Events kommen mitten aus der Auflösung)
    const safe =
      <A extends unknown[]>(fn: (...a: A) => void) =>
      (...a: A) => {
        try {
          fn(...a);
        } catch (e) {
          console.warn('Account-Statistik:', (e as Error).message);
        }
      };
    g.on('roundResult', safe((reveal: RoundReveal) => this.recordRound(g, reveal)));
    g.on('quizResult', safe((results: QuizAnswerResult[]) => {
      const t = this.quizTally.get(g) ?? new Map();
      this.quizTally.set(g, t);
      for (const r of results) {
        const x = t.get(r.playerId) ?? { right: 0, asked: 0 };
        x.asked++;
        if (r.base >= 0.999) x.right++;
        t.set(r.playerId, x);
      }
    }));
    g.on('finished', safe(() => this.recordGame(g)));
  }

  private recordRound(g: Lobby, reveal: RoundReveal) {
    if (reveal.cancelled) return;
    const byPlayer = new Map(g.accounts().filter((a) => this.exists(a.userId)).map((a) => [a.playerId, a.userId]));
    for (const ev of reveal.evaluations) {
      const userId = byPlayer.get(ev.playerId);
      if (userId == null || ev.elapsedSec == null) continue;
      this.tx(() => {
        this.db
          .prepare("INSERT INTO results (user_id, kind, at, points, route, minutes) VALUES (?, 'round', ?, ?, ?, ?)")
          .run(userId, Date.now(), ev.score.total, ev.score.route, ev.durationMin == null ? null : Math.round(ev.durationMin));
        this.recordLegs(userId, ev.legs, ev.error == null);
        // 5 fürs Mitspielen + bis zu ~130 für eine starke Runde
        this.addXp(userId, 5 + ev.score.total / 20);
      });
    }
    for (const id of new Set(byPlayer.values())) this.checkMedals(id);
  }

  private recordGame(g: Lobby) {
    const ranking = g.ranking();
    const quiz = g.mode === 'quiz';
    const tally = this.quizTally.get(g);
    this.quizTally.delete(g);
    for (const a of g.accounts().filter((x) => this.exists(x.userId))) {
      const rank = ranking.findIndex((r) => r.playerId === a.playerId) + 1;
      const players = ranking.length;
      const won = rank === 1 && players >= 2 && a.score > 0;
      const t = tally?.get(a.playerId);
      const ace = quiz && !!t && t.asked >= 5 && t.right === t.asked;
      this.tx(() => {
        this.db.prepare('INSERT INTO results (user_id, kind, at, points, rank, players, extra) VALUES (?, ?, ?, ?, ?, ?, ?)').run(a.userId, quiz ? 'quiz' : 'game', Date.now(), a.score, rank, players, ace ? 'ace' : null);
        this.addXp(a.userId, quiz ? 10 + a.score / 50 + (won ? 20 : 0) : 20 + (won ? 30 : 0));
      });
      this.checkMedals(a.userId);
    }
  }

  /** Training: eine ausgewertete Strecke (je Strecke einmal) */
  recordTraining(userId: number, roundId: string, legs: UserLeg[], res: TrainingResult, bestMin: number | null) {
    const key = `${userId}:${roundId}`;
    if (this.trainingSeen.has(key) || res.durationMin == null) return;
    this.trainingSeen.set(key, Date.now());
    const good = bestMin != null && res.durationMin <= bestMin * 1.1;
    this.tx(() => {
      this.db.prepare("INSERT INTO results (user_id, kind, at, points, minutes) VALUES (?, 'training', ?, ?, ?)").run(userId, Date.now(), good ? 1 : 0, Math.round(res.durationMin!));
      this.recordLegs(userId, legs, !res.error);
      this.addXp(userId, good ? 20 : 10);
    });
    this.checkMedals(userId);
  }

  /**
   * Lieblingslinien/-station: jede gefahrene Linie zählt – aber kaum, wenn an der Einstiegsstation gar nichts
   * anderes fährt (92B ab Frachtenbahnhof Lobau), voll, wenn man sich bewusst entschieden hat (95A statt 93A am Großen
   * Biberhaufen). Start und Ziel sind vorgegeben, nur Umstiegsstationen zählen für die Lieblingsstation.
   */
  private recordLegs(userId: number, legs: UserLeg[], valid: boolean) {
    if (!valid) return;
    const up = this.db.prepare('INSERT INTO usage (user_id, kind, key, weight, count) VALUES (?, ?, ?, ?, 1) ON CONFLICT(user_id, kind, key) DO UPDATE SET weight = weight + excluded.weight, count = count + 1');
    legs.forEach((leg, i) => {
      const line = this.net.lines.get(leg.line);
      if (!line || isSpecialLine(line)) return;
      let others = 0;
      try {
        others = this.net.linesAt(leg.from, 'regular').filter((l) => l.id !== line.id && !isSpecialLine(l) && l.mode !== 'N').length;
      } catch {
        /* unbekannte Station */
      }
      up.run(userId, `line:${line.mode}`, line.id, others ? 1 : 0.15);
      if (i > 0 && !this.net.isAddress(leg.from)) up.run(userId, 'station', leg.from, 1);
    });
  }

  private tx(fn: () => void) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  stats(userId: number): AccountStats {
    const one = <T>(sql: string, ...p: (number | string)[]) => this.db.prepare(sql).get(...p) as T;
    const g = one<{ n: number; wins: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(rank = 1 AND players >= 2), 0) AS wins FROM results WHERE user_id = ? AND kind = 'game'", userId);
    const q = one<{ n: number; wins: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(rank = 1 AND players >= 2), 0) AS wins FROM results WHERE user_id = ? AND kind = 'quiz'", userId);
    const r = one<{ n: number; avg: number | null; best: number | null; perfect: number; beat: number; minutes: number }>(
      "SELECT COUNT(*) AS n, AVG(route) AS avg, MAX(points) AS best, COALESCE(SUM(route >= 1000), 0) AS perfect, COALESCE(SUM(route > 1000), 0) AS beat, COALESCE(SUM(minutes), 0) AS minutes FROM results WHERE user_id = ? AND kind = 'round'",
      userId,
    );
    const tr = one<{ n: number; minutes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(minutes), 0) AS minutes FROM results WHERE user_id = ? AND kind = 'training'", userId);
    const fav = (mode: Mode): FavoriteLine | null => {
      const row = one<{ key: string; count: number } | undefined>('SELECT key, count FROM usage WHERE user_id = ? AND kind = ? ORDER BY weight DESC, count DESC LIMIT 1', userId, `line:${mode}`);
      const line = row && this.net.lines.get(row.key);
      return line ? { id: line.id, mode: line.mode, color: line.color, count: row.count } : null;
    };
    const st = one<{ key: string; count: number } | undefined>("SELECT key, count FROM usage WHERE user_id = ? AND kind = 'station' ORDER BY weight DESC, count DESC LIMIT 1", userId);
    let favoriteStation = null;
    try {
      if (st) favoriteStation = { id: st.key, name: this.net.station(st.key).name, count: st.count };
    } catch {
      /* Station nicht mehr im Netz */
    }
    const c = this.courses(userId);
    const recent = (
      this.db.prepare("SELECT kind, at, points, rank, players FROM results WHERE user_id = ? AND kind IN ('game', 'quiz', 'training') ORDER BY at DESC, id DESC LIMIT 10").all(userId) as {
        kind: 'game' | 'quiz' | 'training';
        at: number;
        points: number;
        rank: number | null;
        players: number | null;
      }[]
    ).map((x) => ({ ...x }));
    return {
      games: g.n,
      wins: g.wins,
      rounds: r.n,
      avgRoute: Math.round(r.avg ?? 0),
      bestRound: r.best ?? 0,
      perfectRounds: r.perfect,
      beatApi: r.beat,
      quizGames: q.n,
      quizWins: q.wins,
      trainings: tr.n,
      minutes: r.minutes + tr.minutes,
      coursesDone: c.done,
      coursesMastered: c.mastered,
      favorites: { U: fav('U'), S: fav('S'), T: fav('T'), B: fav('B') },
      favoriteStation,
      recent,
    };
  }

  // -------------------------------------------------------------- Freunde

  private pair(x: number, y: number): [number, number] {
    return x < y ? [x, y] : [y, x];
  }

  relation(me: number | null, other: number): Relation {
    if (me == null) return null;
    if (me === other) return 'self';
    const [a, b] = this.pair(me, other);
    const f = this.db.prepare('SELECT requester, accepted FROM friends WHERE a = ? AND b = ?').get(a, b) as { requester: number; accepted: number } | undefined;
    if (!f) return null;
    if (f.accepted) return 'friend';
    return f.requester === me ? 'outgoing' : 'incoming';
  }

  /** Anfrage schicken – hat der andere schon angefragt, ist man damit befreundet */
  befriend(me: number, otherName: string): Relation {
    const o = this.byName(otherName);
    if (o.id === me) throw new GameError('Mit dir selbst bist du schon befreundet 😉');
    const rel = this.relation(me, o.id);
    const [a, b] = this.pair(me, o.id);
    if (rel === 'incoming') this.db.prepare('UPDATE friends SET accepted = 1 WHERE a = ? AND b = ?').run(a, b);
    else if (rel === null) {
      const pending = Number((this.db.prepare('SELECT COUNT(*) AS n FROM friends WHERE requester = ? AND accepted = 0').get(me) as { n: number }).n);
      if (pending >= 50) throw new GameError('Zu viele offene Anfragen.', 429);
      this.db.prepare('INSERT INTO friends (a, b, requester, created) VALUES (?, ?, ?, ?)').run(a, b, me, Date.now());
    }
    this.checkMedals(me);
    this.checkMedals(o.id);
    return this.relation(me, o.id);
  }

  /** Freundschaft beenden, Anfrage ablehnen oder zurückziehen */
  unfriend(me: number, otherName: string) {
    const o = this.byName(otherName);
    const [a, b] = this.pair(me, o.id);
    this.db.prepare('DELETE FROM friends WHERE a = ? AND b = ?').run(a, b);
  }

  private item(me: number | null, u: { id: number; name: string; last_seen: number }): UserListItem {
    return { name: u.name, level: this.level(u.id).level, online: Date.now() - u.last_seen < ONLINE_MS, relation: this.relation(me, u.id) };
  }

  friends(me: number): FriendsList {
    const rows = this.db
      .prepare('SELECT u.id, u.name, u.last_seen, f.requester, f.accepted FROM friends f JOIN users u ON u.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END WHERE f.a = ?1 OR f.b = ?1 ORDER BY u.name')
      .all(me) as { id: number; name: string; last_seen: number; requester: number; accepted: number }[];
    const out: FriendsList = { friends: [], incoming: [], outgoing: [] };
    for (const r of rows) (r.accepted ? out.friends : r.requester === me ? out.outgoing : out.incoming).push(this.item(me, r));
    out.friends.sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
    return out;
  }

  /** alle Accounts (Suche), angemeldet mit Beziehung */
  list(me: number | null, query: unknown, offset = 0): UserListItem[] {
    const q = String(query ?? '').trim().slice(0, 30).replace(/[%_\\]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare("SELECT id, name, last_seen FROM users WHERE name LIKE ? ESCAPE '\\' ORDER BY last_seen DESC, name LIMIT 50 OFFSET ?")
      .all(`%${q}%`, Math.max(0, Math.floor(offset) || 0)) as { id: number; name: string; last_seen: number }[];
    return rows.map((r) => this.item(me, r));
  }

  profile(me: number | null, name: string): Profile {
    const u = this.byName(name);
    const relation = this.relation(me, u.id);
    return {
      name: u.name,
      created: u.created,
      level: this.level(u.id),
      online: Date.now() - u.last_seen < ONLINE_MS,
      relation,
      medals: this.medals(u.id),
      stats: relation === 'self' || relation === 'friend' ? this.stats(u.id) : null,
    };
  }

  // -------------------------------------------------------------- Einladungen

  /** Freunde in eine Lobby einladen – bestimmte (Namen) oder alle */
  invite(me: number, code: string, mode: GameMode, to: unknown): number {
    const friends = this.friends(me).friends;
    const names = to === 'all' ? friends.map((f) => f.name) : Array.isArray(to) ? to.map(String).slice(0, 50) : [];
    const ok = friends.filter((f) => names.some((n) => n.toLowerCase() === f.name.toLowerCase()));
    if (!ok.length) throw new GameError(friends.length ? 'Wähle mindestens einen Freund.' : 'Du hast noch keine Freunde – unter 👥 Leute findest du andere.');
    const del = this.db.prepare('DELETE FROM invites WHERE from_id = ? AND to_id = ?');
    const ins = this.db.prepare('INSERT INTO invites (from_id, to_id, code, mode, created) VALUES (?, ?, ?, ?, ?)');
    this.tx(() => {
      for (const f of ok) {
        const id = this.byName(f.name).id;
        del.run(me, id);
        ins.run(me, id, code, mode, Date.now());
      }
    });
    return ok.length;
  }

  /** offene Einladungen (nur Lobbys, die es noch gibt) */
  invites(me: number, alive: (code: string) => boolean): InvitePublic[] {
    const rows = this.db
      .prepare('SELECT i.id, i.code, i.mode, i.created, u.name FROM invites i JOIN users u ON u.id = i.from_id WHERE i.to_id = ? AND i.created > ? ORDER BY i.created DESC')
      .all(me, Date.now() - INVITE_MS) as { id: number; code: string; mode: GameMode; created: number; name: string }[];
    const out: InvitePublic[] = [];
    for (const r of rows) {
      if (alive(r.code)) out.push({ id: r.id, from: r.name, code: r.code, mode: r.mode, at: r.created });
      else this.db.prepare('DELETE FROM invites WHERE id = ?').run(r.id);
    }
    return out;
  }

  dropInvite(me: number, id: number) {
    this.db.prepare('DELETE FROM invites WHERE id = ? AND to_id = ?').run(id, me);
  }

  // -------------------------------------------------------------- „Ich“

  me(userId: number, alive: (code: string) => boolean): Me {
    const u = this.row(userId);
    const f = this.friends(userId);
    return {
      name: u.name,
      email: u.email,
      level: this.level(userId),
      medals: this.medals(userId),
      data: this.data(userId),
      friendRequests: f.incoming.length,
      friendsOnline: f.friends.filter((x) => x.online).map((x) => x.name),
      invites: this.invites(userId, alive),
    };
  }
}

/** Anzahl der Kurse im Lernpfad (für „alle Kurse“) – muss zu client/src/learn/courses/index.ts passen */
export const COURSE_COUNT = 9;

/** leer → null (keine Adresse), ungültig → undefined */
function cleanEmail(v: unknown): string | null | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.length > 120 || !/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/.test(s)) return undefined;
  return s;
}
