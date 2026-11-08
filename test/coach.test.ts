// Kurs-Tipp nach der Routenjagd: Zuordnung Linie → Kurs, Auswertung eines Spiels, wann ein Tipp kommt
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RoundReveal } from '../shared/types.ts';
import { addGame, analyzeGame, courseOfLine, prompted, suggest, type CoachState, type LineLookup } from '../client/src/coach.ts';

const MODES: Record<string, 'U' | 'S' | 'T' | 'B' | 'N'> = { U1: 'U', U6: 'U', S45: 'S', '13A': 'B', '48A': 'B', '43': 'T', '25': 'T', '6': 'T', '67': 'T', '26': 'T', N25: 'N' };
const DISTRICT: Record<string, number> = { a: 1, fav: 10, flo: 21 };
const net: LineLookup = { mode: (id) => MODES[id] ?? null, district: (id) => DISTRICT[id] ?? null };

test('Linie → Kurs', () => {
  assert.equal(courseOfLine('U6', 'a', net), 'ubahn');
  assert.equal(courseOfLine('S45', 'a', net), 'sbahn');
  assert.equal(courseOfLine('13A', 'a', net), 'busnr');
  assert.equal(courseOfLine('N25', 'flo', net), 'night');
  assert.equal(courseOfLine('43', 'a', net), 'radial');
  assert.equal(courseOfLine('6', 'a', net), 'ring');
  assert.equal(courseOfLine('25', 'flo', net), 'danube');
  // andere Bims nach Gegend
  assert.equal(courseOfLine('67', 'fav', net), 'south');
});

const leg = (line: string | null, from = 'a') => ({ mode: (line ? MODES[line] : 'W') as 'U', line, color: '', fromName: '', toName: '', fromStation: from, toStation: null, dep: '', arr: '', path: [] });
function reveal(index: number, best: (string | null)[], mine: string[], route: number): RoundReveal {
  return {
    index,
    cancelled: false,
    routes: [{ key: '', legs: best.map((l) => leg(l)), medianMin: 20, minMin: 20, maxMin: 20, rideMin: 20, samples: 1 }],
    evaluations: [
      {
        playerId: 'me',
        playerName: 'Ich',
        legs: mine.map((l) => ({ line: l, from: 'x', to: 'y' })),
        route: { key: '', legs: [], medianMin: 30, minMin: 30, maxMin: 30, rideMin: 30, samples: 1 },
        durationMin: 30,
        costMin: 30,
        matchedRank: null,
        source: 'computed',
        error: null,
        elapsedSec: 60,
        timedOut: false,
        tips: [],
        guesses: null,
        locateDist: null,
        score: { route, tipShare: 0, routeAfterTips: route, timeBonus: 0, locate: 0, multiplier: 1, total: route },
      },
    ],
  };
}

test('Spiel auswerten: nur Linien der schnellen Verbindung, die man ausließ, und nur in schwachen Runden', () => {
  const g = analyzeGame('g1', [reveal(0, ['U1', null, '13A'], ['U1', '43'], 500), reveal(1, ['48A'], ['48A'], 1000), reveal(2, ['13A', 'U6'], ['U6'], 1000)], 'me', net)!;
  assert.deepEqual(g.cats, { busnr: 1 });
  assert.deepEqual(g.lines.busnr, ['13A']);
  assert.ok(Math.abs(g.share - 2500 / 3000) < 1e-9);
});

const fresh = (): CoachState => ({ games: [], sincePrompt: 0, lastPrompt: 0, snoozed: {} });
const courses = (done = false) => ['ubahn', 'sbahn', 'radial', 'busnr'].map((id) => ({ id, done, mastered: false }));
const busGame = (id: string, share = 0.7) => ({ id, share, cats: { busnr: 1 }, lines: { busnr: ['13A'] } });

test('Tipp: erst nach 2 Spielen, dann höchstens alle 3 Spiele und 20 h; „Später“ legt den Kurs eine Woche weg', () => {
  const s = fresh();
  addGame(s, busGame('1'));
  assert.equal(suggest(s, courses()), null);
  assert.equal(addGame(s, busGame('1')), false, 'dasselbe Spiel zählt nur einmal');
  addGame(s, busGame('2'));
  const now = Date.now();
  assert.deepEqual(suggest(s, courses(), now), { kind: 'course', course: 'busnr', lines: ['13A'] });
  prompted(s, 'busnr', true, now);
  for (const id of ['3', '4', '5']) addGame(s, busGame(id));
  assert.equal(suggest(s, courses(), now + 3600_000), null, 'zu bald');
  assert.equal(suggest(s, courses(), now + 2 * 86400_000), null, 'weggeklickt');
  assert.equal(suggest(s, courses(), now + 8 * 86400_000)?.course, 'busnr');
});

test('Tipp: insgesamt schwach und noch kein Kurs → mit dem Lernpfad anfangen', () => {
  const s = fresh();
  addGame(s, busGame('1', 0.2));
  addGame(s, busGame('2', 0.3));
  assert.deepEqual(suggest(s, courses()), { kind: 'start', course: 'ubahn' });
  // mit gemachten Kursen: stattdessen der passende
  assert.equal(suggest(s, courses(true))?.kind, undefined, 'gemachter Kurs braucht deutlich mehr Fehler');
});
