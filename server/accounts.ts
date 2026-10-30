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
  AdminLogEntry,
  AdminOverview,
  AdminStats,
  AdminUserStats,
  AdminUserDetail,
  AdminUserRow,
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
import { maskEmail } from './mail.ts';
import { isOffensive } from './moderation.ts';

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
const LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60_000;
const ADMIN_IDLE_MS = 30 * 60_000;
const ADMIN_MAX_MS = 8 * 3600_000;
export const ADMIN_PW_MIN = 10;

/** Namen, mit denen man sich als Spielleitung ausgeben könnte – und gesperrte Wörter */
function isReservedName(n: string): boolean {
  const k = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^(admin|administrator|spielleitung|moderator|mod|system|bimguesser|support|team|staff|root)\d*$/.test(k) || isOffensive(n);
}

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
  { id: 'beat-api', icon: '🧠', title: 'Schneller als die Bestzeit', text: 'Eine Route gefunden, die schneller ist als die beste Verbindung' },
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
CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, admin TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS metrics (at INTEGER PRIMARY KEY, online INTEGER NOT NULL, lobbies INTEGER NOT NULL, playing INTEGER NOT NULL, players INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS game_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, mode TEXT NOT NULL, players INTEGER NOT NULL, accounts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS game_log_at ON game_log(at);
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
    try {
      if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
      this.db = new DatabaseSync(file);
    } catch (e) {
      // häufigster Fall im Container: State-Ordner gehört root (von Docker angelegt) → klar sagen, was zu tun ist
      throw new Error(
        `Account-Datenbank ${file} lässt sich nicht öffnen (${(e as Error).message}). Darf der Server in den Ordner schreiben? ` +
          `Im Container läuft er als Benutzer 1000 – auf dem Host z.B.: sudo chown -R 1000:1000 <State-Ordner>`,
      );
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // neuere Spalten in bestehenden Datenbanken nachrüsten
    const cols = new Set((this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('is_admin')) this.db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    // Admin-Bereich entsperrt (bis wann, seit wann) – je Sitzung, nur nach erneuter Passworteingabe
    const scols = new Set((this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name));
    if (!scols.has('admin_until')) this.db.exec('ALTER TABLE sessions ADD COLUMN admin_until INTEGER NOT NULL DEFAULT 0');
    if (!scols.has('admin_since')) this.db.exec('ALTER TABLE sessions ADD COLUMN admin_since INTEGER NOT NULL DEFAULT 0');
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
    if (isReservedName(n)) throw new GameError('Dieser Benutzername ist nicht erlaubt.');
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

  /** Fehlversuche je eingegebenem Namen (auch für Namen ohne Account – verrät also nichts) */
  private fails = new Map<string, { n: number; until: number }>();

  /** nach 5 Fehlversuchen 15 min Pause für diesen Namen – bremst gezieltes Raten (auch von vielen Adressen aus) */
  private checkFails(key: string) {
    const f = this.fails.get(key);
    if (f && f.until > Date.now()) throw new GameError(`Zu viele Fehlversuche – bitte in ${Math.ceil((f.until - Date.now()) / 60000)} Minuten nochmal.`, 429);
  }
  private failed(key: string) {
    const f = this.fails.get(key) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= LOGIN_FAILS) ((f.until = Date.now() + LOGIN_LOCK_MS), (f.n = 0));
    this.fails.set(key, f);
    if (this.fails.size > 50_000) for (const [k, v] of this.fails) if (v.until < Date.now()) this.fails.delete(k);
  }

  async login(name: unknown, password: unknown): Promise<{ user: AccountUser; token: string }> {
    const n = String(name ?? '').trim();
    const pw = String(password ?? '');
    const key = n.toLowerCase();
    this.checkFails(key);
    // Name oder E-Mail
    const u = (this.db.prepare('SELECT * FROM users WHERE name = ? OR (email = ? AND email IS NOT NULL) ORDER BY name = ? DESC LIMIT 1').get(n, n, n) ?? null) as UserRow | null;
    // auch ohne Account gleich lange rechnen – sonst verrät die Antwortzeit, ob es den Namen gibt
    const ok = u ? await verifyPassword(pw, u.pw) : (await hashPassword(pw), false);
    if (!u || !ok) {
      this.failed(key);
      throw new GameError('Benutzername oder Passwort stimmt nicht.', 401);
    }
    this.fails.delete(key);
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

  // -------------------------------------------------------------- Admin-Bereich entsperren

  /**
   * Admin-Bereich für diese Sitzung entsperren – nur mit dem Passwort (das Login-Cookie allein reicht nicht: ein
   * vergessenes angemeldetes Gerät oder ein gestohlenes Cookie gibt so keinen Admin-Zugriff). Gilt 30 min ab der
   * letzten Admin-Aktion, höchstens 8 Stunden.
   */
  async adminUnlock(token: string, userId: number, password: unknown) {
    const u = this.row(userId) as UserRow & { is_admin: number };
    const key = `admin:${u.id}`;
    this.checkFails(key);
    if (!u.is_admin) throw new GameError('Nur für Admins.', 403);
    const pw = String(password ?? '');
    if (!(await verifyPassword(pw, u.pw))) {
      this.failed(key);
      throw new GameError('Das Passwort stimmt nicht.', 401);
    }
    this.fails.delete(key);
    if (pw.length < ADMIN_PW_MIN) throw new GameError(`Für den Admin-Bereich braucht dein Passwort mindestens ${ADMIN_PW_MIN} Zeichen – bitte zuerst unter ⚙️ ändern.`, 403);
    const now = Date.now();
    this.db.prepare('UPDATE sessions SET admin_until = ?, admin_since = ? WHERE hash = ? AND user_id = ?').run(now + ADMIN_IDLE_MS, now, sha(token), u.id);
  }

  /** Admin-Bereich in dieser Sitzung entsperrt? Verlängert die Sperrzeit bei jeder Admin-Aktion. */
  adminUnlocked(token: string): boolean {
    const s = this.db.prepare('SELECT admin_until AS until, admin_since AS since FROM sessions WHERE hash = ?').get(sha(token)) as { until: number; since: number } | undefined;
    const now = Date.now();
    if (!s || s.until < now || now - s.since > ADMIN_MAX_MS) return false;
    this.db.prepare('UPDATE sessions SET admin_until = ? WHERE hash = ?').run(now + ADMIN_IDLE_MS, sha(token));
    return true;
  }

  adminLock(token: string) {
    this.db.prepare('UPDATE sessions SET admin_until = 0 WHERE hash = ?').run(sha(token));
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

  /** Account endgültig löschen (mit Passwort bestätigt): alles, was an ihm hängt, in einem Rutsch */
  async deleteAccount(userId: number, password: unknown) {
    const u = this.row(userId);
    if (!(await verifyPassword(String(password ?? ''), u.pw))) throw new GameError('Das Passwort stimmt nicht.', 401);
    this.purge(userId);
  }

  /** alles zu einem Account löschen (eigene Löschung und Admin) */
  purge(userId: number) {
    this.db.exec('BEGIN');
    try {
      for (const sql of [
        'DELETE FROM sessions WHERE user_id = ?',
        'DELETE FROM resets WHERE user_id = ?',
        'DELETE FROM friends WHERE a = ?1 OR b = ?1',
        'DELETE FROM invites WHERE from_id = ?1 OR to_id = ?1',
        'DELETE FROM results WHERE user_id = ?',
        'DELETE FROM usage WHERE user_id = ?',
        'DELETE FROM medals WHERE user_id = ?',
        'DELETE FROM users WHERE id = ?',
      ])
        this.db.prepare(sql).run(userId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    for (const k of this.trainingSeen.keys()) if (k.startsWith(`${userId}:`)) this.trainingSeen.delete(k);
  }

  setEmail(userId: number, email: unknown) {
    const mail = cleanEmail(email);
    if (mail === undefined) throw new GameError('Diese E-Mail-Adresse sieht nicht gültig aus.');
    this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(mail, userId);
  }

  // -------------------------------------------------------------- Passwort vergessen

  /**
   * Reset-Link per Mail. Verrät nie, ob es die Adresse gibt: gleiche Antwort, sofort (verschickt wird im Hintergrund –
   * sonst wäre die Antwort bei echten Accounts messbar langsamer), und ein Versandfehler landet nur im Log.
   */
  async forgot(email: unknown, baseUrl: string): Promise<void> {
    const mail = cleanEmail(email);
    if (!mail || !this.mail) return;
    const users = this.db.prepare('SELECT * FROM users WHERE email = ?').all(mail) as unknown as UserRow[];
    if (!users.length) {
      console.log(`Passwort-Reset: kein Account mit ${maskEmail(mail)}`);
      return;
    }
    const links: string[] = [];
    for (const u of users) {
      const t = newToken();
      this.db.prepare('INSERT INTO resets (hash, user_id, expires) VALUES (?, ?, ?)').run(sha(t), u.id, Date.now() + RESET_MS);
      links.push(`${u.name}: ${baseUrl}/?reset=${t}`);
    }
    this.mail(
      mail,
      'BimGuesser – Passwort zurücksetzen',
      `Hallo!\n\nJemand (hoffentlich du) möchte das Passwort für BimGuesser zurücksetzen. Der Link gilt 1 Stunde:\n\n${links.join('\n')}\n\nWarst du das nicht? Dann einfach ignorieren – dein Passwort bleibt, wie es ist.\n`,
    ).then(
      () => console.log(`Passwort-Reset: Mail an ${maskEmail(mail)} verschickt`),
      (e: Error) => console.warn(`✖ Passwort-Reset: Mail an ${maskEmail(mail)} fehlgeschlagen – ${e.message}`),
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
      // online nur für Freunde sichtbar (Datenschutz-Hinweis)
      online: (relation === 'self' || relation === 'friend') && Date.now() - u.last_seen < ONLINE_MS,
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

  /**
   * Nur für Tests (TEST_HOOKS=1): Zeit „vorspulen“ – zuletzt online vor `seenMinAgo` Minuten, Einladungen des
   * Accounts um `invitesMinOlder` Minuten älter. Sonst müsste ein Test 2 Minuten bzw. 2 Stunden warten.
   */
  testAge(name: string, opts: { seenMinAgo?: number; invitesMinOlder?: number }) {
    const u = this.byName(name);
    if (opts.seenMinAgo != null) this.db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now() - opts.seenMinAgo * 60_000, u.id);
    if (opts.invitesMinOlder != null) this.db.prepare('UPDATE invites SET created = created - ? WHERE to_id = ? OR from_id = ?').run(opts.invitesMinOlder * 60_000, u.id, u.id);
  }

  dropInvite(me: number, id: number) {
    this.db.prepare('DELETE FROM invites WHERE id = ? AND to_id = ?').run(id, me);
  }

  // -------------------------------------------------------------- „Ich“

  me(userId: number, alive: (code: string) => boolean): Me {
    const u = this.row(userId) as UserRow & { is_admin: number };
    const f = this.friends(userId);
    return {
      ...(u.is_admin ? { admin: true } : {}),
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

// ================================================================ Admin

/**
 * Verwaltung für Admins (Rechte nur über die Kommandozeile: server/admin-cli.ts). Jede Änderung landet im Protokoll.
 * Als eigene Klasse über derselben Datenbank, damit die Spiel-Logik in Accounts übersichtlich bleibt.
 */
export class AccountAdmin {
  private acc: Accounts;

  constructor(acc: Accounts) {
    this.acc = acc;
  }

  private get db(): DatabaseSync {
    return (this.acc as unknown as { db: DatabaseSync }).db;
  }

  private target(name: string): UserRow & { is_admin: number } {
    const u = this.db.prepare('SELECT * FROM users WHERE name = ?').get(String(name ?? '').trim()) as (UserRow & { is_admin: number }) | undefined;
    if (!u) throw new GameError('Diesen Account gibt es nicht.', 404);
    return u;
  }

  /** Account ändern dürfen: nie einen Admin (auch nicht sich selbst über die Admin-Seite) – das geht nur über die Kommandozeile */
  private changeable(name: string): UserRow & { is_admin: number } {
    const u = this.target(name);
    if (u.is_admin) throw new GameError('Admin-Accounts lassen sich hier nicht ändern – nur über die Kommandozeile am Server.', 403);
    return u;
  }

  isAdmin(userId: number): boolean {
    return !!(this.db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as { is_admin: number } | undefined)?.is_admin;
  }

  /** Kommandozeile: Admin-Rechte geben/nehmen */
  setAdmin(name: string, on: boolean): string {
    const u = this.target(name);
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(on ? 1 : 0, u.id);
    this.log('Kommandozeile', on ? 'Admin-Rechte gegeben' : 'Admin-Rechte genommen', u.name);
    return u.name;
  }

  admins(): string[] {
    return (this.db.prepare('SELECT name FROM users WHERE is_admin = 1 ORDER BY name').all() as { name: string }[]).map((r) => r.name);
  }

  log(admin: string, action: string, target: string | null = null, detail: string | null = null) {
    this.db.prepare('INSERT INTO admin_log (at, admin, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), admin, action, target, detail);
    this.db.prepare('DELETE FROM admin_log WHERE id <= (SELECT MAX(id) FROM admin_log) - 2000').run();
  }

  logEntries(limit = 200): AdminLogEntry[] {
    return this.db.prepare('SELECT at, admin, action, target, detail FROM admin_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as AdminLogEntry[];
  }

  counts(): AdminOverview['users'] {
    const one = (sql: string, ...a: number[]) => (this.db.prepare(sql).get(...a) as { n: number }).n;
    const now = Date.now();
    return {
      total: one('SELECT COUNT(*) AS n FROM users'),
      online: one('SELECT COUNT(*) AS n FROM users WHERE last_seen > ?', now - ONLINE_MS),
      new7d: one('SELECT COUNT(*) AS n FROM users WHERE created > ?', now - 7 * DAY),
      admins: one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
      withEmail: one('SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL'),
    };
  }

  private rowOf(u: UserRow & { is_admin: number }): AdminUserRow {
    const n = (sql: string) => (this.db.prepare(sql).get(u.id) as { n: number }).n;
    return {
      name: u.name,
      email: u.email,
      admin: !!u.is_admin,
      created: u.created,
      lastSeen: u.last_seen,
      online: Date.now() - u.last_seen < ONLINE_MS,
      level: this.acc.level(u.id).level,
      games: n("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND kind IN ('route', 'quiz')"),
      sessions: n('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?'),
    };
  }

  /** alle Accounts (Suche in Name und E-Mail), zuletzt aktive zuerst */
  users(q: unknown, offset = 0): AdminUserRow[] {
    const s = `%${String(q ?? '').trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare("SELECT * FROM users WHERE name LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\' ORDER BY last_seen DESC LIMIT 100 OFFSET ?2")
      .all(s, Math.max(0, Math.floor(offset))) as unknown as (UserRow & { is_admin: number })[];
    return rows.map((u) => this.rowOf(u));
  }

  user(name: string): AdminUserDetail {
    const u = this.target(name);
    const f = this.acc.friends(u.id);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(u.data) as Record<string, unknown>;
    } catch {
      /* kaputt → leer anzeigen */
    }
    return {
      ...this.rowOf(u),
      xp: this.acc.level(u.id).xp,
      stats: this.acc.stats(u.id),
      medals: this.acc.medals(u.id),
      friends: f.friends.map((x) => x.name),
      incoming: f.incoming.map((x) => x.name),
      outgoing: f.outgoing.map((x) => x.name),
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, JSON.stringify(v).length])),
      invites: (this.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE to_id = ?').get(u.id) as { n: number }).n,
    };
  }

  /** Account löschen – nicht bei Admins (zuerst über die Kommandozeile die Rechte nehmen) */
  remove(admin: string, name: string) {
    const u = this.changeable(name);
    this.acc.purge(u.id);
    this.log(admin, 'Account gelöscht', u.name, u.email ? `E-Mail ${u.email}` : null);
  }

  async setPassword(admin: string, name: string, pw: unknown) {
    const u = this.changeable(name);
    const p = String(pw ?? '');
    if (p.length < 8 || p.length > 200) throw new GameError('Passwort: mindestens 8 Zeichen.');
    this.db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(await hashPassword(p), u.id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    this.log(admin, 'Passwort neu gesetzt (alle Geräte abgemeldet)', u.name);
  }

  /** Link zum Zurücksetzen (1 Stunde) – zum Weitergeben, wenn keine Mail geht */
  resetLink(admin: string, name: string, base: string): string {
    const u = this.changeable(name);
    const t = newToken();
    this.db.prepare('INSERT INTO resets (hash, user_id, expires) VALUES (?, ?, ?)').run(sha(t), u.id, Date.now() + RESET_MS);
    this.log(admin, 'Link zum Zurücksetzen erzeugt', u.name);
    return `${base}/?reset=${t}`;
  }

  logout(admin: string, name: string): number {
    const u = this.changeable(name);
    const n = Number(this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id).changes);
    this.log(admin, 'Auf allen Geräten abgemeldet', u.name, `${n} Sitzung(en)`);
    return n;
  }

  /** Statistik, Medaillen, Lieblinge und Spiel-XP auf null (Lernstand bleibt – den hat auch der Browser) */
  resetStats(admin: string, name: string) {
    const u = this.changeable(name);
    this.db.exec('BEGIN');
    try {
      for (const sql of ['DELETE FROM results WHERE user_id = ?', 'DELETE FROM usage WHERE user_id = ?', 'DELETE FROM medals WHERE user_id = ?', 'UPDATE users SET game_xp = 0 WHERE id = ?'])
        this.db.prepare(sql).run(u.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.log(admin, 'Statistik zurückgesetzt', u.name);
  }

  rename(admin: string, name: string, newName: unknown): string {
    const u = this.changeable(name);
    const n = String(newName ?? '').trim();
    if (!NAME_RE.test(n)) throw new GameError('Benutzername: 3–20 Zeichen, nur Buchstaben, Ziffern und _ . -');
    if (isReservedName(n)) throw new GameError('Dieser Benutzername ist nicht erlaubt.');
    const other = this.db.prepare('SELECT id FROM users WHERE name = ?').get(n) as { id: number } | undefined;
    if (other && other.id !== u.id) throw new GameError('Diesen Benutzernamen gibt es schon.', 409);
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(n, u.id);
    this.log(admin, 'Umbenannt', n, `vorher ${u.name}`);
    return n;
  }

  setEmail(admin: string, name: string, email: unknown) {
    const u = this.changeable(name);
    const mail = cleanEmail(email);
    if (mail === undefined) throw new GameError('Diese E-Mail-Adresse sieht nicht gültig aus.');
    this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(mail, u.id);
    this.log(admin, mail ? 'E-Mail geändert' : 'E-Mail entfernt', u.name);
  }

  // -------------------------------------------------------------- Statistik

  /** Momentaufnahme (alle 5 min): Accounts online, Lobbys, laufende Spiele, verbundene Spieler – 90 Tage aufheben */
  sample(lobbies: number, playing: number, players: number) {
    const now = Date.now();
    const online = (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE last_seen > ?').get(now - ONLINE_MS) as { n: number }).n;
    this.db.prepare('INSERT OR REPLACE INTO metrics (at, online, lobbies, playing, players) VALUES (?, ?, ?, ?, ?)').run(now, online, lobbies, playing, players);
    this.db.prepare('DELETE FROM metrics WHERE at < ?').run(now - 90 * DAY);
  }

  /** fertig gespieltes Spiel (alle, auch ohne Account) */
  recordGame(mode: GameMode, players: number, accounts: number) {
    this.db.prepare('INSERT INTO game_log (at, mode, players, accounts) VALUES (?, ?, ?, ?)').run(Date.now(), mode, players, accounts);
  }

  stats(days: number): AdminStats {
    const since = Date.now() - days * DAY;
    const raw = this.db.prepare('SELECT at, online, lobbies, playing, players FROM metrics WHERE at >= ? ORDER BY at').all(since) as unknown as AdminStats['samples'];
    // über 2 Tage: je Stunde der höchste Wert (sonst zu viele Punkte für die Grafik)
    const samples = days <= 2 ? raw : bucketMax(raw, 3600_000);
    const empty = (k: string): AdminStats['days'][number] => ({ day: k, route: 0, quiz: 0, players: 0, newUsers: 0, activeUsers: 0 });
    const rows = new Map<string, AdminStats['days'][number]>();
    for (let t = since; t <= Date.now() + DAY / 2; t += DAY) rows.set(dayOf(t), empty(dayOf(t)));
    const row = (t: number) => rows.get(dayOf(t)) ?? rows.set(dayOf(t), empty(dayOf(t))).get(dayOf(t))!;
    for (const g of this.db.prepare('SELECT at, mode, players FROM game_log WHERE at >= ?').all(since) as { at: number; mode: string; players: number }[]) {
      const r = row(g.at);
      if (g.mode === 'quiz') r.quiz++;
      else r.route++;
      r.players += g.players;
    }
    for (const u of this.db.prepare('SELECT created FROM users WHERE created >= ?').all(since) as { created: number }[]) row(u.created).newUsers++;
    const active = new Map<string, Set<number>>();
    for (const x of this.db.prepare('SELECT user_id, at FROM results WHERE at >= ?').all(since) as { user_id: number; at: number }[])
      (active.get(dayOf(x.at)) ?? active.set(dayOf(x.at), new Set()).get(dayOf(x.at))!).add(x.user_id);
    for (const [k, set] of active) (rows.get(k) ?? rows.set(k, empty(k)).get(k)!).activeUsers = set.size;
    return { samples, days: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day)) };
  }

  /** Spiele eines Accounts je Tag */
  userStats(name: string, days: number): AdminUserStats {
    const u = this.target(name);
    const since = Date.now() - days * DAY;
    const rows = new Map<string, AdminUserStats['days'][number]>();
    for (let t = since; t <= Date.now() + DAY / 2; t += DAY) rows.set(dayOf(t), { day: dayOf(t), route: 0, quiz: 0, training: 0, points: 0 });
    const list = this.db.prepare("SELECT kind, at, points FROM results WHERE user_id = ? AND at >= ? AND kind IN ('game', 'quiz', 'training')").all(u.id, since) as {
      kind: string;
      at: number;
      points: number;
    }[];
    for (const r of list) {
      const x = rows.get(dayOf(r.at));
      if (!x) continue;
      if (r.kind === 'game') x.route++;
      else if (r.kind === 'quiz') x.quiz++;
      else x.training++;
      x.points += r.points;
    }
    return { days: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day)) };
  }
}

/** Tag in Wien (YYYY-MM-DD) */
const dayOf = (t: number) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' });

/** Zeitreihe verdichten: je Zeitfenster der höchste Wert jeder Größe */
function bucketMax(rows: AdminStats['samples'], ms: number): AdminStats['samples'] {
  const out = new Map<number, AdminStats['samples'][number]>();
  for (const r of rows) {
    const k = Math.floor(r.at / ms) * ms;
    const b = out.get(k);
    if (!b) out.set(k, { ...r, at: k });
    else for (const f of ['online', 'lobbies', 'playing', 'players'] as const) b[f] = Math.max(b[f], r[f]);
  }
  return [...out.values()];
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
