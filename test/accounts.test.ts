// Accounts: Registrieren/Anmelden/Cookie, Passwort-Reset per Mail, Spielstand-Sync, Freunde, Einladungen,
// Statistik (Lieblingslinien mit „bewusster Wahl“), Medaillen, Level
import './support/scale.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { Evaluation, RoundReveal } from '../shared/types.ts';
import { Accounts, COURSE_COUNT, hashPassword, levelOf, verifyPassword } from '../server/accounts.ts';
import { createApp } from '../server/app.ts';
import type { Lobby } from '../server/lobby.ts';
import { Network } from '../server/network.ts';
import { COURSES } from '../client/src/learn/courses/list.ts';
import type { GameManager } from '../server/manager.ts';
import { installEfaMock } from './support/efa-mock.ts';

// Test-Schnittstelle (Zeit vorspulen) – nur mit TEST_HOOKS=1, nie im Betrieb
process.env.TEST_HOOKS = '1';
const net = Network.load();
const mails: { to: string; text: string }[] = [];
let base = '';
let server: http.Server;
let games: GameManager;
let accounts: Accounts;
/** echtes fetch für die HTTP-Aufrufe an den Testserver – die Auskunfts-Attrappe ersetzt globalThis.fetch */
const realFetch = globalThis.fetch;

