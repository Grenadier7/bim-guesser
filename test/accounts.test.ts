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

const net = Network.load();
const mails: { to: string; text: string }[] = [];
let base = '';
let server: http.Server;

before(async () => {
  const { app } = createApp({ net, version: 'test', accountsDb: ':memory:', mail: async (to, _s, text) => void mails.push({ to, text }) });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

/** ein „Browser“ mit eigenem Cookie */
function browser() {
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown, json = true) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': json ? 'application/json' : 'text/plain' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : json ? JSON.stringify(body) : String(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /bg_sid=([^;]*)/.exec(set)![1] ? `bg_sid=${/bg_sid=([^;]*)/.exec(set)![1]}` : '';
    return { status: res.status, body: await res.json().catch(() => null), setCookie: set };
  };
  return { call, get cookie() { return cookie; } };
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
