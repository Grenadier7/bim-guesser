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
async function newUser(prefix: string, password = 'passwort1') {
  const b = browser();
  const name = uniq(prefix);
  assert.equal((await b.call('POST', '/api/auth/register', { name, password, email: `${name.toLowerCase()}@example.org` })).status, 200);
  return { b, name };
}
const ADMIN_PW = 'sicheresPasswort1';
/** Kommandozeile wie auf dem Server: node server/admin-cli.ts … (gleiche Datenbank) */
const cli = (...args: string[]) =>
  execFileSync(process.execPath, ['server/admin-cli.ts', ...args], { env: { ...process.env, ACCOUNTS_DB: DB }, encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') });

let boss: Awaited<ReturnType<typeof newUser>>;

describe('Admin-Rechte', () => {
  test('nur über die Kommandozeile; ohne Rechte 401/403; Admin-Bereich erst nach Passwort; Rechte wirken sofort', async () => {
    boss = await newUser('Chef', ADMIN_PW);
    assert.equal((await browser().call('GET', '/api/admin/overview')).status, 401);
    assert.equal((await boss.b.call('GET', '/api/admin/overview')).status, 403);
    assert.equal((await boss.b.call('POST', '/api/admin/unlock', { password: ADMIN_PW })).status, 403, 'kein Admin → kein Entsperren');
    assert.equal((await boss.b.call('GET', '/api/me')).body.user.admin, undefined);
    assert.match(cli('grant', boss.name), /ist jetzt Admin/);
    assert.match(cli('list'), new RegExp(boss.name));
    assert.equal((await boss.b.call('GET', '/api/me')).body.user.admin, true);
    // Login-Cookie allein reicht nicht: gesperrt, bis das Passwort nochmal eingegeben wurde
    assert.equal((await boss.b.call('GET', '/api/admin/overview')).status, 423);
    assert.deepEqual((await boss.b.call('GET', '/api/admin/status')).body, { admin: true, unlocked: false });
    assert.equal((await boss.b.call('POST', '/api/admin/unlock', { password: 'falschfalsch' })).status, 401);
    assert.equal((await boss.b.call('POST', '/api/admin/unlock', { password: ADMIN_PW })).status, 200);
    assert.deepEqual((await boss.b.call('GET', '/api/admin/status')).body, { admin: true, unlocked: true });
    // anderes Gerät desselben Admins: dort noch gesperrt
    const other = browser();
    await other.call('POST', '/api/auth/login', { name: boss.name, password: ADMIN_PW });
    assert.equal((await other.call('GET', '/api/admin/overview')).status, 423);
    const o = await boss.b.call('GET', '/api/admin/overview');
    assert.equal(o.status, 200);
    assert.ok(o.body.users.total >= 1 && o.body.users.admins === 1);
    // wieder weg → sofort kein Zugriff
    cli('revoke', boss.name);
    assert.equal((await boss.b.call('GET', '/api/admin/overview')).status, 403);
    cli('grant', boss.name);
    assert.throws(() => cli('grant', 'gibtsnicht123'), /Diesen Account gibt es nicht/);
    // sperren und mit Passwort wieder öffnen
    await boss.b.call('POST', '/api/admin/lock');
    assert.equal((await boss.b.call('GET', '/api/admin/overview')).status, 423);
    assert.equal((await boss.b.call('POST', '/api/admin/unlock', { password: ADMIN_PW })).status, 200);
  });

  test('Admin mit kurzem Passwort kann nicht entsperren; Admins können andere Admins nicht ändern', async () => {
    const weak = await newUser('Schwach', 'kurzpw12');
    cli('grant', weak.name);
    const r = await weak.b.call('POST', '/api/admin/unlock', { password: 'kurzpw12' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /mindestens 10 Zeichen/);
    for (const [m, url, body] of [
      ['POST', `/api/admin/users/${weak.name}/password`, { password: 'neuesPasswort1' }],
      ['POST', `/api/admin/users/${weak.name}/reset-link`, {}],
      ['POST', `/api/admin/users/${weak.name}/logout`, {}],
      ['PUT', `/api/admin/users/${weak.name}/name`, { name: 'Anders123' }],
      ['DELETE', `/api/admin/users/${weak.name}`, {}],
    ] as const)
      assert.equal((await boss.b.call(m, url, body)).status, 403, `${m} ${url}`);
    cli('revoke', weak.name);
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
    const us = (await boss.b.call('GET', `/api/admin/users/${renamed}/stats`)).body;
    assert.ok(Array.isArray(us.days) && us.days.length >= 90);
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

describe('Netzpläne und Routenberechnung', () => {
  const id = (name: string) => net.data.lines.find((l) => l.id === 'S40')!.patterns.flat().find((s) => net.station(s).name === name)!;
  const FJB = () => id('Franz-Josefs-Bahnhof');
  const SPITTELAU = () => id('Spittelau');
  const HEILI = () => id('Heiligenstadt');
  const NUSSDORF = () => id('Nußdorf');
  const put = (plan: string, body: object) => boss.b.call('PUT', `/api/admin/routing/plans/${plan}`, { params: {}, edits: [], ...body });

  test('Parameter des Standard-Plans: gespeichert, Grenzen geprüft, Unsinn abgelehnt', async () => {
    const r = await put('regular', { params: { changeMin: 3, firstWaitFactor: 0.5 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.plans.find((p: { id: string }) => p.id === 'regular').params, { changeMin: 3, firstWaitFactor: 0.5 });
    assert.equal(r.body.defaults.changeMin, 2);
    assert.equal((await put('regular', { params: { changeMin: -1 } })).status, 400);
    assert.equal((await put('regular', { edits: [{ kind: 'cut', line: 'X99', at: 'a', beyond: 'b' }] })).status, 400);
    assert.equal((await boss.b.call('GET', '/api/admin/routing')).body.plans[0].params.changeMin, 3, 'falsche Eingabe ändert nichts');
    await put('regular', {});
  });

  test('S40 erst ab Heiligenstadt (kürzen), mit eigenen Fahrzeiten wieder ab FJB (verlängern), Fahrzeit, Fahrplan-Ansicht', async () => {
    assert.ok(net.servesInOrder('S40', FJB(), HEILI(), 'regular'), 'vorher: S40 ab FJB');
    let r = await put('regular', { edits: [{ kind: 'cut', line: 'S40', at: HEILI(), beyond: FJB() }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.report.regular[0], /^✔ S40 endet bei Heiligenstadt/);
    assert.ok(!net.servesInOrder('S40', FJB(), HEILI(), 'regular'), 'Baukasten: S40 nicht mehr ab FJB');
    assert.ok(net.servesInOrder('S40', FJB(), HEILI(), 'current'), '„Aktuell“ unverändert');
    const pub = (await (await realFetch(`${base}/api/network`)).json()) as { lines: { id: string; patterns: string[][]; nets: string[] }[] };
    const s40 = pub.lines.find((l) => l.id === 'S40')!;
    assert.ok(s40.patterns.every((p, i) => !s40.nets[i].includes('r') || !p.includes(FJB())), 'auch in /api/network');

    r = await put('regular', {
      edits: [
        { kind: 'cut', line: 'S40', at: HEILI(), beyond: FJB() },
        { kind: 'extend', line: 'S40', at: HEILI(), stops: [{ station: SPITTELAU(), min: 3 }, { station: FJB(), min: 4 }] },
        { kind: 'time', line: 'S40', from: HEILI(), to: SPITTELAU(), min: 6 },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const line of r.body.report.regular) assert.match(line, /^✔ S40 .*\d+ Fahrt/, line);
    assert.ok(net.servesInOrder('S40', FJB(), HEILI(), 'regular'), 'wieder ab FJB');
    const view = (await boss.b.call('GET', '/api/admin/routing/timetable?plan=regular&line=S40')).body;
    const seg = view.patterns.flatMap((p: { stops: { station: string; min: number | null }[] }) => p.stops.map((x, i) => [p.stops[i - 1]?.station, x.station, x.min]));
    assert.ok(seg.some(([a, b, m]: [string, string, number]) => a === HEILI() && b === SPITTELAU() && m === 6), 'Fahrplan zeigt die neue Fahrzeit');
    assert.ok(view.patterns.some((p: { trips: { wd: number[] } }) => p.trips.wd.reduce((a, b) => a + b, 0) > 10));
    const t = await boss.b.call('POST', '/api/admin/routing/test', { from: FJB(), to: NUSSDORF() });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.ok(t.body.length > 0);
    await put('regular', {});
    assert.ok(net.servesInOrder('S40', FJB(), HEILI(), 'regular'));
  });

  test('eigener Netzplan mit neuer Station und neuer Linie: in der Lobby wählbar, eigenes Netz, Standard-Netz unverändert', async () => {
    const r = await put('zukunft', {
      label: 'Zukunft',
      hint: 'Mit der neuen U5',
      inMenu: true,
      edits: [
        { kind: 'addStation', station: 'n1001', name: 'Neustadt', lat: 48.235, lon: 16.36, district: 19 },
        { kind: 'addLine', line: 'U9', mode: 'U', color: '#aa00ff', stops: [{ station: HEILI(), min: 0 }, { station: 'n1001', min: 3 }, { station: SPITTELAU(), min: 4 }], service: { wd: [{ from: '05:00', to: '24:00', every: 5 }], sa: [], su: [] } },
        { kind: 'renameStation', station: NUSSDORF(), name: 'Nußdorf Bahnhof' },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.report.zukunft.map((x: string) => x[0]), ['✔', '✔', '✔'], r.body.report.zukunft.join(' | '));
    // Lobby-Menü und Netzdaten
    const cfg = (await (await realFetch(`${base}/api/config`)).json()) as { plans: { id: string; label: string; hint: string }[] };
    assert.deepEqual(cfg.plans, [{ id: 'plan:zukunft', label: 'Zukunft', hint: 'Mit der neuen U5' }]);
    const pn = (await (await realFetch(`${base}/api/network?plan=zukunft`)).json()) as { lines: { id: string }[]; stations: { id: string; name: string; lines: string[] }[] };
    assert.ok(pn.lines.some((l) => l.id === 'U9'));
    assert.deepEqual(pn.stations.find((x) => x.id === 'n1001')!.lines, ['U9']);
    assert.equal(pn.stations.find((x) => x.id === NUSSDORF())!.name, 'Nußdorf Bahnhof');
    const std = (await (await realFetch(`${base}/api/network`)).json()) as { lines: { id: string }[] };
    assert.ok(!std.lines.some((l) => l.id === 'U9'), 'Standard-Netz ohne U9');
    assert.equal((await realFetch(`${base}/api/network?plan=gibtsnicht`)).status, 404);
    // Routenjagd mit dem Plan anlegen; Probe-Abfrage findet die neue Linie
    const lobby = await browser().call('POST', '/api/games', { mode: 'route', playerName: 'P', settings: { network: 'plan:zukunft' } });
    assert.equal(lobby.body.state.settings.network, 'plan:zukunft');
    const t = await boss.b.call('POST', '/api/admin/routing/test', { plan: 'zukunft', from: HEILI(), to: 'n1001' });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.ok(t.body.some((x: { legs: { line: string }[] }) => x.legs.some((l) => l.line === 'U9')), 'U9 wird genutzt');
    // doppelte Linie oder unbekannte Station → klare Meldung
    const bad = await put('kaputt', { edits: [{ kind: 'addLine', line: 'U1', mode: 'U', color: '#000000', stops: [{ station: HEILI(), min: 0 }, { station: FJB(), min: 3 }], service: { wd: [{ from: '06:00', to: '08:00', every: 10 }] } }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /U1 gibt es schon/);
    // löschen → nicht mehr wählbar
    assert.equal((await boss.b.call('DELETE', '/api/admin/routing/plans/zukunft')).status, 200);
    assert.equal((await boss.b.call('DELETE', '/api/admin/routing/plans/regular')).status, 400);
    const cfg2 = (await (await realFetch(`${base}/api/config`)).json()) as { plans: unknown[] };
    assert.deepEqual(cfg2.plans, []);
    // Versionen: Zustand vor dem Löschen wiederherstellen
    const versions = (await boss.b.call('GET', '/api/admin/routing/versions')).body as { id: string; note: string }[];
    const before = versions.find((v) => v.note.startsWith('Netzplan angelegt: Zukunft'))!;
    assert.equal((await boss.b.call('POST', `/api/admin/routing/versions/${before.id}/restore`)).status, 200);
    assert.ok((await boss.b.call('GET', '/api/admin/routing')).body.plans.some((p: { id: string }) => p.id === 'zukunft'));
    await boss.b.call('DELETE', '/api/admin/routing/plans/zukunft');
  });
});

describe('Spiel-Konfiguration', () => {
  const cfg = async () => (await (await realFetch(`${base}/api/config`)).json()) as Record<string, any>;

  test('Uhrzeiten, Wertung, Joker, Standard-Einstellungen: speichern, prüfen, im Spiel wirksam, zurücksetzen, Versionen', async () => {
    const slots = (await boss.b.call('GET', '/api/admin/config')).body.config.slots;
    slots.wd17 = { ...slots.wd17, short: 'Mo–Fr 8 Uhr', label: 'Wochentag 08:00', time: '08:00' };
    let r = await boss.b.call('PUT', '/api/admin/config/slots', { value: slots });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await cfg()).slots.wd17.time, '08:00');
    assert.equal((await boss.b.call('PUT', '/api/admin/config/slots', { value: { ...slots, wd17: { ...slots.wd17, time: '25:00' } } })).status, 400);
    // Joker teurer, Standard-Runden 3
    const tips = r.body.config.tips;
    tips.kinds.transfers.share = 0.6;
    assert.equal((await boss.b.call('PUT', '/api/admin/config/tips', { value: tips })).status, 200);
    const defaults = r.body.config.defaults;
    defaults.route.rounds = 3;
    assert.equal((await boss.b.call('PUT', '/api/admin/config/defaults', { value: defaults })).status, 200);
    const lobby = await browser().call('POST', '/api/games', { mode: 'route', playerName: 'D', settings: {} });
    assert.equal(lobby.body.state.settings.rounds, 3, 'neue Lobby mit neuem Standard');
    // „Was zählt?“: mindestens eine Wertung bleibt
    const scoring = r.body.config.scoring;
    for (const m of Object.values(scoring.modes) as { enabled: boolean }[]) m.enabled = false;
    assert.equal((await boss.b.call('PUT', '/api/admin/config/scoring', { value: scoring })).status, 400);
    // zurück auf Standard
    r = await boss.b.call('DELETE', '/api/admin/config/slots');
    assert.equal((await cfg()).slots.wd17.time, '17:00');
    assert.ok(!r.body.changed.includes('slots') && r.body.changed.includes('tips'));
    // Version vor dem Zurücksetzen wiederherstellen
    const versions = (await boss.b.call('GET', '/api/admin/config-versions')).body as { id: string; note: string }[];
    const v = versions.find((x) => x.note === 'Uhrzeiten geändert')!;
    await boss.b.call('POST', `/api/admin/config-versions/${v.id}/restore`);
    assert.equal((await cfg()).slots.wd17.time, '08:00');
    for (const k of ['slots', 'tips', 'defaults']) await boss.b.call('DELETE', `/api/admin/config/${k}`);
    assert.equal((await cfg()).slots.wd17.time, '17:00');
    assert.ok(!('chat' in (await cfg())), 'gesperrte Wörter gehen nicht an den Browser');
  });

  test('Chat-Moderation: Schimpfwörter werden ersetzt, Namen abgelehnt, Liste über die Admin-Seite', async () => {
    const lobby = (await browser().call('POST', '/api/games', { mode: 'quiz', playerName: 'Hans', settings: {} })).body;
    const say = async (text: string) => (await realFetch(`${base}/api/games/${lobby.state.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: lobby.token, text }) })).json();
    assert.equal((await say('du Arschloch')).text, 'du *********');
    assert.equal((await say('F.u.c.k you')).text, '******* you');
    assert.equal((await say('Schurer und Hurensohnx')).text, 'Schurer und **********', 'kurze Wörter nur ganz, lange auch in Wörtern');
    const join = await browser().call('POST', `/api/games/${lobby.state.id}/join`, { playerName: 'Wichser99' });
    assert.equal(join.status, 400);
    const reg = await browser().call('POST', '/api/auth/register', { name: 'Admin', password: 'passwort123' });
    assert.equal(reg.status, 400, 'Name „Admin“ reserviert');
    // eigenes Wort ergänzen
    const words = ((await boss.b.call('GET', '/api/admin/config')).body.config.chat.words as string[]).concat('blödmann');
    assert.equal((await boss.b.call('PUT', '/api/admin/config/chat', { value: { words } })).status, 200);
    assert.equal((await say('so ein Blödmann!')).text, 'so ein *********');
    await boss.b.call('DELETE', '/api/admin/config/chat');
    assert.equal((await say('so ein Blödmann!')).text, 'so ein Blödmann!');
  });
});

describe('Sicherheit', () => {
  test('Anmelden: nach 5 Fehlversuchen 15 min Pause für diesen Namen – auch mit richtigem Passwort, auch für unbekannte Namen gleich', async () => {
    const u = await newUser('Ziel');
    for (let i = 0; i < 5; i++) assert.equal((await browser().call('POST', '/api/auth/login', { name: u.name, password: 'falsch' })).status, 401);
    const r = await browser().call('POST', '/api/auth/login', { name: u.name, password: 'passwort1' });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /Fehlversuche/);
    for (let i = 0; i < 5; i++) await browser().call('POST', '/api/auth/login', { name: 'gibtsnicht999', password: 'x' });
    assert.equal((await browser().call('POST', '/api/auth/login', { name: 'gibtsnicht999', password: 'x' })).status, 429, 'verrät nicht, ob es den Namen gibt');
  });

  test('Admin-Antworten enthalten nie Passwort-Hashes oder Sitzungs-Tokens; keine Route nimmt Dateipfade', async () => {
    const det = JSON.stringify((await boss.b.call('GET', `/api/admin/users/${boss.name}`)).body);
    assert.ok(!/argon2|\$argon|"pw"|hash/i.test(det));
    for (const url of ['/api/admin/routing/timetable?plan=../../etc&line=U1', '/api/network?plan=../state']) {
      const r = await boss.b.call('GET', url);
      assert.ok(r.status === 404 || r.status === 400, `${url}: ${r.status}`);
    }
    const r = await boss.b.call('POST', '/api/admin/config-versions/..%2F..%2Faccounts/restore');
    assert.ok(r.status >= 400);
  });

  test('Statistik: Zeitreihen und Tage', async () => {
    const st = (await boss.b.call('GET', '/api/admin/stats?days=7')).body;
    assert.ok(Array.isArray(st.samples) && Array.isArray(st.days) && st.days.length >= 7);
    assert.ok(st.days.every((x: Record<string, unknown>) => 'route' in x && 'quiz' in x && 'newUsers' in x));
  });
});

describe('Fahrplan bearbeiten', () => {
  const S40 = () => net.data.lines.find((l) => l.id === 'S40')!;
  const st = (name: string) => S40().patterns.flat().find((s) => net.station(s).name === name)!;
  const put = (plan: string, edits: object[]) => boss.b.call('PUT', `/api/admin/routing/plans/${plan}`, { label: 'Fahrplan-Test', params: {}, edits });
  type View = { patterns: { key: string; stops: { station: string | null; min: number | null }[]; trips: Record<string, number[]>; deps: Record<string, number[]> }[] };
  const view = async (plan: string, line = 'S40') => (await boss.b.call('GET', `/api/admin/routing/timetable?plan=${plan}&line=${line}`)).body as View;
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  test('Linienliste: Netzlinien und Regionalzüge mit Fahrten und Endstationen', async () => {
    const r = await boss.b.call('GET', '/api/admin/routing/lines?plan=regular');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lines = r.body as { line: string; regional: boolean; trips: Record<string, number>; termini: string[] }[];
    for (const id of ['U1', 'S40']) assert.ok(lines.some((l) => l.line === id && !l.regional && l.trips.wd > 0 && l.termini.length), id);
    assert.ok(lines.some((l) => l.regional && l.trips.wd >= 20), 'Regionalzüge dabei');
    assert.equal((await boss.b.call('GET', '/api/admin/routing/lines?plan=gibtsnicht')).status, 404);
    assert.equal((await boss.b.call('GET', '/api/admin/routing/timetable?plan=regular&line=X99')).status, 404);
  });

  test('Takt, Abfahrten, Halt auslassen, Halt einfügen, Zusatzfahrten – nur im eigenen Plan', async () => {
    const before = await view('regular');
    const main = before.patterns[0];
    assert.ok(main.deps.wd.length > 10, 'Abfahrten am ersten Halt');
    const HEILI = st('Heiligenstadt');
    const SPITTELAU = st('Spittelau');
    const FJB = st('Franz-Josefs-Bahnhof');
    const first = main.deps.wd.find((m) => m >= 0)!;
    const r = await put('fahrplantest', [
      { kind: 'headway', line: 'S40', day: 'wd', from: '06:00', to: '09:00', every: 5, pattern: main.key },
      { kind: 'departures', line: 'S40', pattern: main.key, day: 'wd', add: ['23:58'], remove: [hhmm(first)] },
      { kind: 'skipStop', line: 'S40', station: SPITTELAU },
      { kind: 'addStation', station: 'n2001', name: 'Zwischenhalt', lat: 48.24, lon: 16.36, district: 19 },
      { kind: 'insertStop', line: 'S40', a: HEILI, b: FJB, station: 'n2001', minA: 2, minB: 3 },
      { kind: 'addVariant', line: 'S40', stops: [{ station: HEILI, min: 0 }, { station: FJB, min: 5 }], service: { wd: [{ from: '10:00', to: '12:00', every: 30 }], sa: [], su: [] } },
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.report.fahrplantest.map((x: string) => x[0]), ['✔', '✔', '✔', '✔', '✔', '✔'], r.body.report.fahrplantest.join(' | '));

    const after = await view('fahrplantest');
    const p = after.patterns.find((x) => x.key === main.key)!;
    assert.ok(p, 'Haltefolge noch da');
    for (const h of [6, 7, 8]) assert.ok(p.trips.wd[h] >= 11, `Takt 5 min um ${h} Uhr: ${p.trips.wd[h]}`);
    assert.ok(p.deps.wd.includes(23 * 60 + 58), 'Abfahrt dazu');
    assert.ok(!p.deps.wd.includes(first), 'Abfahrt gestrichen');
    assert.ok(after.patterns.every((x) => !x.stops.some((s) => s.station === SPITTELAU)), 'Spittelau ausgelassen');
    assert.ok(after.patterns.some((x) => x.stops.some((s) => s.station === 'n2001')), 'neuer Halt eingefügt');
    assert.ok(after.patterns.some((x) => x.stops.length === 2 && x.stops[0].station === HEILI && x.stops[1].station === FJB), 'Zusatzfahrten Heiligenstadt–FJB');

    // Netz des Plans: S40 hält nicht mehr in Spittelau, aber am neuen Halt; Standard unverändert
    const pn = (await (await realFetch(`${base}/api/network?plan=fahrplantest`)).json()) as { stations: { id: string; lines: string[] }[] };
    assert.ok(!pn.stations.find((x) => x.id === SPITTELAU)!.lines.includes('S40'));
    assert.ok(pn.stations.find((x) => x.id === 'n2001')!.lines.includes('S40'));
    assert.ok(net.station(SPITTELAU).lines.includes('S40'), 'Standard-Netz unverändert');
    assert.deepEqual((await view('regular')).patterns[0].deps.wd, main.deps.wd, 'Standard-Fahrplan unverändert');

    // unsinnige Werte → abgelehnt
    assert.equal((await put('fahrplantest', [{ kind: 'headway', line: 'S40', day: 'wd', from: '09:00', to: '06:00', every: 5 }])).status, 400);
    assert.equal((await put('fahrplantest', [{ kind: 'departures', line: 'S40', pattern: main.key, day: 'wd', add: ['25:99'], remove: [] }])).status, 400);
    assert.equal((await put('fahrplantest', [{ kind: 'skipStop', line: 'S40', station: 'gibtsnicht' }])).status, 400);
    assert.equal((await boss.b.call('DELETE', '/api/admin/routing/plans/fahrplantest')).status, 200);
  });
});

describe('Besucher und Linien-Statistik', () => {
  test('Besuch per Kennung (mit/ohne Account) je Tag einmal; ungültige Kennung abgelehnt', async () => {
    const anon = browser();
    assert.equal((await anon.call('POST', '/api/ping', { v: 'x' })).status, 400);
    assert.equal((await anon.call('POST', '/api/ping', { v: '../../etc/passwd' })).status, 400);
    const before = (await boss.b.call('GET', '/api/admin/stats?days=1')).body.days.at(-1);
    const id = uniq('testbesucher').toLowerCase();
    assert.equal((await anon.call('POST', '/api/ping', { v: id })).status, 200);
    assert.equal((await anon.call('POST', '/api/ping', { v: id })).status, 200);
    assert.equal((await boss.b.call('POST', '/api/ping', { v: uniq('testadmin').toLowerCase() })).status, 200);
    const now = (await boss.b.call('GET', '/api/admin/stats?days=1')).body.days.at(-1);
    assert.equal(now.visitors - (before?.visitors ?? 0), 2, 'zweimal derselbe Browser zählt einmal');
    assert.equal(now.anonVisitors - (before?.anonVisitors ?? 0), 1, 'einer davon ohne Account');
  });

  test('gewählte Linien werden gezählt und als Rangliste geliefert', async () => {
    const { Accounts, AccountAdmin } = await import('../server/accounts.ts');
    const a = new AccountAdmin(new Accounts(net, { file: ':memory:', mail: async () => {} }));
    a.countLines(['U4', 'U4', 'S45', 'U4', '13A']);
    a.countLines(['S45', '<script>', '']);
    assert.deepEqual(a.stats(1).lines.map((x) => ({ ...x })), [
      { line: 'U4', n: 3 },
      { line: 'S45', n: 2 },
      { line: '13A', n: 1 },
    ]);
  });
});
