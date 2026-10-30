// Account im Browser: Anmeldestatus, Sync des Spielstands (Lernstand, Tutorial, Einstellungen …) mit dem Server,
// regelmäßiges Nachfragen (Freundschaftsanfragen, Einladungen, neue Medaillen).
//
// Sync: Beim Anmelden auf einem Gerät werden Browser- und Account-Stand zusammengeführt (Fortschritt geht nie
// verloren). Danach gilt der Account: boot.ts holt ihn vor dem Start der App in den localStorage, und jede
// Änderung wird hochgeladen.
import type { FriendsList, Me, Profile, UserListItem } from '../../shared/types.ts';
import { ApiError } from './api.ts';
import { loadJson, onSaveJson, saveJson } from './storage.ts';
import { mergeProgress } from '../../shared/progress.ts';

/** synchronisierte Schlüssel: 'merge' = beim Anmelden zusammenführen, 'account' = Account gewinnt */
const SYNC: Record<string, 'merge' | 'account'> = {
  'oeffi-courses-v1': 'merge',
  'oeffi-learn-progress-v1': 'merge',
  'oeffi-my-lines-v1': 'merge',
  'oeffi-progress-v1': 'merge',
  'oeffi-training-memory-v1': 'merge',
  'oeffi-training-config-v1': 'account',
  'oeffi-guesser-prefs-v2': 'account',
};
const SEEN_MEDALS = 'oeffi-seen-medals';
const POLL_MS = 20_000;

export const account = {
  me: null as Me | null,
  /** Änderungen (Anmelden, neue Einladung …) – main.ts zeichnet Kopfzeile und Banner neu */
  listeners: new Set<() => void>(),
};
const changed = () => account.listeners.forEach((fn) => fn());

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
    body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

export const accountApi = {
  me: () => call<{ user: Me | null }>('GET', '/api/me'),
  register: (name: string, password: string, email: string) => call<Me>('POST', '/api/auth/register', { name, password, email }),
  login: (name: string, password: string) => call<Me>('POST', '/api/auth/login', { name, password }),
  logout: () => call<{ ok: boolean }>('POST', '/api/auth/logout'),
  forgot: (email: string) => call<{ ok: boolean }>('POST', '/api/auth/forgot', { email }),
  reset: (token: string, password: string) => call<Me>('POST', '/api/auth/reset', { token, password }),
  saveData: (data: Record<string, unknown>) => call<{ ok: boolean }>('PUT', '/api/me/data', { data }),
  setEmail: (email: string) => call<Me>('PUT', '/api/me/email', { email }),
  password: (old: string, password: string) => call<{ ok: boolean }>('POST', '/api/me/password', { old, password }),
  deleteAccount: (password: string) => call<{ ok: boolean }>('POST', '/api/me/delete', { password }),
  privacy: () => call<{ contact: string | null; mail: boolean }>('GET', '/api/privacy'),
  dropInvite: (id: number) => call<{ ok: boolean }>('DELETE', `/api/me/invites/${id}`),
  users: (q: string) => call<UserListItem[]>('GET', `/api/users?q=${encodeURIComponent(q)}`),
  profile: (name: string) => call<Profile>('GET', `/api/users/${encodeURIComponent(name)}`),
  friends: () => call<FriendsList>('GET', '/api/friends'),
  befriend: (name: string) => call<{ relation: string }>('POST', `/api/friends/${encodeURIComponent(name)}`),
  unfriend: (name: string) => call<{ ok: boolean }>('DELETE', `/api/friends/${encodeURIComponent(name)}`),
  invite: (code: string, token: string, to: 'all' | string[]) => call<{ invited: number }>('POST', `/api/games/${encodeURIComponent(code)}/invite`, { token, to }),
};

// ---------------------------------------------------------------- Sync

const readLocal = (k: string) => loadJson<unknown>(k, null);