before(async () => {
  await installEfaMock();
  const made = createApp({ net, version: 'test', accountsDb: ':memory:', mail: async (to, _s, text) => void mails.push({ to, text }) });
  const { app } = made;
  games = made.games;
  accounts = made.accounts;
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

/** ein „Browser“ mit eigenem Cookie */
function browser() {
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown, json = true, extra: Record<string, string> = {}) => {
    const res = await realFetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': json ? 'application/json' : 'text/plain' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body === undefined ? undefined : json ? JSON.stringify(body) : String(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /bg_sid=([^;]*)/.exec(set)![1] ? `bg_sid=${/bg_sid=([^;]*)/.exec(set)![1]}` : '';
    return { status: res.status, body: await res.json().catch(() => null), setCookie: set };
  };
  return {
    call,
    get cookie() {
      return cookie;
    },
    set cookie(c: string) {
      cookie = c;
    },
  };
}

const uniq = (p: string) => `${p}${Math.random().toString(36).slice(2, 7)}`;

describe('Passwörter und Level', () => {
  test('Argon2id: richtig/falsch, Salz macht jeden Hash anders', async () => {
    const a = await hashPassword('geheim123');
    const b = await hashPassword('geheim123');
    assert.notEqual(a, b);
    assert.match(a, /^argon2id\$m=19456,t=2,p=1\$/);
    assert.equal(await verifyPassword('geheim123', a), true);
    assert.equal(await verifyPassword('geheim124', a), false);
    assert.equal(await verifyPassword('x', 'kaputt'), false);
  });

  test('Level: 100, dann je 50 XP mehr pro Level', () => {
    assert.deepEqual(levelOf(0), { level: 1, xp: 0, levelXp: 0, nextXp: 100 });
    assert.equal(levelOf(99).level, 1);
    assert.equal(levelOf(100).level, 2);
    assert.equal(levelOf(250).level, 3);
    assert.deepEqual(levelOf(260), { level: 3, xp: 260, levelXp: 250, nextXp: 450 });
  });

  test('Kursanzahl passt zum Lernpfad', () => assert.equal(COURSE_COUNT, COURSES.length));
});

describe('Registrieren, Anmelden, Sitzung', () => {
  test('Registrieren setzt ein langlebiges HttpOnly-Cookie, /api/me kennt den Account', async () => {
    const b = browser();
    const name = uniq('Anna');
    const r = await b.call('POST', '/api/auth/register', { name, password: 'passwort1', email: `${name}@example.org` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, name);
    assert.match(r.setCookie!, /HttpOnly/);
    assert.match(r.setCookie!, /SameSite=Lax/);
    assert.match(r.setCookie!, /Max-Age=15552000/);
    const me = await b.call('GET', '/api/me');
    assert.equal(me.body.user.name, name);
    assert.equal(me.body.user.level.level, 1);
  });

  test('Fehlerfälle: Name doppelt (Groß/klein egal), ungültig, Passwort zu kurz, E-Mail kaputt', async () => {
    const name = uniq('Ben');
    assert.equal((await browser().call('POST', '/api/auth/register', { name, password: 'passwort1' })).status, 200);
    assert.equal((await browser().call('POST', '/api/auth/register', { name: name.toUpperCase(), password: 'passwort1' })).status, 409);
    assert.equal((await browser().call('POST', '/api/auth/register', { name: 'a b', password: 'passwort1' })).status, 400);
    assert.equal((await browser().call('POST', '/api/auth/register', { name: uniq('C'), password: 'kurz' })).status, 400);
    assert.equal((await browser().call('POST', '/api/auth/register', { name: uniq('D'), password: 'passwort1', email: 'keine-mail' })).status, 400);
  });

  test('Anmelden mit Name oder E-Mail, falsches Passwort 401, Abmelden', async () => {
    const name = uniq('Cleo');
    await browser().call('POST', '/api/auth/register', { name, password: 'passwort1', email: `${name}@example.org` });
    const b = browser();
    assert.equal((await b.call('POST', '/api/auth/login', { name, password: 'falsch123' })).status, 401);
    assert.equal((await b.call('POST', '/api/auth/login', { name: `${name}@EXAMPLE.org`, password: 'passwort1' })).status, 200);
    assert.equal((await b.call('GET', '/api/me')).body.user.name, name);
    await b.call('POST', '/api/auth/logout', {});
    assert.equal((await b.call('GET', '/api/me')).body.user, null);
  });

  test('CSRF: ändernde Anfragen nur als JSON', async () => {
    const b = browser();
    const r = await b.call('POST', '/api/auth/login', 'name=x&password=y', false);
    assert.equal(r.status, 415);
  });

  test('Passwort vergessen: Mail mit Link, Reset meldet an und alle alten Sitzungen ab, Link nur einmal', async () => {
    const name = uniq('Dora');
    const old = browser();
    await old.call('POST', '/api/auth/register', { name, password: 'passwort1', email: `${name}@example.org` });
    mails.length = 0;
    assert.equal((await browser().call('POST', '/api/auth/forgot', { email: 'gibtsnicht@example.org' })).status, 200);
    assert.equal(mails.length, 0, 'unbekannte Adresse: keine Mail, aber gleiche Antwort');
    assert.equal((await browser().call('POST', '/api/auth/forgot', { email: `${name}@example.org` })).status, 200);
    assert.equal(mails.length, 1);
    const token = /\?reset=([A-Za-z0-9_-]+)/.exec(mails[0].text)![1];
    assert.match(mails[0].text, new RegExp(`${name}: http://localhost:\\d+/\\?reset=`));
    const b = browser();
    const r = await b.call('POST', '/api/auth/reset', { token, password: 'neuesPasswort' });
    assert.equal(r.status, 200);
    assert.equal((await b.call('GET', '/api/me')).body.user.name, name);
    assert.equal((await old.call('GET', '/api/me')).body.user, null, 'alte Sitzung abgemeldet');
    assert.equal((await browser().call('POST', '/api/auth/reset', { token, password: 'nochmalNeu1' })).status, 400);
    assert.equal((await browser().call('POST', '/api/auth/login', { name, password: 'neuesPasswort' })).status, 200);
  });
});

describe('Spielstand, Freunde, Einladungen', () => {
  test('Spielstand-Sync: nur oeffi-Schlüssel, Tutorial gibt Medaille und XP', async () => {
    const b = browser();
    await b.call('POST', '/api/auth/register', { name: uniq('Emil'), password: 'passwort1' });
    const r = await b.call('PUT', '/api/me/data', { data: { 'oeffi-progress-v1': { tutorialDone: true, played: 1 }, fremd: 1, 'oeffi-my-lines-v1': ['U1'] } });
    assert.equal(r.status, 200);
    const me = (await b.call('GET', '/api/me')).body.user;
    assert.deepEqual(Object.keys(me.data).sort(), ['oeffi-my-lines-v1', 'oeffi-progress-v1']);
    assert.ok(me.medals.find((m: { id: string }) => m.id === 'tutorial').at);
    assert.equal(me.level.xp, 50);
    await b.call('PUT', '/api/me/data', { data: { 'oeffi-my-lines-v1': null } });
    assert.equal((await b.call('GET', '/api/me')).body.user.data['oeffi-my-lines-v1'], undefined);
  });

  test('Freunde: Anfrage, Gegenanfrage = befreundet; Profil-Statistik nur für Freunde; Einladung in eine Lobby', async () => {
    const a = browser();
    const b = browser();
    const c = browser();
    const [na, nb, nc] = [uniq('Fritz'), uniq('Gina'), uniq('Hans')];
    await a.call('POST', '/api/auth/register', { name: na, password: 'passwort1' });
    await b.call('POST', '/api/auth/register', { name: nb, password: 'passwort1' });
    await c.call('POST', '/api/auth/register', { name: nc, password: 'passwort1' });
    assert.equal((await a.call('POST', `/api/friends/${nb}`, {})).body.relation, 'outgoing');
    assert.equal((await b.call('GET', '/api/me')).body.user.friendRequests, 1);
    assert.equal((await b.call('GET', '/api/friends')).body.incoming[0].name, na);
    assert.equal((await b.call('POST', `/api/friends/${na}`, {})).body.relation, 'friend');
    assert.equal((await a.call('GET', '/api/friends')).body.friends[0].name, nb);
    // Profil: Freund sieht Statistik, Fremder nicht
    assert.ok((await b.call('GET', `/api/users/${na}`)).body.stats);
    assert.equal((await c.call('GET', `/api/users/${na}`)).body.stats, null);
    // Leute-Liste mit Beziehung
    const list = (await a.call('GET', `/api/users?q=${nb.slice(0, 6)}`)).body;
    assert.equal(list.find((x: { name: string }) => x.name === nb).relation, 'friend');

    // Lobby: Account-Name am Spieler, Einladung an alle Freunde
    const lobby = await a.call('POST', '/api/games', { mode: 'quiz', playerName: na, settings: {} });
    assert.equal(lobby.body.state.players[0].account, na);
    const code = lobby.body.state.id;
    const inv = await a.call('POST', `/api/games/${code}/invite`, { token: lobby.body.token, to: 'all' });
    assert.equal(inv.body.invited, 1);
    // Fremde (nicht befreundet) lassen sich nicht einladen
    assert.equal((await a.call('POST', `/api/games/${code}/invite`, { token: lobby.body.token, to: [nc] })).status, 400);
    const invites = (await b.call('GET', '/api/me')).body.user.invites;
    assert.equal(invites.length, 1);
    assert.equal(invites[0].from, na);
    assert.equal(invites[0].code, code);
    assert.equal((await c.call('GET', '/api/me')).body.user.invites.length, 0);
    await b.call('DELETE', `/api/me/invites/${invites[0].id}`, {});
    assert.equal((await b.call('GET', '/api/me')).body.user.invites.length, 0);
    // Freundschaft beenden
    await a.call('DELETE', `/api/friends/${nb}`, {});
    assert.equal((await a.call('GET', '/api/friends')).body.friends.length, 0);
  });
});

describe('Statistik', () => {
  /** Lobby-Attrappe: Runden- und Spielende-Events wie Game */
  function fakeLobby(players: { playerId: string; userId: number; score: number }[]) {
    const e = new EventEmitter() as EventEmitter & Pick<Lobby, 'accounts' | 'ranking' | 'mode'>;
    Object.assign(e, { mode: 'route', accounts: () => players, ranking: () => [...players].sort((x, y) => y.score - x.score).map((p) => ({ playerId: p.playerId, score: p.score })) });
    return e;
  }
  const st = (name: string, line: string) => net.data.stations.find((s) => s.name === name && s.lines.includes(line))!;
  const ev = (playerId: string, route: number, total: number, legs: Evaluation['legs']): Evaluation =>
    ({ playerId, playerName: playerId, legs, route: null, durationMin: 30, costMin: 30, matchedRank: 0, source: 'top', error: null, elapsedSec: 60, timedOut: false, tips: [], guesses: null, locateDist: null, score: { route, tipShare: 0, routeAfterTips: route, timeBonus: 0, locate: 0, multiplier: 1, total } }) as Evaluation;

  test('Lieblingslinie zählt bewusste Wahl: 92B ab Frachtenbahnhof Lobau (sonst nichts) zählt kaum, 95A am Großen Biberhaufen voll', () => {
    const acc = new Accounts(net, { file: ':memory:' });
    const anna = acc.register('Anna', 'passwort1', null);
    return anna.then(({ user }) => {
      const g = fakeLobby([{ playerId: 'p', userId: user.id, score: 1200 }, { playerId: 'q', userId: 999, score: 300 }]);
      acc.watch(g as unknown as Lobby);
      const lobau = st('Frachtenbahnhof Lobau', '92B');
      const biber = st('Großer Biberhaufen', '95A');
      assert.ok(lobau && biber, 'Stationen im Netz');
      const somewhere = (from: string, line: string) => {
        const l = net.lines.get(line)!;
        const pat = l.patterns.find((p) => p.includes(from) && p.indexOf(from) < p.length - 1)!;
        return { line, from, to: pat[pat.length - 1] };
      };
      // 3× 92B (erzwungen), 1× 95A (gewählt)
      for (let i = 0; i < 3; i++)
        g.emit('roundResult', { index: i, routes: [], cancelled: false, evaluations: [ev('p', 950, 1100, [somewhere(lobau.id, '92B')])] } satisfies RoundReveal);
      g.emit('roundResult', { index: 3, routes: [], cancelled: false, evaluations: [ev('p', 1300, 1500, [somewhere(biber.id, '95A')])] } satisfies RoundReveal);
      g.emit('finished');
      const s = acc.stats(user.id);
      assert.equal(s.favorites.B?.id, '95A', '1× bewusst gewählt schlägt 3× ohne Alternative');
      assert.equal(s.rounds, 4);
      assert.equal(s.games, 1);
      assert.equal(s.wins, 1);
      assert.equal(s.beatApi, 1);
      assert.equal(s.minutes, 120);
      const medals = new Set(acc.medals(user.id).filter((m) => m.at).map((m) => m.id));
      for (const m of ['first-game', 'perfect', 'beat-api', 'max-route', 'winner']) assert.ok(medals.has(m), m);
      assert.ok(acc.level(user.id).xp > 300);
      acc.close();
    });
  });

  test('Lieblingsstation: nur Umstiege zählen (Start ist vorgegeben)', async () => {
    const acc = new Accounts(net, { file: ':memory:' });
    const { user } = await acc.register('Berta', 'passwort1', null);
    const g = fakeLobby([{ playerId: 'p', userId: user.id, score: 500 }]);
    acc.watch(g as unknown as Lobby);
    const prater = st('Praterstern', 'U1');
    const karls = st('Karlsplatz', 'U1');
    const legs = [
      { line: 'U1', from: prater.id, to: karls.id },
      { line: 'U4', from: karls.id, to: st('Schwedenplatz', 'U4').id },
    ];
    g.emit('roundResult', { index: 0, routes: [], cancelled: false, evaluations: [ev('p', 800, 800, legs)] } satisfies RoundReveal);
    const s = acc.stats(user.id);
    assert.equal(s.favoriteStation?.name, 'Karlsplatz');
    assert.equal(s.favorites.U?.id, 'U1');
    acc.close();
  });
});

// ================================================================ gründlich: Sitzungen, Konto, Grenzen

/** Account anlegen, „Browser“ ist angemeldet */
async function newUser(prefix: string, email = true) {
  const b = browser();
  const name = uniq(prefix);
  const r = await b.call('POST', '/api/auth/register', { name, password: 'passwort1', ...(email ? { email: `${name.toLowerCase()}@example.org` } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = accounts.userFor(b.cookie.split('=')[1])!.id;
  return { b, name, id };
}
const db = () => (accounts as unknown as { db: import('node:sqlite').DatabaseSync }).db;

describe('Sitzungen und Konto', () => {
  test('mehrere Geräte: Passwort ändern meldet die anderen ab, dieses bleibt; falsches altes Passwort 401', async () => {
    const { b, name } = await newUser('Sitz');
    const other = browser();
    assert.equal((await other.call('POST', '/api/auth/login', { name, password: 'passwort1' })).status, 200);
    assert.equal((await b.call('POST', '/api/me/password', { old: 'falsch999', password: 'neuesPw123' })).status, 401);
    assert.equal((await b.call('POST', '/api/me/password', { old: 'passwort1', password: 'kurz' })).status, 400);
    assert.equal((await b.call('POST', '/api/me/password', { old: 'passwort1', password: 'neuesPw123' })).status, 200);
    assert.equal((await b.call('GET', '/api/me')).body.user.name, name);
    assert.equal((await other.call('GET', '/api/me')).body.user, null);
    assert.equal((await browser().call('POST', '/api/auth/login', { name, password: 'passwort1' })).status, 401);
    assert.equal((await browser().call('POST', '/api/auth/login', { name, password: 'neuesPw123' })).status, 200);
  });

  test('Abmelden beendet nur diese Sitzung; abgelaufene Sitzung gilt nicht; kaputtes Cookie = nicht angemeldet', async () => {
    const { b, name, id } = await newUser('Ablauf');
    const other = browser();
    await other.call('POST', '/api/auth/login', { name, password: 'passwort1' });
    await b.call('POST', '/api/auth/logout', {});
    assert.equal((await b.call('GET', '/api/me')).body.user, null);
    assert.equal((await other.call('GET', '/api/me')).body.user.name, name);
    db().prepare('UPDATE sessions SET expires = 1 WHERE user_id = ?').run(id);
    assert.equal((await other.call('GET', '/api/me')).body.user, null);
    const fake = browser();
    fake.cookie = 'bg_sid=gibtsnichtgibtsnichtgibtsnicht12345';
    assert.equal((await fake.call('GET', '/api/me')).body.user, null);
    assert.equal((await fake.call('PUT', '/api/me/data', { data: {} })).status, 401);
  });

  test('Cookie über HTTPS (Proxy) mit Secure, über HTTP ohne', async () => {
    const b = browser();
    const name = uniq('Sec');
    const r = await b.call('POST', '/api/auth/register', { name, password: 'passwort1' }, true, { 'X-Forwarded-Proto': 'https' });
    assert.match(r.setCookie!, /; Secure/);
    const plain = await browser().call('POST', '/api/auth/login', { name, password: 'passwort1' });
    assert.doesNotMatch(plain.setCookie!, /Secure/);
  });

  test('gleichzeitig dreimal derselbe Name → genau einer klappt', async () => {
    const name = uniq('Zwilling');
    const rs = await Promise.all([1, 2, 3].map(() => browser().call('POST', '/api/auth/register', { name, password: 'passwort1' })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  });

  test('E-Mail ändern (ungültig → 400), danach Anmelden und Reset über die neue Adresse; ohne Adresse kein Reset', async () => {
    const { b, name } = await newUser('Mail', false);
    assert.equal((await b.call('PUT', '/api/me/email', { email: 'kaputt@' })).status, 400);
    const r = await b.call('PUT', '/api/me/email', { email: `NEU.${name}@Example.org` });
    assert.equal(r.body.email, `neu.${name.toLowerCase()}@example.org`);
    assert.equal((await browser().call('POST', '/api/auth/login', { name: `neu.${name}@example.org`, password: 'passwort1' })).status, 200);
    mails.length = 0;
    await browser().call('POST', '/api/auth/forgot', { email: `neu.${name}@example.org` });
    assert.equal(mails.length, 1);
    await b.call('PUT', '/api/me/email', { email: '' });
    mails.length = 0;
    await browser().call('POST', '/api/auth/forgot', { email: `neu.${name}@example.org` });
    assert.equal(mails.length, 0);
  });

  test('Reset: zu kurzes Passwort verbraucht den Link nicht; abgelaufener oder falscher Link 400; zwei Accounts mit einer Adresse', async () => {
    const shared = `${uniq('fam')}@example.org`;
    const na = uniq('Mama');
    const nb = uniq('Kind');
    await browser().call('POST', '/api/auth/register', { name: na, password: 'passwort1', email: shared });
    await browser().call('POST', '/api/auth/register', { name: nb, password: 'passwort1', email: shared });
    mails.length = 0;
    await browser().call('POST', '/api/auth/forgot', { email: shared });
    assert.equal(mails.length, 1, 'eine Mail mit beiden Links');
    const links = [...mails[0].text.matchAll(/^(\S+): \S+\?reset=([A-Za-z0-9_-]+)$/gm)].map((m) => ({ name: m[1], token: m[2] }));
    assert.deepEqual(links.map((l) => l.name).sort(), [na, nb].sort());
    const tKind = links.find((l) => l.name === nb)!.token;
    assert.equal((await browser().call('POST', '/api/auth/reset', { token: tKind, password: 'kurz' })).status, 400);
    const ok = browser();
    assert.equal((await ok.call('POST', '/api/auth/reset', { token: tKind, password: 'kindNeu123' })).status, 200);
    assert.equal((await ok.call('GET', '/api/me')).body.user.name, nb, 'Reset meldet den richtigen Account an');
    assert.equal((await browser().call('POST', '/api/auth/login', { name: na, password: 'passwort1' })).status, 200, 'anderer Account unverändert');
    assert.equal((await browser().call('POST', '/api/auth/reset', { token: 'falsch', password: 'egalegal1' })).status, 400);
    mails.length = 0;
    await browser().call('POST', '/api/auth/forgot', { email: shared });
    const line = mails[0].text.split('\n').find((l) => l.startsWith(`${na}:`))!;
    const tMama = /\?reset=([A-Za-z0-9_-]+)/.exec(line)![1];
    db().prepare('UPDATE resets SET expires = 1').run();
    assert.equal((await browser().call('POST', '/api/auth/reset', { token: tMama, password: 'mamaNeu123' })).status, 400);
  });

  test('Passwort vergessen ohne Mailversand → 503 mit Erklärung', async () => {
    const { app } = createApp({ net, version: 'test', accountsDb: ':memory:', mail: undefined });
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, r));
    const res = await realFetch(`http://localhost:${(srv.address() as AddressInfo).port}/api/auth/forgot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.org' }),
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /nicht eingerichtet/);
    srv.close();
  });

  test('Spielstand: Grenzen – zu groß 413, kein Objekt 400, nur gültige oeffi-Schlüssel', async () => {
    const { b } = await newUser('Daten');
    assert.equal((await b.call('PUT', '/api/me/data', { data: { 'oeffi-big-v1': 'x'.repeat(250_000) } })).status, 413);
    assert.equal((await b.call('PUT', '/api/me/data', { data: [1, 2] })).status, 400);
    assert.equal((await b.call('PUT', '/api/me/data', { data: 'text' })).status, 400);
    await b.call('PUT', '/api/me/data', { data: { x: 1, 'oeffi-ok-v1': { a: 1 }, 'OEFFI-gross': 1, 'oeffi-../x': 1 } });
    assert.deepEqual(Object.keys((await b.call('GET', '/api/me')).body.user.data), ['oeffi-ok-v1']);
  });

  test('CSRF: alle ändernden Account-Anfragen nur als JSON', async () => {
    const { b, name } = await newUser('Csrf');
    const cases: [string, string][] = [
      ['PUT', '/api/me/data'],
      ['PUT', '/api/me/email'],
      ['POST', '/api/me/password'],
      ['POST', '/api/auth/logout'],
      ['POST', `/api/friends/${name}`],
      ['DELETE', `/api/friends/${name}`],
    ];
    for (const [m, u] of cases) assert.equal((await b.call(m, u, 'a=b', false)).status, 415, `${m} ${u}`);
    assert.equal((await b.call('GET', '/api/me')).body.user.name, name, 'noch angemeldet');
  });
});

describe('Leute, Freunde, Profile – Grenzfälle', () => {
  test('Freund: sich selbst 400, unbekannt 404, doppelte Anfrage bleibt eine, beide Seiten können beenden', async () => {
    const a = await newUser('Ida');
    const b = await newUser('Jan');
    assert.equal((await a.b.call('POST', `/api/friends/${a.name}`, {})).status, 400);
    assert.equal((await a.b.call('POST', '/api/friends/gibtsnichtxyz', {})).status, 404);
    await a.b.call('POST', `/api/friends/${b.name}`, {});
    assert.equal((await a.b.call('POST', `/api/friends/${b.name}`, {})).body.relation, 'outgoing');
    assert.equal((await b.b.call('GET', '/api/friends')).body.incoming.length, 1);
    assert.equal((await b.b.call('POST', `/api/friends/${a.name.toUpperCase()}`, {})).body.relation, 'friend', 'Groß/klein egal');
    await b.b.call('DELETE', `/api/friends/${a.name}`, {});
    assert.equal((await a.b.call('GET', '/api/friends')).body.friends.length, 0);
    assert.equal((await browser().call('GET', '/api/friends')).status, 401);
    assert.equal((await browser().call('POST', `/api/friends/${a.name}`, {})).status, 401);
  });

  test('Suche: % und _ sind normale Zeichen; ohne Anmeldung ohne Beziehung; nie E-Mails; Profil unbekannt 404', async () => {
    const a = await newUser('Kai');
    assert.equal((await a.b.call('GET', '/api/users?q=%25')).body.length, 0);
    assert.equal((await a.b.call('GET', '/api/users?q=_')).body.length, 0);
    const anon = (await browser().call('GET', `/api/users?q=${a.name}`)).body;
    assert.equal(anon[0].name, a.name);
    assert.equal(anon[0].relation, null);
    assert.equal((await a.b.call('GET', `/api/users?q=${a.name}`)).body[0].relation, 'self');
    assert.equal((await browser().call('GET', '/api/users/gibtsnichtxyz')).status, 404);
    const p = (await browser().call('GET', `/api/users/${a.name}`)).body;
    assert.equal(p.stats, null);
    assert.equal(p.medals.length, 14);
    assert.equal(JSON.stringify(p).includes('@'), false, 'keine E-Mail im Profil');
    assert.equal(JSON.stringify(anon).includes('@'), false, 'keine E-Mail in der Liste');
  });

  test('Einladungen: nur angemeldet, nur Mitglieder, nur Freunde; neue ersetzt alte; verschwindet mit der Lobby', async () => {
    const a = await newUser('Lea');
    const b = await newUser('Max');
    await a.b.call('POST', `/api/friends/${b.name}`, {});
    await b.b.call('POST', `/api/friends/${a.name}`, {});
    const lobby = (await a.b.call('POST', '/api/games', { mode: 'route', playerName: 'x', settings: {} })).body;
    const code = lobby.state.id;
    assert.equal(lobby.state.players[0].account, a.name, 'Account-Name am Spieler');
    assert.equal((await browser().call('POST', `/api/games/${code}/invite`, { token: lobby.token, to: 'all' })).status, 401);
    assert.equal((await a.b.call('POST', `/api/games/${code}/invite`, { token: 'falsch', to: 'all' })).status, 403);
    assert.equal((await a.b.call('POST', `/api/games/${code}/invite`, { token: lobby.token, to: [] })).status, 400);
    await a.b.call('POST', `/api/games/${code}/invite`, { token: lobby.token, to: [b.name] });
    await a.b.call('POST', `/api/games/${code}/invite`, { token: lobby.token, to: 'all' });
    const inv = (await b.b.call('GET', '/api/me')).body.user.invites;
    assert.equal(inv.length, 1, 'zweite Einladung ersetzt die erste');
    assert.equal(inv[0].mode, 'route');
    await a.b.call('DELETE', `/api/me/invites/${inv[0].id}`, {});
    assert.equal((await b.b.call('GET', '/api/me')).body.user.invites.length, 1, 'fremde Einladung löschen geht nicht');
    const anon = (await browser().call('POST', `/api/games/${code}/join`, { playerName: 'Gast' })).body;
    assert.equal(anon.state.players.find((p: { name: string }) => p.name === 'Gast').account, undefined, 'ohne Anmeldung kein Account am Spieler');
    (games.get(code) as unknown as { close(r: string): void }).close('Test');
    assert.equal((await b.b.call('GET', '/api/me')).body.user.invites.length, 0, 'Lobby zu → Einladung weg');
    assert.deepEqual((await a.b.call('GET', '/api/me')).body.user.friendsOnline, [b.name]);
  });
});

describe('Statistik aus echten Spielabläufen', () => {
  test('Quiz: zwei Accounts, A antwortet alles richtig → Sieg, Quiz-Ass, XP; B ohne Medaille', async () => {
    const a = await newUser('Quizzer');
    const b = await newUser('Rater');
    const lobby = (await a.b.call('POST', '/api/games', { mode: 'quiz', playerName: 'A', settings: { questions: 5, modes: ['U', 'S'], weights: { draw: 1 } } })).body;
    const code = lobby.state.id;
    const jb = (await b.b.call('POST', `/api/games/${code}/join`, { playerName: 'B' })).body;
    const xpBefore = accounts.level(a.id).xp;
    let st = (await a.b.call('POST', `/api/games/${code}/start`, { token: lobby.token })).body;
    const qs = (games.get(code) as unknown as { questions: { correct: unknown; type: string; multi?: boolean; options?: { id: string }[] }[] }).questions;
    for (let i = 0; i < st.total; i++) {
      const q = qs[i];
      const wrong = q.type === 'locate' ? [48.0, 16.0] : q.multi ? [] : ((q.options ?? []).find((o) => o.id !== q.correct)?.id ?? 'x');
      await b.b.call('POST', `/api/games/${code}/quiz/answer`, { token: jb.token, index: i, answer: wrong });
      st = (await a.b.call('POST', `/api/games/${code}/quiz/answer`, { token: lobby.token, index: i, answer: q.correct })).body;
      assert.equal(st.status, 'revealed');
      st = (await a.b.call('POST', `/api/games/${code}/next`, { token: lobby.token })).body;
    }
    assert.equal(st.phase, 'finished');
    const sa = accounts.stats(a.id);
    assert.equal(sa.quizGames, 1);
    assert.equal(sa.quizWins, 1);
    assert.ok(accounts.medals(a.id).find((m) => m.id === 'quiz-ace')!.at, 'Quiz-Ass');
    assert.ok(accounts.level(a.id).xp >= xpBefore + 10 + 20, 'XP für Quiz und Sieg');
    const sb = accounts.stats(b.id);
    assert.equal(sb.quizGames, 1);
    assert.equal(sb.quizWins, 0);
    assert.equal(accounts.medals(b.id).find((m) => m.id === 'quiz-ace')!.at, null);
    assert.equal(sb.recent[0].kind, 'quiz');
    assert.equal(sb.recent[0].rank, 2);
  });

  test('Routenjagd über HTTP: Runden und Spielende werden gezählt (Auskunfts-Attrappe)', async () => {
    const a = await newUser('Jaeger');
    const lobby = (await a.b.call('POST', '/api/games', { mode: 'route', playerName: 'A', settings: {} })).body;
    const code = lobby.state.id;
    await a.b.call('PUT', `/api/games/${code}/settings`, {
      token: lobby.token,
      settings: { rounds: 3, locate: false, restrictions: 'never', minTransfers: 0, roundTimeLimitSec: null, stations: ['U'] },
    });
    let st = (await a.b.call('POST', `/api/games/${code}/start`, { token: lobby.token })).body;
    assert.equal(st.phase, 'playing', JSON.stringify(st).slice(0, 300));
    for (let r = 0; r < 3; r++) {
      const round = st.rounds[r];
      const sub = await a.b.call('POST', `/api/games/${code}/rounds/${r}/submit`, { token: lobby.token, legs: [{ line: 'U6', from: round.from.id, to: round.to.id }], guesses: null });
      assert.equal(sub.status, 200, JSON.stringify(sub.body));
      st = (await a.b.call('POST', `/api/games/${code}/next`, { token: lobby.token })).body;
    }
    assert.equal(st.phase, 'finished');
    const s = accounts.stats(a.id);
    assert.equal(s.rounds, 3);
    assert.equal(s.games, 1);
    assert.equal(s.wins, 0, 'allein ist kein Sieg');
    assert.ok(accounts.medals(a.id).find((m) => m.id === 'first-game')!.at);
    assert.equal(s.recent[0].kind, 'game');
  });

  test('Training: ausgewertete Strecke zählt einmal (auch bei mehrfachem Auswerten), Lieblingslinie U6', async () => {
    const a = await newUser('Trainer');
    const st = (n: string) => net.data.stations.find((x) => x.name === n && x.lines.includes('U6'))!.id;
    const round = (await a.b.call('POST', '/api/training/round', { settings: { difficulty: 'easy' }, pair: { from: st('Westbahnhof'), to: st('Spittelau') } })).body;
    assert.ok(round.id, JSON.stringify(round).slice(0, 200));
    const legs = [{ line: 'U6', from: st('Westbahnhof'), to: st('Spittelau') }];
    for (let i = 0; i < 3; i++) assert.equal((await a.b.call('POST', `/api/training/${round.id}/evaluate`, { legs })).status, 200);
    const s = accounts.stats(a.id);
    assert.equal(s.trainings, 1);
    assert.equal(s.favorites.U?.id, 'U6');
    assert.equal((await browser().call('POST', `/api/training/${round.id}/evaluate`, { legs })).status, 200, 'ohne Anmeldung: kein Fehler');
  });

  test('Level: Kurse aus dem Spielstand zählen, „alle Kurse“-Medaille erst bei allen 9', async () => {
    const a = await newUser('Lerner');
    const courses: Record<string, unknown> = Object.fromEntries(COURSES.slice(0, 8).map((c) => [c.id, { done: true, best: 1, total: 1, mastered: true }]));
    await a.b.call('PUT', '/api/me/data', { data: { 'oeffi-courses-v1': courses } });
    let me = (await a.b.call('GET', '/api/me')).body.user;
    assert.equal(me.level.xp, 8 * 100);
    assert.equal(me.medals.find((m: { id: string }) => m.id === 'all-courses').at, null);
    courses[COURSES[8].id] = { done: true, best: 1, total: 1 };
    await a.b.call('PUT', '/api/me/data', { data: { 'oeffi-courses-v1': courses } });
    me = (await a.b.call('GET', '/api/me')).body.user;
    assert.ok(me.medals.find((m: { id: string }) => m.id === 'all-courses').at);
    assert.equal(me.medals.find((m: { id: string }) => m.id === 'master').at, null, 'einer noch nicht gemeistert');
    assert.equal((await a.b.call('GET', `/api/users/${a.name}`)).body.stats.coursesDone, 9);
  });
});

describe('Zwei Geräte gleichzeitig', () => {
  test('Kurse und Tutorial werden zusammengeführt (älteres Gerät überschreibt nichts), gemerkte Linien: zuletzt gespeichert gilt', async () => {
    const a = await newUser('Zwei');
    const other = browser();
    await other.call('POST', '/api/auth/login', { name: a.name, password: 'passwort1' });
    // Gerät 1: Kurs U-Bahn fertig, Tutorial gemacht · Gerät 2 (älterer Stand): Kurs S-Bahn, Tutorial nicht
    await a.b.call('PUT', '/api/me/data', { data: { 'oeffi-courses-v1': { ubahn: { done: true, best: 5, total: 6 } }, 'oeffi-progress-v1': { tutorialDone: true, played: 3 }, 'oeffi-my-lines-v1': ['U1', 'U2'] } });
    await other.call('PUT', '/api/me/data', { data: { 'oeffi-courses-v1': { sbahn: { done: true, best: 2, total: 4 }, ubahn: { done: true, best: 3, total: 6 } }, 'oeffi-progress-v1': { tutorialDone: false, played: 1 }, 'oeffi-my-lines-v1': ['U1'] } });
    const d = (await a.b.call('GET', '/api/me')).body.user.data;
    assert.deepEqual(d['oeffi-courses-v1'], { ubahn: { done: true, best: 5, total: 6 }, sbahn: { done: true, best: 2, total: 4 } });
    assert.deepEqual(d['oeffi-progress-v1'], { tutorialDone: true, played: 3 });
    assert.deepEqual(d['oeffi-my-lines-v1'], ['U1'], 'abgewählte Linie bleibt abgewählt');
  });
});

// ================================================================ mehrere Accounts zusammen

describe('Mehrere Accounts', () => {
  test('Routenjagd zu zweit: beide Runden und Spiel gezählt, „Sieger“ nur für den Besseren', async () => {
    const a = await newUser('Gewinn');
    const b = await newUser('Verlier');
    const lobby = (await a.b.call('POST', '/api/games', { mode: 'route', playerName: 'A', settings: {} })).body;
    const code = lobby.state.id;
    const jb = (await b.b.call('POST', `/api/games/${code}/join`, { playerName: 'B' })).body;
    assert.deepEqual(jb.state.players.map((p: { account?: string }) => p.account).sort(), [a.name, b.name].sort(), 'beide mit Account in der Lobby');
    // „Wo liegt das?“ an: A tippt genau richtig, B gar nicht → A gewinnt sicher
    await a.b.call('PUT', `/api/games/${code}/settings`, { token: lobby.token, settings: { rounds: 2, locate: true, restrictions: 'never', minTransfers: 0, roundTimeLimitSec: null, stations: ['U'] } });
    let st = (await a.b.call('POST', `/api/games/${code}/start`, { token: lobby.token })).body;
    for (let r = 0; r < 2; r++) {
      const round = st.rounds[r];
      const exact = { from: [round.from.lat, round.from.lon], to: [round.to.lat, round.to.lon] };
      await b.b.call('POST', `/api/games/${code}/rounds/${r}/submit`, { token: jb.token, legs: [], guesses: null });
      const sub = await a.b.call('POST', `/api/games/${code}/rounds/${r}/submit`, { token: lobby.token, legs: [], guesses: exact });
      assert.equal(sub.status, 200, JSON.stringify(sub.body));
      st = (await a.b.call('POST', `/api/games/${code}/next`, { token: lobby.token })).body;
    }
    assert.equal(st.phase, 'finished');
    const sa = accounts.stats(a.id);
    const sb = accounts.stats(b.id);
    assert.equal(sa.games, 1);
    assert.equal(sb.games, 1);
    assert.equal(sa.rounds, 2);
    assert.equal(sb.rounds, 2);
    assert.equal(sa.wins, 1, 'A hat gewonnen');
    assert.equal(sb.wins, 0);
    assert.ok(accounts.medals(a.id).find((m) => m.id === 'winner')!.at);
    assert.equal(accounts.medals(b.id).find((m) => m.id === 'winner')!.at, null);
    assert.equal(sb.recent[0].rank, 2);
    assert.equal(sb.recent[0].players, 2);
  });

  test('gleichzeitige Freundschaftsanfragen in beide Richtungen → befreundet, kein Fehler', async () => {
    const a = await newUser('Zeit');
    const b = await newUser('Gleich');
    const rs = await Promise.all([a.b.call('POST', `/api/friends/${b.name}`, {}), b.b.call('POST', `/api/friends/${a.name}`, {})]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200]);
    assert.ok(rs.some((r) => r.body.relation === 'friend'));
    assert.equal((await a.b.call('GET', '/api/friends')).body.friends[0]?.name, b.name);
    assert.equal((await b.b.call('GET', '/api/friends')).body.friends[0]?.name, a.name);
  });

  test('Einladung an ausgewählte Freunde: nur die bekommen sie; „alle“ erreicht danach auch den Rest', async () => {
    const host = await newUser('Gast');
    const fr = await Promise.all(['Eins', 'Zwei', 'Drei'].map((p) => newUser(p)));
    for (const f of fr) {
      await host.b.call('POST', `/api/friends/${f.name}`, {});
      await f.b.call('POST', `/api/friends/${host.name}`, {});
    }
    const lobby = (await host.b.call('POST', '/api/games', { mode: 'quiz', playerName: 'H', settings: {} })).body;
    const code = lobby.state.id;
    assert.equal((await host.b.call('POST', `/api/games/${code}/invite`, { token: lobby.token, to: [fr[0].name, fr[2].name] })).body.invited, 2);
    const count = async (u: { b: ReturnType<typeof browser> }) => (await u.b.call('GET', '/api/me')).body.user.invites.length;
    assert.deepEqual(await Promise.all(fr.map(count)), [1, 0, 1]);
    assert.equal((await host.b.call('POST', `/api/games/${code}/invite`, { token: lobby.token, to: 'all' })).body.invited, 3);
    assert.deepEqual(await Promise.all(fr.map(count)), [1, 1, 1], 'je eine (erneute Einladung ersetzt die alte)');
    // Groß-/Kleinschreibung egal, Unbekannte werden ignoriert
    assert.equal((await host.b.call('POST', `/api/games/${code}/invite`, { token: lobby.token, to: [fr[1].name.toUpperCase(), 'gibtsnicht'] })).body.invited, 1);
    // der Eingeladene tritt bei → Account am Spieler, Einladung kann weg
    const inv = (await fr[1].b.call('GET', '/api/me')).body.user.invites[0];
    const join = await fr[1].b.call('POST', `/api/games/${inv.code}/join`, { playerName: 'Zwei' });
    assert.equal(join.body.state.players.find((p: { name: string }) => p.name === 'Zwei').account, fr[1].name);
  });

  test('Freundschaft beenden: Statistik wieder privat, Einladen nicht mehr möglich', async () => {
    const a = await newUser('Ex');
    const b = await newUser('Ehemals');
    await a.b.call('POST', `/api/friends/${b.name}`, {});
    await b.b.call('POST', `/api/friends/${a.name}`, {});
    assert.ok((await b.b.call('GET', `/api/users/${a.name}`)).body.stats, 'als Freund sichtbar');
    await a.b.call('DELETE', `/api/friends/${b.name}`, {});
    assert.equal((await b.b.call('GET', `/api/users/${a.name}`)).body.stats, null, 'danach privat');
    assert.equal((await b.b.call('GET', `/api/users/${a.name}`)).body.relation, null);
    const lobby = (await a.b.call('POST', '/api/games', { mode: 'quiz', playerName: 'A', settings: {} })).body;
    assert.equal((await a.b.call('POST', `/api/games/${lobby.state.id}/invite`, { token: lobby.token, to: [b.name] })).status, 400);
  });

  test('online/offline unter Freunden und Ablauf von Einladungen nach 2 Stunden (Test-Schnittstelle)', async () => {
    const a = await newUser('Online');
    const b = await newUser('Offline');
    await a.b.call('POST', `/api/friends/${b.name}`, {});
    await b.b.call('POST', `/api/friends/${a.name}`, {});
    assert.deepEqual((await a.b.call('GET', '/api/me')).body.user.friendsOnline, [b.name]);
    // B war vor 5 Minuten zuletzt da → offline
    assert.equal((await realFetch(`${base}/api/__test/age/${b.name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seenMinAgo: 5 }) })).status, 200);
    assert.deepEqual((await a.b.call('GET', '/api/me')).body.user.friendsOnline, []);
    assert.equal((await a.b.call('GET', '/api/friends')).body.friends[0].online, false);
    // Einladung: gilt, solange die Lobby besteht – höchstens 2 Stunden
    const lobby = (await a.b.call('POST', '/api/games', { mode: 'quiz', playerName: 'A', settings: {} })).body;
    await a.b.call('POST', `/api/games/${lobby.state.id}/invite`, { token: lobby.token, to: 'all' });
    assert.equal((await b.b.call('GET', '/api/me')).body.user.invites.length, 1);
    await realFetch(`${base}/api/__test/age/${b.name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitesMinOlder: 121 }) });
    assert.equal((await b.b.call('GET', '/api/me')).body.user.invites.length, 0, 'nach 2 h weg');
  });
});

describe('Account löschen', () => {
  test('nur mit Passwort; danach alles weg: Sitzung, Freundschaften, Einladungen, Statistik – Name wieder frei', async () => {
    const a = await newUser('Weg');
    const b = await newUser('Bleibt');
    await a.b.call('POST', `/api/friends/${b.name}`, {});
    await b.b.call('POST', `/api/friends/${a.name}`, {});
    const lobby = (await b.b.call('POST', '/api/games', { mode: 'quiz', playerName: 'B', settings: {} })).body;
    await b.b.call('POST', `/api/games/${lobby.state.id}/invite`, { token: lobby.token, to: 'all' });
    assert.equal((await a.b.call('GET', '/api/me')).body.user.invites.length, 1);

    assert.equal((await a.b.call('POST', '/api/me/delete', { password: 'falsch123' })).status, 401, 'falsches Passwort');
    assert.ok((await a.b.call('GET', '/api/me')).body.user, 'noch da');
    const del = await a.b.call('POST', '/api/me/delete', { password: 'passwort1' });
    assert.equal(del.status, 200);
    assert.equal((await a.b.call('GET', '/api/me')).body.user, null, 'abgemeldet');

    for (const [t, col] of [['users', 'id'], ['sessions', 'user_id'], ['results', 'user_id'], ['usage', 'user_id'], ['medals', 'user_id'], ['invites', 'to_id'], ['friends', 'a'], ['friends', 'b']])
      assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(a.id) as { n: number }).n, 0, `${t}.${col}`);
    assert.equal((await b.b.call('GET', '/api/friends')).body.friends.length, 0, 'beim Freund verschwunden');
    assert.equal((await b.b.call('GET', `/api/users/${a.name}`)).status, 404);
    // Name ist wieder frei
    assert.equal((await browser().call('POST', '/api/auth/register', { name: a.name, password: 'passwort2' })).status, 200);
  });

  test('online sehen nur Freunde (wie im Datenschutz-Hinweis)', async () => {
    const a = await newUser('Sichtbar');
    const b = await newUser('Fremd');
    assert.equal((await b.b.call('GET', `/api/users/${a.name}`)).body.online, false, 'Fremde sehen nicht, dass A online ist');
    assert.equal((await browser().call('GET', `/api/users/${a.name}`)).body.online, false, 'Abgemeldete auch nicht');
    await a.b.call('POST', `/api/friends/${b.name}`, {});
    await b.b.call('POST', `/api/friends/${a.name}`, {});
    assert.equal((await b.b.call('GET', `/api/users/${a.name}`)).body.online, true, 'Freunde schon');
  });

  test('ohne Anmeldung nicht möglich; Datenschutz-Angaben abrufbar', async () => {
    assert.equal((await browser().call('POST', '/api/me/delete', { password: 'x' })).status, 401);
    const p = await browser().call('GET', '/api/privacy');
    assert.equal(p.status, 200);
    assert.ok('contact' in p.body && 'mail' in p.body);
  });
});
