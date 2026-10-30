// Admin: Rechte nur über die Kommandozeile, Accounts verwalten, Lobbys, Protokoll, Routenberechnung einstellen
import './support/scale.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.ts';
import { Network } from '../server/network.ts';
import { installEfaMock } from './support/efa-mock.ts';

// mit Referenzfahrplan – Linien-Änderungen wirken auf echte Fahrten
process.env.TIMETABLE = 'on';
const net = Network.load();
const DB = path.join(process.env.STATE_DIR!, 'accounts.db');
let base = '';
let server: http.Server;
const realFetch = globalThis.fetch;

before(async () => {
  await installEfaMock();
  const { app } = createApp({ net, version: 'test', accountsDb: DB, mail: async () => {} });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

function browser() {
  let cookie = '';
  // wie die Seite: ändernde Anfragen immer als JSON (sonst 415)
  const call = async (method: string, url: string, body: unknown = method === 'GET' ? undefined : {}) => {
    const res = await realFetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    const m = set && /bg_sid=([^;]*)/.exec(set);
    if (m) cookie = m[1] ? `bg_sid=${m[1]}` : '';
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call };
}
const uniq = (p: string) => `${p}${Math.random().toString(36).slice(2, 7)}`;
async function newUser(prefix: string) {
  const b = browser();
  const name = uniq(prefix);
  assert.equal((await b.call('POST', '/api/auth/register', { name, password: 'passwort1', email: `${name.toLowerCase()}@example.org` })).status, 200);
  return { b, name };
}
/** Kommandozeile wie auf dem Server: node server/admin-cli.ts … (gleiche Datenbank) */
const cli = (...args: string[]) =>
  execFileSync(process.execPath, ['server/admin-cli.ts', ...args], { env: { ...process.env, ACCOUNTS_DB: DB }, encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') });

let boss: Awaited<ReturnType<typeof newUser>>;

describe('Admin-Rechte', () => {
  test('nur über die Kommandozeile; ohne Rechte 401/403; Rechte wirken sofort', async () => {
    boss = await newUser('Chef');
    assert.equal((await browser().call('GET', '/api/admin/overview')).status, 401);
    assert.equal((await boss.b.call('GET', '/api/admin/overview')).status, 403);
    assert.equal((await boss.b.call('GET', '/api/me')).body.user.admin, undefined);
    assert.match(cli('grant', boss.name), /ist jetzt Admin/);
    assert.match(cli('list'), new RegExp(boss.name));
    assert.equal((await boss.b.call('GET', '/api/me')).body.user.admin, true);
    const o = await boss.b.call('GET', '/api/admin/overview');
    assert.equal(o.status, 200);
    assert.ok(o.body.users.total >= 1 && o.body.users.admins === 1);
    // wieder weg → sofort kein Zugriff
    cli('revoke', boss.name);
    assert.equal((await boss.b.call('GET', '/api/admin/overview')).status, 403);
    cli('grant', boss.name);
    assert.throws(() => cli('grant', 'gibtsnicht123'), /Diesen Account gibt es nicht/);
  });

  test('Accounts: suchen, alles sehen, Passwort setzen, Reset-Link, abmelden, Statistik weg, umbenennen, E-Mail, löschen', async () => {
    const u = await newUser('Kunde');
    const list = (await boss.b.call('GET', `/api/admin/users?q=${u.name.slice(0, 7)}`)).body;
    assert.ok(list.some((x: { name: string; email: string }) => x.name === u.name && x.email === `${u.name.toLowerCase()}@example.org`));
    const det = (await boss.b.call('GET', `/api/admin/users/${u.name}`)).body;
    assert.equal(det.sessions, 1);
    assert.ok('stats' in det && 'data' in det && Array.isArray(det.friends));

    // neues Passwort: alte Sitzung abgemeldet, Anmelden mit dem neuen geht
    assert.equal((await boss.b.call('POST', `/api/admin/users/${u.name}/password`, { password: 'kurz' })).status, 400);
    assert.equal((await boss.b.call('POST', `/api/admin/users/${u.name}/password`, { password: 'vomAdmin123' })).status, 200);
    assert.equal((await u.b.call('GET', '/api/me')).body.user, null);
    const again = browser();
    assert.equal((await again.call('POST', '/api/auth/login', { name: u.name, password: 'vomAdmin123' })).status, 200);

    // Reset-Link zum Weitergeben
    const link = (await boss.b.call('POST', `/api/admin/users/${u.name}/reset-link`)).body.link as string;
    const token = /\?reset=([A-Za-z0-9_-]+)/.exec(link)![1];
    assert.equal((await browser().call('POST', '/api/auth/reset', { token, password: 'selbstNeu123' })).status, 200);

    assert.equal((await boss.b.call('POST', `/api/admin/users/${u.name}/logout`)).body.sessions >= 1, true);
    assert.equal((await again.call('GET', '/api/me')).body.user, null, 'überall abgemeldet');

    assert.equal((await boss.b.call('POST', `/api/admin/users/${u.name}/reset-stats`)).status, 200);
    const renamed = `${u.name}x`;
    assert.equal((await boss.b.call('PUT', `/api/admin/users/${u.name}/name`, { name: boss.name })).status, 409, 'Name vergeben');
    assert.equal((await boss.b.call('PUT', `/api/admin/users/${u.name}/name`, { name: renamed })).body.name, renamed);
    assert.equal((await boss.b.call('PUT', `/api/admin/users/${renamed}/email`, { email: 'kaputt@' })).status, 400);
    assert.equal((await boss.b.call('PUT', `/api/admin/users/${renamed}/email`, { email: '' })).status, 200);
    assert.equal((await boss.b.call('GET', `/api/admin/users/${renamed}`)).body.email, null);

    assert.equal((await boss.b.call('DELETE', `/api/admin/users/${boss.name}`)).status, 403, 'Admins nicht löschbar');
    assert.equal((await boss.b.call('DELETE', `/api/admin/users/${renamed}`)).status, 200);
    assert.equal((await boss.b.call('GET', `/api/admin/users/${renamed}`)).status, 404);

    const log = (await boss.b.call('GET', '/api/admin/log')).body as { action: string; target: string; admin: string }[];
    for (const a of ['Account gelöscht', 'Umbenannt', 'Statistik zurückgesetzt', 'Passwort neu gesetzt (alle Geräte abgemeldet)', 'Link zum Zurücksetzen erzeugt', 'Admin-Rechte gegeben'])
      assert.ok(log.some((x) => x.action === a), `Protokoll: ${a}`);
    assert.ok(log.filter((x) => x.action !== 'Admin-Rechte gegeben' && x.action !== 'Admin-Rechte genommen').every((x) => x.admin === boss.name));
  });

  test('Lobbys: in der Übersicht mit Spielern, vom Admin beenden', async () => {
    const lobby = (await browser().call('POST', '/api/games', { mode: 'quiz', playerName: 'Gast', settings: {} })).body;
    const o = (await boss.b.call('GET', '/api/admin/overview')).body;
    const l = o.lobbies.find((x: { code: string }) => x.code === lobby.state.id);
    assert.deepEqual(l.players.map((p: { name: string }) => p.name), ['Gast']);
    assert.equal((await boss.b.call('POST', `/api/admin/lobbies/${lobby.state.id}/close`)).status, 200);
    const after = (await boss.b.call('GET', '/api/admin/overview')).body;
    assert.ok(!after.lobbies.some((x: { code: string }) => x.code === lobby.state.id), 'Lobby weg');
  });
});

describe('Lobbys steuern wie ein Host', () => {
  test('Spieler entfernen, Host vergeben, Chat, starten, pausieren, zurück in die Lobby – alles im Protokoll', async () => {
    const host = browser();
    const lobby = (await host.call('POST', '/api/games', { mode: 'quiz', playerName: 'Gastgeber', settings: {} })).body;
    const code = lobby.state.id;
    const guest = (await browser().call('POST', `/api/games/${code}/join`, { playerName: 'Störer' })).body;
    const other = (await browser().call('POST', `/api/games/${code}/join`, { playerName: 'Nett' })).body;
    let info = (await boss.b.call('GET', `/api/admin/lobbies/${code}`)).body;
    assert.deepEqual(info.players.map((p: { name: string; host: boolean }) => [p.name, p.host]), [['Gastgeber', true], ['Störer', false], ['Nett', false]]);
    assert.ok(!JSON.stringify(info).includes(lobby.token), 'keine Spieler-Tokens in der Admin-Antwort');

    info = (await boss.b.call('POST', `/api/admin/lobbies/${code}/kick`, { playerId: guest.playerId })).body;
    assert.deepEqual(info.players.map((p: { name: string }) => p.name), ['Gastgeber', 'Nett']);
    assert.ok(info.chat.some((m: { text: string }) => m.text === 'Störer wurde von der Spielleitung entfernt.'));
    info = (await boss.b.call('POST', `/api/admin/lobbies/${code}/host`, { playerId: other.playerId, on: true })).body;
    assert.equal(info.players.find((p: { name: string }) => p.name === 'Nett').host, true);
    info = (await boss.b.call('POST', `/api/admin/lobbies/${code}/chat`, { text: 'Bitte freundlich bleiben' })).body;
    assert.equal(info.chat.at(-1).text, 'Spielleitung: Bitte freundlich bleiben');

    info = (await boss.b.call('POST', `/api/admin/lobbies/${code}/start`)).body;
    assert.equal(info.phase, 'playing');
    assert.match(info.progress, /^Frage 1\/\d+$/);
    assert.equal((await boss.b.call('POST', `/api/admin/lobbies/${code}/pause`)).status, 200);
    assert.equal((await boss.b.call('POST', `/api/admin/lobbies/${code}/resume`)).status, 200);
    info = (await boss.b.call('POST', `/api/admin/lobbies/${code}/lobby`)).body;
    assert.equal(info.phase, 'lobby');
    // normale Spieler können das alles weiterhin nicht
    assert.equal((await browser().call('POST', `/api/admin/lobbies/${code}/kick`, { playerId: other.playerId })).status, 401);
    const log = (await boss.b.call('GET', '/api/admin/log')).body as { action: string; detail: string | null }[];
    assert.ok(log.some((x) => x.action === 'Lobby: Spieler entfernt' && x.detail === 'Spieler Störer'));
  });
});

describe('Routenberechnung einstellen', () => {
  const id = (name: string) => net.data.lines.find((l) => l.id === 'S40')!.patterns.flat().find((s) => net.station(s).name === name)!;
  const FJB = () => id('Franz-Josefs-Bahnhof');
  const SPITTELAU = () => id('Spittelau');
  const HEILI = () => id('Heiligenstadt');

  test('Parameter: gespeichert, Grenzen geprüft, Unsinn abgelehnt', async () => {
    const r = await boss.b.call('PUT', '/api/admin/routing', { params: { changeMin: 3, firstWaitFactor: 0.5 }, edits: [] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.overrides.params, { changeMin: 3, firstWaitFactor: 0.5 });
    assert.equal(r.body.defaults.changeMin, 2);
    assert.equal((await boss.b.call('PUT', '/api/admin/routing', { params: { changeMin: -1 }, edits: [] })).status, 400);
    assert.equal((await boss.b.call('PUT', '/api/admin/routing', { params: {}, edits: [{ kind: 'cut', line: 'X99', at: 'a', beyond: 'b' }] })).status, 400);
    assert.equal((await boss.b.call('GET', '/api/admin/routing')).body.overrides.params.changeMin, 3, 'falsche Eingabe ändert nichts');
  });

  test('S40 erst ab Heiligenstadt (kürzen), dann mit eigenen Fahrzeiten wieder ab FJB (verlängern), Fahrzeit ändern, zurücksetzen', async () => {
    assert.ok(net.servesInOrder('S40', FJB(), HEILI(), 'regular'), 'vorher: S40 ab FJB');
    // kürzen
    let r = await boss.b.call('PUT', '/api/admin/routing', { params: {}, edits: [{ kind: 'cut', line: 'S40', at: HEILI(), beyond: FJB() }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.report[0], /^✔ S40 endet bei Heiligenstadt/);
    assert.ok(!net.servesInOrder('S40', FJB(), HEILI(), 'regular'), 'Baukasten: S40 nicht mehr ab FJB');
    assert.ok(net.servesInOrder('S40', FJB(), HEILI(), 'current'), '„Aktuell“ (Auskunft) unverändert');
    assert.ok(!net.station(FJB()).lines.includes('S40') || net.lines.get('S40')!.nets.some((n) => n.includes('c')));
    const pub = (await (await realFetch(`${base}/api/network`)).json()) as { lines: { id: string; patterns: string[][]; nets: string[] }[] };
    const s40 = pub.lines.find((l) => l.id === 'S40')!;
    assert.ok(s40.patterns.every((p, i) => !s40.nets[i].includes('r') || !p.includes(FJB())), 'auch in /api/network');

    // wieder verlängern, mit eigenen Zeiten
    r = await boss.b.call('PUT', '/api/admin/routing', {
      params: {},
      edits: [
        { kind: 'cut', line: 'S40', at: HEILI(), beyond: FJB() },
        { kind: 'extend', line: 'S40', at: HEILI(), stops: [{ station: SPITTELAU(), min: 3 }, { station: FJB(), min: 4 }] },
        { kind: 'time', line: 'S40', from: HEILI(), to: SPITTELAU(), min: 6 },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.report.length, 3);
    for (const line of r.body.report) assert.match(line, /^✔ S40 .*\d+ Fahrt/, line);
    assert.ok(net.servesInOrder('S40', FJB(), HEILI(), 'regular'), 'wieder ab FJB');

    // Probe-Abfrage läuft mit den neuen Einstellungen
    const t = await boss.b.call('POST', '/api/admin/routing/test', { from: FJB(), to: id('Nußdorf') });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.ok(Array.isArray(t.body) && t.body.length > 0);

    // alles zurück
    r = await boss.b.call('PUT', '/api/admin/routing', { params: {}, edits: [] });
    assert.deepEqual(r.body.overrides, { params: {}, edits: [], updatedAt: r.body.overrides.updatedAt, updatedBy: boss.name });
    assert.ok(net.servesInOrder('S40', FJB(), HEILI(), 'regular'));
    const log = (await boss.b.call('GET', '/api/admin/log')).body as { action: string }[];
    assert.ok(log.some((x) => x.action === 'Routenberechnung geändert'));
  });
});