/** Account-Stand in den Browser schreiben (true = es hat sich etwas geändert) */
function applyServer(data: Record<string, unknown>, merge: boolean): { changedLocal: boolean; upload: Record<string, unknown> } {
  let changedLocal = false;
  const upload: Record<string, unknown> = {};
  for (const [k, policy] of Object.entries(SYNC)) {
    const local = readLocal(k);
    const server = data[k];
    let next: unknown;
    if (server === undefined) next = local;
    else if (merge && policy === 'merge') next = mergeProgress(local, server);
    else if (merge && policy === 'account' && local != null && k === 'oeffi-guesser-prefs-v2') next = { ...(local as object), ...(server as object) };
    else next = server;
    if (next == null) continue;
    if (JSON.stringify(next) !== JSON.stringify(local)) {
      writing = true;
      saveJson(k, next);
      writing = false;
      changedLocal = true;
    }
    if (JSON.stringify(next) !== JSON.stringify(server)) upload[k] = next;
  }
  return { changedLocal, upload };
}

let writing = false;
let pending: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(keepalive = false): Promise<unknown> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!account.me || !Object.keys(pending).length) return Promise.resolve();
  const data = pending;
  pending = {};
  return fetch('/api/me/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }), keepalive }).catch(() => {
    pending = { ...data, ...pending };
  });
}

onSaveJson((key, v) => {
  if (writing || !account.me || !(key in SYNC)) return;
  pending[key] = v;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 1500);
});
// Tab zu: Rest noch schicken
addEventListener('pagehide', () => void flush(true));

/** beim Start (boot.ts, vor der App): Account laden und seinen Stand übernehmen */
export async function preload() {
  try {
    const { user } = await accountApi.me();
    account.me = user;
    if (user) {
      const { upload } = applyServer(user.data, false);
      if (Object.keys(upload).length) void accountApi.saveData(upload).catch(() => {});
    }
  } catch {
    /* Server nicht erreichbar – main.ts zeigt das */
  }
}

/** nach Anmelden/Registrieren/Reset: Stand zusammenführen; neu laden, damit alle Bildschirme ihn sehen */
export async function signedIn(me: Me) {
  account.me = me;
  const { changedLocal, upload } = applyServer(me.data, true);
  // Name im Spiel = Account-Name
  const prefs = loadJson<Record<string, unknown>>('oeffi-guesser-prefs-v2', {});
  if (prefs.name !== me.name) {
    saveJson('oeffi-guesser-prefs-v2', { ...prefs, name: me.name });
    upload['oeffi-guesser-prefs-v2'] = { ...prefs, name: me.name };
  }
  if (Object.keys(upload).length) await accountApi.saveData(upload).catch(() => {});
  saveJson(SEEN_MEDALS, me.medals.filter((m) => m.at).map((m) => m.id));
  if (changedLocal) location.reload();
  else changed();
}

/**
 * Abmelden: Der Spielstand ist im Account gespeichert und wird aus diesem Browser entfernt – sonst würde er beim
 * nächsten Anmelden (vielleicht jemand anderes am selben Gerät) in dessen Account übernommen. Neu laden, damit kein
 * Bildschirm den alten Stand im Speicher behält.
 */
export async function signOut() {
  await flush();
  await accountApi.logout().catch(() => {});
  account.me = null;
  writing = true;
  for (const k of Object.keys(SYNC)) if (k !== 'oeffi-guesser-prefs-v2') saveJson(k, null);
  writing = false;
  location.reload();
}

/** Account endgültig löschen; danach wie abgemeldet (Daten in diesem Browser bleiben nicht als Account-Stand stehen) */
export async function deleteAccount(password: string) {
  await accountApi.deleteAccount(password);
  account.me = null;
  writing = true;
  for (const k of Object.keys(SYNC)) if (k !== 'oeffi-guesser-prefs-v2') saveJson(k, null);
  writing = false;
  location.reload();
}

// ---------------------------------------------------------------- Nachfragen

/** neue Medaillen seit dem letzten Mal (und merken) */
export function newMedals(me: Me) {
  const seen = new Set(loadJson<string[]>(SEEN_MEDALS, []));
  const fresh = me.medals.filter((m) => m.at && !seen.has(m.id));
  if (fresh.length) saveJson(SEEN_MEDALS, [...seen, ...fresh.map((m) => m.id)]);
  return fresh;
}

export async function refresh() {
  try {
    const { user } = await accountApi.me();
    const was = account.me;
    account.me = user;
    if (JSON.stringify({ ...was, data: null }) !== JSON.stringify({ ...user, data: null })) changed();
  } catch {
    /* später nochmal */
  }
}

export function startPolling() {
  setInterval(() => {
    if (account.me && document.visibilityState === 'visible') void refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && account.me && void refresh());
}
