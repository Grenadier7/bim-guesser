// API: Lobby-Lebenszyklus (Routenjagd und Quiz) über HTTP – erstellen, beitreten, Namen, Host, Einstellungen,
// verlassen, Fehlerfälle. Das Quiz wird komplett durchgespielt (braucht keine Wiener-Linien-Auskunft).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startServer, type TestServer } from './support/server.ts';

let s: TestServer;
before(async () => (s = await startServer()));
after(async () => s?.stop());

const create = (mode: 'route' | 'quiz', playerName = 'Host', settings: object = {}) => s.call('POST', '/api/games', { mode, playerName, settings });

describe('Grundlagen', () => {
  test('Health und Netzdaten', async () => {
    const h = await s.call('GET', '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    const n = await s.call('GET', '/api/network');
    assert.equal(n.status, 200);
    assert.ok(n.body.stations.length > 1000 && n.body.lines.length > 100);
  });

  test('unbekannte API-Pfade → 404 als JSON', async () => {
    const r = await s.call('GET', '/api/gibtsnicht');
    assert.equal(r.status, 404);
    assert.equal(typeof r.body.error, 'string');
  });

  test('Sicherheits-Header gesetzt', async () => {
    const r = await s.call('GET', '/api/health');
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  test('kaputtes JSON → 400, kein Absturz', async () => {
    const r = await s.call('POST', '/api/games', '{kaputt');
    assert.equal(r.status, 400);
    assert.equal((await s.call('GET', '/api/health')).status, 200);
  });
});

describe('Lobby (Routenjagd)', () => {
  test('erstellen: Ersteller ist Host, Phase lobby, Standard-Einstellungen', async () => {
    const r = await create('route', 'Anna');
    assert.equal(r.status, 200);
    const st = r.body.state;
    assert.equal(st.mode, 'route');
    assert.equal(st.phase, 'lobby');
    assert.equal(st.players.length, 1);
    assert.equal(st.players[0].isHost, true);
    assert.equal(st.players[0].name, 'Anna');
    assert.match(st.id, /^[A-Z0-9]{5}$/);
    assert.equal(typeof r.body.token, 'string');
  });

  test('gleiche Namen werden durchnummeriert, leere Namen bekommen „Spieler N“', async () => {
    const { body } = await create('route', 'Max');
    const code = body.state.id;
    const b = await s.call('POST', `/api/games/${code}/join`, { playerName: 'Max' });
    const c = await s.call('POST', `/api/games/${code}/join`, { playerName: '' });
    const names = c.body.state.players.map((p: { name: string }) => p.name);
    assert.deepEqual(names, ['Max', 'Max 2', 'Spieler 3']);
    assert.equal(b.body.state.players.length, 2);
  });

  test('Namen werden bereinigt: HTML-Zeichen weg, höchstens 20 Zeichen', async () => {
    const { body } = await create('route', '<b>"Evil"</b>  Name & Co mit sehr langem Namen');
    const name = body.state.players[0].name as string;
    assert.ok(!/[<>"&]/.test(name), name);
    assert.ok(name.length <= 20, name);
  });

  test('beitreten mit falschem Code → 404', async () => {
    const r = await s.call('POST', '/api/games/ZZZZZ/join', { playerName: 'X' });
    assert.equal(r.status, 404);
  });

  test('nur der Host darf Einstellungen ändern', async () => {
    const { body } = await create('route');
    const code = body.state.id;
    const guest = await s.call('POST', `/api/games/${code}/join`, { playerName: 'Gast' });
    const r = await s.call('PUT', `/api/games/${code}/settings`, { token: guest.body.token, settings: { rounds: 3 } });
    assert.equal(r.status, 403);
    const ok = await s.call('PUT', `/api/games/${code}/settings`, { token: body.token, settings: { rounds: 3 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.rounds, 3);
  });

  test('ungültige Einstellungen werden ignoriert statt übernommen', async () => {
    const { body } = await create('route');
    const code = body.state.id;
    const r = await s.call('PUT', `/api/games/${code}/settings`, {
      token: body.token,
      settings: { rounds: 999, roundTimeLimitSec: -5, slot: 'xx', goal: 'evil', stations: ['nope'], focus: { lat: 'a' } },
    });
    assert.equal(r.status, 200);
    const st = r.body.settings;
    assert.ok([3, 5, 7, 10].includes(st.rounds), `rounds ${st.rounds}`);
    assert.ok(st.roundTimeLimitSec === null || st.roundTimeLimitSec > 0);
    assert.ok(['wd12', 'wd17', 'sa02', 'su12'].includes(st.slot));
    assert.ok(['best', 'fastest'].includes(st.goal));
    assert.ok(st.stations.length > 0);
  });

  test('Mitglieder-Endpunkte verlangen den Token', async () => {
    const { body } = await create('route');
    const r = await s.call('GET', `/api/games/${body.state.id}?token=falsch`);
    assert.equal(r.status, 403);
    const ok = await s.call('GET', `/api/games/${body.state.id}?token=${body.token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.playerId, body.playerId);
  });

  test('Host verlässt die Lobby → nächster Spieler wird Host', async () => {
    const { body } = await create('route', 'Host');
    const code = body.state.id;
    const g = await s.call('POST', `/api/games/${code}/join`, { playerName: 'Zweiter' });
    // ohne Live-Verbindung gilt ein Spieler 15 s lang noch als anwesend
    await s.call('POST', `/api/games/${code}/leave`, { token: body.token });
    const st = await s.call('GET', `/api/games/${code}?token=${g.body.token}`);
    assert.equal(st.body.state.players.length, 1);
    assert.equal(st.body.state.players[0].name, 'Zweiter');
    assert.equal(st.body.state.players[0].isHost, true);
  });

  test('ungültige Rundennummer → 400', async () => {
    const { body } = await create('route');
    for (const round of ['-1', 'abc', '999', '1.5']) {
      const r = await s.call('POST', `/api/games/${body.state.id}/rounds/${round}/submit`, { token: body.token, legs: [] });
      assert.equal(r.status, 400, `Runde ${round}`);
    }
  });

  test('Lobby ist bei 12 Spielern voll', async () => {
    const { body } = await create('route');
    for (let i = 0; i < 11; i++) assert.equal((await s.call('POST', `/api/games/${body.state.id}/join`, { playerName: `P${i}` })).status, 200);
    const r = await s.call('POST', `/api/games/${body.state.id}/join`, { playerName: 'zu viel' });
    assert.equal(r.status, 409);
  });
});

describe('Quiz über die API', () => {
  test('komplett durchspielen: start → antworten → auflösen → weiter → Endstand', async () => {
    const { body } = await create('quiz', 'Quizzer', { questions: 5, modes: ['U', 'S', 'T'] });
    const code = body.state.id;
    const tok = body.token;
    let st = (await s.call('POST', `/api/games/${code}/start`, { token: tok })).body;
    assert.equal(st.phase, 'playing');
    assert.equal(st.total, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(st.current, i);
      assert.equal(st.status, 'open');
      const q = st.question;
      assert.ok(q && q.prompt, 'Frage fehlt');
      assert.equal(q.correct, undefined, 'Lösung darf nicht mitgeschickt werden');
      const answer = q.type === 'locate' ? [48.2, 16.37] : q.type === 'draw' ? [[48.2, 16.37]] : q.multi ? [q.options[0].id] : q.options[0].id;
      st = (await s.call('POST', `/api/games/${code}/quiz/answer`, { token: tok, index: i, answer })).body;
      // einziger Spieler hat geantwortet → sofort aufgelöst
      assert.equal(st.status, 'revealed');
      assert.ok(st.reveal.results[0].points >= 0 && st.reveal.results[0].points <= 1000);
      st = (await s.call('POST', `/api/games/${code}/next`, { token: tok })).body;
    }
    assert.equal(st.phase, 'finished');
  });

  test('doppelt antworten und Antworten auf alte Fragen werden abgelehnt', async () => {
    const { body } = await create('quiz', 'Q', { questions: 5 });
    const code = body.state.id;
    const g = await s.call('POST', `/api/games/${code}/join`, { playerName: 'Zweite' });
    const st = (await s.call('POST', `/api/games/${code}/start`, { token: body.token })).body;
    const q = st.question;
    const answer = q.options ? q.options[0].id : [48.2, 16.37];
    assert.equal((await s.call('POST', `/api/games/${code}/quiz/answer`, { token: body.token, index: 0, answer })).status, 200);
    assert.equal((await s.call('POST', `/api/games/${code}/quiz/answer`, { token: body.token, index: 0, answer })).status, 400);
    assert.equal((await s.call('POST', `/api/games/${code}/quiz/answer`, { token: g.body.token, index: 3, answer })).status, 400);
  });

  test('Müll-Antworten bringen 0 Punkte statt Absturz', async () => {
    const { body } = await create('quiz', 'Q', { questions: 5 });
    const code = body.state.id;
    await s.call('POST', `/api/games/${code}/start`, { token: body.token });
    const r = await s.call('POST', `/api/games/${code}/quiz/answer`, { token: body.token, index: 0, answer: { __proto__: { x: 1 }, a: [1, 2, 3] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.reveal.results[0].points, 0);
  });
});

describe('Kicken und Chat', () => {
  test('Host entfernt einen Spieler: Token ungültig, Hinweis im Chat; Gäste dürfen nicht kicken; sich selbst nicht', async () => {
    const host = await s.call('POST', '/api/games', { mode: 'quiz', playerName: 'Host' });
    const code = host.body.state.id;
    const a = await s.call('POST', `/api/games/${code}/join`, { playerName: 'Anna' });
    const b = await s.call('POST', `/api/games/${code}/join`, { playerName: 'Ben' });
    assert.equal((await s.call('POST', `/api/games/${code}/kick`, { token: a.body.token, playerId: b.body.playerId })).status, 403);
    assert.equal((await s.call('POST', `/api/games/${code}/kick`, { token: host.body.token, playerId: host.body.playerId })).status, 400);
    const r = await s.call('POST', `/api/games/${code}/kick`, { token: host.body.token, playerId: b.body.playerId });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.players.map((p: { name: string }) => p.name).sort(), ['Anna', 'Host']);
    assert.equal((await s.call('GET', `/api/games/${code}?token=${b.body.token}`)).status, 403);
    assert.equal((await s.call('POST', `/api/games/${code}/kick`, { token: host.body.token, playerId: b.body.playerId })).status, 404);
  });

  test('Chat: Text bereinigt, max. 300 Zeichen, leer → 400, Fluten → 429, nur Mitglieder', async () => {
    const host = await s.call('POST', '/api/games', { mode: 'route', playerName: 'Host' });
    const code = host.body.state.id;
    const say = (text: unknown, token = host.body.token) => s.call('POST', `/api/games/${code}/chat`, { token, text });
    const m = await say('  <b>Hallo</b>\u0000 👨‍👩‍👧  ');
    assert.equal(m.status, 200);
    assert.equal(m.body.text, '<b>Hallo</b> 👨‍👩‍👧'); // HTML bleibt Text – der Client escaped beim Anzeigen
    assert.equal(m.body.name, 'Host');
    assert.equal((await say('x'.repeat(500))).body.text.length, 300);
    assert.equal((await say('   ')).status, 400);
    assert.equal((await say('hi', 'falsch')).status, 403);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await say(`spam ${i}`)).status);
    assert.ok(statuses.includes(429), statuses.join(','));
  });
});
