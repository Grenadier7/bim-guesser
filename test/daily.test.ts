// Strecke des Tages (mit dem eigenen Referenzfahrplan): Kriterien, gleiche Strecke nach Neustart, Wertung –
// und: eine Rundenvorbereitung blockiert den Server nicht („Spiel beenden“ wirkt sofort).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.STATE_DIR ??= mkdtempSync(path.join(tmpdir(), 'bimguesser-daily-'));
const { Network } = await import('../server/network.ts');
const { DailyService, RAIL_MAX, RAIL_MIN, dailyPenalty } = await import('../server/daily.ts');
const { Game } = await import('../server/game.ts');
const { scoreRoute } = await import('../shared/rules.ts');
const net = Network.load();
const file = path.join(process.env.STATE_DIR, 'daily-test.json');
const fixedNow = () => Date.parse('2026-11-03T10:00:00Z');

test('Kriterien: U/S allein bringt Punkte, aber nicht die volle Wertung', () => {
  assert.equal(dailyPenalty(null), 2000);
  assert.equal(dailyPenalty(RAIL_MIN), 0);
  assert.equal(dailyPenalty(RAIL_MAX), 0);
  assert.ok(dailyPenalty(1000) > 0, 'U/S allein = perfekt → zu leicht');
  assert.ok(dailyPenalty(100) > 0, 'U/S allein fast nichts → zu schwer');
});

test('Strecke des Tages: U-/S-Bahn-Stationen, mit Umstieg, gespeichert für den ganzen Tag', { timeout: 120_000 }, async () => {
  const d = new DailyService(net, null, { file, now: fixedNow });
  const r = await d.round(null);
  assert.equal(r.day, '2026-11-03');
  assert.equal(r.number, 2);
  for (const id of [r.from.id, r.to.id]) assert.ok(net.linesAt(id, 'regular').some((l) => l.mode === 'U' || l.mode === 'S'), `${id} an U/S`);
  assert.equal(r.played, null);
  // neuer Dienst (Neustart) → dieselbe Strecke
  const again = await new DailyService(net, null, { file, now: fixedNow }).round(null);
  assert.deepEqual([again.from.id, again.to.id], [r.from.id, r.to.id]);

  // beste Verbindung nachfahren → volle Punkte; Vergleich nur mit U + S liegt im Zielbereich (meistens)
  const res0 = await d.submit([], null).catch((e: Error) => e);
  assert.ok(res0 instanceof Error, 'ohne Linie → Fehler');
  const probe = await d.submit([{ line: 'U1', from: r.from.id, to: r.to.id }], null);
  const best = probe.routes[0];
  const legs = best.legs
    .filter((l) => l.mode !== 'W' && l.line && l.fromStation && l.toStation)
    .map((l) => ({ line: l.line!.split('/')[0], from: l.fromStation!, to: l.toStation! }));
  const res = await d.submit(legs, null);
  assert.ok(res.points >= 1000, `beste Verbindung: ${res.points} Punkte (${res.error ?? 'ok'})`);
  assert.ok(best.legs.filter((l) => l.mode !== 'W').length >= 2, 'mindestens ein Umstieg');
  assert.notEqual(res.railMin, null, 'nur mit U + S erreichbar');
  const rail = scoreRoute(res.railMin!, res.bestMin);
  assert.ok(rail >= 50 && rail <= 1300, `U/S-Wertung ${rail}`);
});

test('Rundenvorbereitung blockiert den Server nicht – Spiel beenden bricht sie ab', { timeout: 120_000 }, async () => {
  // ohne Abgeben an die Ereignisschleife lief die ganze Vorbereitung (10 Runden Profi) am Stück: 1–3 s keine Antwort
  const g = new Game('RESP1', net, { rounds: 10, difficulty: 'expert', restrictions: 'always', roundTimeLimitSec: null, locate: false });
  const host = g.addPlayer('Host');
  let maxLag = 0;
  let last = Date.now();
  const lag = () => {
    const now = Date.now();
    maxLag = Math.max(maxLag, now - last);
    last = now;
  };
  const tick = setInterval(lag, 10);
  const t0 = Date.now();
  await g.start(host.token);
  // Runde 1 offen, Runden 2–10 werden im Hintergrund vorbereitet → jetzt beenden
  const rounds = (g as unknown as { rounds: { ready: Promise<unknown> }[] }).rounds;
  const tEnd = Date.now();
  g.endGame(host.token);
  assert.equal(g.state().phase, 'lobby', 'noch keine Runde aufgelöst → zurück in die Lobby');
  await Promise.allSettled(rounds.map((r) => r.ready));
  lag(); // auch eine Blockade bis zum Schluss mitzählen (dann feuert der Takt gar nicht)
  clearInterval(tick);
  assert.ok(Date.now() - tEnd < 1500, `Vorbereitung lief nach dem Beenden noch ${Date.now() - tEnd} ms weiter`);
  assert.ok(maxLag < 700, `Server war ${maxLag} ms am Stück blockiert (Start bis Ende ${Date.now() - t0} ms)`);
});

test('Fahrplan-Abfrage gibt den Server frei und lässt sich abbrechen (Ursache für langsames „Spiel beenden“)', async () => {
  const efa = await import('../server/efa.ts');
  const { withCancel } = await import('../server/plancontext.ts');
  const [a, b] = [...net.stations.keys()].filter((id) => net.data.efaIds[id]?.length).slice(0, 2);
  const { slotTime } = await import('../server/timeslots.ts');
  // Referenztag → eigener Fahrplan (rechnet synchron, ohne Netzwerk)
  const q = { from: net.data.efaIds[a][0], to: net.data.efaIds[b][0], time: slotTime('wd12', 'regular', net.data.regularDays), count: 1 };
  assert.ok((await import('../server/timetable.ts')).localTrip(q), 'eigener Fahrplan antwortet');
  // eine Anfrage (setImmediate = „Netzwerk“) kommt vor dem Ende der Abfrage dran
  const order: string[] = [];
  setImmediate(() => order.push('anfrage'));
  await efa.trip(q).catch(() => []);
  order.push('abfrage');
  assert.deepEqual(order, ['anfrage', 'abfrage']);
  await assert.rejects(
    withCancel(() => true, () => efa.trip(q)),
    (e: Error) => e instanceof efa.CancelledError,
  );
});
