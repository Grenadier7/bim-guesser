// Fortschritt: Level, Serie mit Joker-Tag, Wochenziel, Medaillen in Stufen, Zusammenführen beim Account-Sync
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEDALS, WEEK_GOAL, levelOf, medalList, reachedKeys, streakOf, trimActs, weekCount, weekStart, type MedalStats } from '../shared/career.ts';
import { mergeProgress } from '../shared/progress.ts';

const acts = (...days: string[]) => Object.fromEntries(days.map((d) => [d, 1]));

test('Level: 100, 150, 200 … XP je Stufe', () => {
  assert.equal(levelOf(0).level, 1);
  assert.equal(levelOf(100).level, 2);
  assert.equal(levelOf(250).level, 3);
  assert.deepEqual(levelOf(260), { level: 3, xp: 260, levelXp: 250, nextXp: 450 });
});

test('Serie: Tage in Folge; heute noch nicht gespielt → Serie lebt bis Mitternacht', () => {
  assert.equal(streakOf(acts('2026-11-01', '2026-11-02', '2026-11-03'), '2026-11-03').days, 3);
  const s = streakOf(acts('2026-11-01', '2026-11-02'), '2026-11-03');
  assert.equal(s.days, 2);
  assert.equal(s.today, false);
  assert.equal(streakOf({}, '2026-11-03').days, 0);
});

test('Joker: ein verpasster Tag reißt die Serie nicht – aber höchstens einer je 7 Tage', () => {
  // 1., 2., (3. verpasst), 4., 5.
  const s = streakOf(acts('2026-11-01', '2026-11-02', '2026-11-04', '2026-11-05'), '2026-11-05');
  assert.equal(s.days, 4);
  assert.deepEqual(s.jokers, ['2026-11-03']);
  assert.equal(s.jokerReady, false);
  // zwei Lücken innerhalb einer Woche → die ältere beendet die Serie
  const two = streakOf(acts('2026-11-01', '2026-11-03', '2026-11-05'), '2026-11-05');
  assert.equal(two.days, 2);
  // zwei Tage hintereinander verpasst → Serie weg
  assert.equal(streakOf(acts('2026-11-01', '2026-11-02', '2026-11-05'), '2026-11-05').days, 1);
  // gestern verpasst, vorgestern gespielt: Joker hält die Serie, bis heute gespielt wird
  const hold = streakOf(acts('2026-11-02', '2026-11-03'), '2026-11-05');
  assert.equal(hold.days, 2);
  assert.equal(hold.today, false);
});

test('Wochenziel zählt Montag bis Sonntag; alte Tage fallen beim Speichern weg', () => {
  assert.equal(weekStart('2026-11-05'), '2026-11-02');
  assert.equal(weekStart('2026-11-02'), '2026-11-02');
  const a = { '2026-11-01': 3, '2026-11-02': 2, '2026-11-04': 1 };
  assert.equal(weekCount(a, '2026-11-05'), 3);
  assert.ok(WEEK_GOAL >= 3);
  assert.deepEqual(Object.keys(trimActs({ '2026-01-01': 1, '2026-11-01': 1 }, '2026-11-05')), ['2026-11-01']);
});

const zero: MedalStats = {
  games: 0, wins: 0, perfect: 0, beat: 0, quizAce: 0, trainings: 0, courses: 0, tutorial: 0, friends: 0, level: 1,
  streak: 0, stations: 0, tramLines: 0, tramTotal: 28, night: 0, daily: 0, blindPerfect: 0, lateNight: 0,
};

test('Medaillen: Bronze/Silber/Gold mit Ziel der nächsten Stufe, versteckte erst nach dem Erreichen', () => {
  const m = medalList({ ...zero, games: 12, tramLines: 28 });
  const games = m.find((x) => x.id === 'games')!;
  assert.equal(games.tier, 2);
  assert.equal(games.next, 50);
  assert.match(games.text, /50 Routenjagden/);
  assert.equal(m.find((x) => x.id === 'tram')!.tier, 3, 'alle Bim-Linien = Gold');
  assert.equal(m.find((x) => x.id === 'tram')!.next, null);
  assert.ok(m.find((x) => x.id === 'blind')!.hidden);
  assert.deepEqual(reachedKeys(m).sort(), ['games:1', 'games:2', 'tram:1', 'tram:2', 'tram:3']);
  assert.equal(new Set(MEDALS.map((x) => x.id)).size, MEDALS.length, 'IDs eindeutig');
});

test('Account-Sync: Fortschritt zweier Geräte geht nie verloren (Tage, Sammelkarte, Zähler)', () => {
  const a = { xp: 100, acts: { '2026-11-01': 2 }, best: 3, lines: ['U1'], stations: ['s1'], c: { games: 4 } };
  const b = { xp: 80, acts: { '2026-11-01': 1, '2026-11-02': 1 }, best: 5, lines: ['U2'], stations: ['s1', 's2'], c: { games: 2, night: 1 } };
  const m = mergeProgress(a, b) as typeof a & { c: { night: number } };
  assert.equal(m.xp, 100);
  assert.deepEqual(m.acts, { '2026-11-01': 2, '2026-11-02': 1 });
  assert.equal(m.best, 5);
  assert.deepEqual(m.lines.sort(), ['U1', 'U2']);
  assert.deepEqual(m.stations.sort(), ['s1', 's2']);
  assert.deepEqual(m.c, { games: 4, night: 1 });
});
