// Routenjagd-Spielablauf im selben Prozess mit Auskunfts-Attrappe: Ausfälle bei späteren Runden, leerer Stationspool.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEfaMock } from './support/efa-mock.ts';

const mock = await installEfaMock();
const { Network } = await import('../server/network.ts');
const { Game } = await import('../server/game.ts');
const net = Network.load();

const base = { rounds: 3, minTransfers: 0, restrictions: 'never', roundTimeLimitSec: null, locate: false } as const;
let n = 0;
function newGame(settings: object = base) {
  const g = new Game(`T${n++}`, net, settings);
  const host = g.addPlayer('Host');
  return { g, host };
}

test('Regression H-02: Auskunft fällt vor Runde 2 aus → Spiel endet mit Runde 1, Punkte bleiben', async () => {
  mock.fail = false;
  const { g, host } = newGame();
  await g.start(host.token);
  // Runde 2 und 3 werden im Hintergrund vorbereitet – ab jetzt ist die Auskunft weg
  mock.fail = true;
  g.cancelRound(host.token);
  await assert.rejects(g.next(host.token), /Auskunft|Runde/);
  const st = g.state();
  assert.equal(st.phase, 'finished', `Phase ${st.phase} – Spiel sollte mit den gespielten Runden enden`);
  assert.equal(st.rounds.length, 1);
  mock.fail = false;
});

test('Auskunft fällt vor Runde 1 aus → zurück in die Lobby mit verständlicher Meldung', async () => {
  mock.fail = true;
  const { g, host } = newGame();
  await assert.rejects(g.start(host.token), /Auskunft/);
  assert.equal(g.state().phase, 'lobby');
  mock.fail = false;
});

test('Regression M-03: zu wenige Stationen für die Einstellungen → verständlicher Fehler statt TypeError', () => {
  const { g } = newGame();
  const empty = Object.assign(Object.create(Object.getPrototypeOf(net)), net, { candidates: () => [] });
  assert.throws(() => empty.randomPair(g.settings, new Set()), (e: Error) => !(e instanceof TypeError) && /Haltestellen/.test(e.message));
  // alle Stationen schon gespielt → trotzdem ein Paar (statt Abbruch bei vielen Runden mit kleinem Pool)
  const all = new Set(net.data.stations.map((s) => s.id));
  assert.equal(net.randomPair(g.settings, all).length, 2);
});

test('Training: gleiche Station als festes Paar → 400; Auskunft weg beim Auswerten → 503 statt 500', async () => {
  const { TrainingService } = await import('../server/training.ts');
  const t = new TrainingService(net);
  const id = net.data.stations[0].id;
  await assert.rejects(t.create({ minTransfers: 0 }, { from: id, to: id }), (e: Error & { status?: number }) => e.status === 400);
  mock.fail = false;
  const r = await t.create({ minTransfers: 0 });
  mock.fail = true;
  const u1 = net.lines.get('U1')!.patterns[0];
  await assert.rejects(t.evaluate(r.id, [{ line: 'U1', from: u1[1], to: u1[5] }]), (e: Error & { status?: number }) => e.status === 503);
  mock.fail = false;
});

test('Regression L-13: Tipp „Linien am Start“ zeigt tagsüber keine Nachtlinien', async () => {
  mock.fail = false;
  let checked = false;
  for (let i = 0; i < 15 && !checked; i++) {
    const { g, host } = newGame({ ...base, rounds: 1, tips: 'cheap', slot: 'wd12', stations: ['U', 'S', 'T'] });
    await g.start(host.token);
    const from = g.state().rounds[0].from!;
    // nur aussagekräftig, wenn am Start überhaupt Nachtlinien halten
    if (!net.linesAt(from.id, 'regular').some((l) => l.mode === 'N')) continue;
    const tip = await g.tip(host.token, 0, 'startLines');
    assert.ok(tip.kind === 'startLines' && tip.lines.length > 0 && tip.lines.every((l) => l.mode !== 'N'), JSON.stringify(tip));
    checked = true;
  }
  assert.ok(checked, 'keine Start-Station mit Nachtlinien gezogen');
});

test('Regression M-02: max. 20 Lobbys je IP; voller Server räumt nie verbundene Lobbys statt alle abzuweisen', async () => {
  const { GameManager, MAX_GAMES_PER_IP } = await import('../server/manager.ts');
  const m = new GameManager(net);
  for (let i = 0; i < MAX_GAMES_PER_IP; i++) m.create('quiz', {}, '203.0.113.1').addPlayer('A');
  assert.throws(() => m.create('quiz', {}, '203.0.113.1'), (e: Error & { status?: number }) => e.status === 429);
  // Server bis zum Limit füllen (viele Adressen), alle Lobbys „alt“ und nie verbunden
  for (let i = 0; m.lobbyCount < 500; i++) m.create('quiz', {}, `198.51.100.${i % 250}.${Math.floor(i / 250)}`).addPlayer('B');
  for (const code of (m as unknown as { games: Map<string, { createdAt: number }> }).games.keys())
    Object.defineProperty((m as unknown as { games: Map<string, object> }).games.get(code)!, 'createdAt', { value: Date.now() - 60_000 });
  const fresh = m.create('route', {}, '192.0.2.7');
  assert.ok(fresh, 'neue Lobby trotz vollem Server');
  assert.equal(m.lobbyCount, 500);
});

test('Regression M-07: Warnung, wenn die Referenztage zu alt für die Auskunft sind', () => {
  const day = new Date(`${net.data.regularDays.wd.date}T12:00:00Z`);
  assert.deepEqual(net.referenceWarnings(new Date(day.getTime() + 30 * 86400000)), []);
  const old = net.referenceWarnings(new Date(day.getTime() + 200 * 86400000));
  assert.ok(old.length >= 1 && /npm run build:data/.test(old[0]), old.join(' | '));
});

test('Regression L-11: Statistik lässt sich sofort sichern (beim Beenden des Servers)', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  net.markUsed('s1', 's2');
  net.saveUsage();
  const saved = JSON.parse(readFileSync(path.join(process.env.STATE_DIR!, 'usage.json'), 'utf8'));
  assert.ok(saved.s1 >= 1 && saved.s2 >= 1);
});
