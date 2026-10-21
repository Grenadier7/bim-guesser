// Interaktive Kurs-Aufgaben: Geometrie, Bewertung, Prüfungsablauf und dass jeder Kurs gültige Aufgaben erzeugt
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { NetworkPublic } from '../shared/types.ts';
import { NetIndex } from '../client/src/net.ts';
import { app } from '../client/src/store.ts';

app.net = new NetIndex(JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8')) as NetworkPublic);
app.net.mode = 'regular';
const T = await import('../client/src/learn/courses/tasks.ts');
const { COURSES } = await import('../client/src/learn/courses/list.ts');
const st = (name: string) => app.net.data.stations.find((s) => s.name === name)!;

test('Geometrie: konvexe Hülle und Punkt-in-Fläche', () => {
  const sq: [number, number][] = [[0, 0], [0, 2], [2, 2], [2, 0], [1, 1]];
  const hull = T.convexHull(sq);
  assert.equal(hull.length, 4);
  assert.ok(T.insidePolygon([1, 1], hull));
  assert.ok(!T.insidePolygon([3, 1], hull));
});

test('Station antippen: Toleranz, nächstes Ziel zählt', () => {
  const t = T.crossingTask('U3', 'U6')!;
  assert.deepEqual(t.targets.map((x) => x.name), ['Westbahnhof']);
  assert.equal(T.crossingTask('U2', 'U6'), null, 'U2 und U6 kreuzen sich nicht');
  const target = t.targets[0];
  assert.equal(T.gradeTapStation(t, [target.lat, target.lon]).ok, true);
  assert.equal(T.gradeTapStation(t, [target.lat + 0.02, target.lon]).ok, false); // ~2,2 km daneben
  assert.match(T.gradeTapStation(t, [target.lat + 0.02, target.lon]).note, /m daneben/);
});

test('Gegend antippen: 80er-Busse – mitten drin richtig, am Stephansplatz falsch', () => {
  const buses80 = app.net.data.lines.filter((l) => /^8\dA$/.test(l.id)).map((l) => l.id);
  const t = T.areaTask('Wo fahren die 80er?', buses80, '#000', '')!;
  assert.ok(t && t.stations.length > 5);
  const mid = t.stations[Math.floor(t.stations.length / 2)];
  assert.equal(T.gradeTapArea(t, [mid.lat, mid.lon]).ok, true);
  const steph = st('Stephansplatz');
  assert.equal(T.gradeTapArea(t, [steph.lat, steph.lon]).ok, false);
});

test('Ordnen und Mehrfachauswahl: nur ganz richtig zählt', () => {
  const o = T.orderTask('U6')!;
  assert.ok(o.items.length >= 4);
  assert.equal(T.gradeOrder(o, o.items.map((x) => x.id)).ok, true);
  assert.equal(T.gradeOrder(o, [...o.items].reverse().map((x) => x.id)).ok, false);
  const m = T.servesTask(st('Westbahnhof'), ['U3', 'U6', 'U1', 'U4', 'U2'])!;
  assert.deepEqual([...m.correct].sort(), ['U3', 'U6']);
  assert.equal(T.gradeMulti(m, ['U3', 'U6']).ok, true);
  assert.equal(T.gradeMulti(m, ['U3']).ok, false);
  assert.equal(T.gradeMulti(m, ['U3', 'U6', 'U1']).ok, false);
});

test('Zeichnen: genug Stationen getroffen und wenig daneben', () => {
  assert.equal(T.gradeSketch(0.8, 0.9).ok, true);
  assert.equal(T.gradeSketch(0.4, 0.9).ok, false);
  assert.equal(T.gradeSketch(0.9, 0.3).ok, false);
});

test('Prüfung: erster Versuch zählt, Fehler kommen als neue Variante wieder, gemeistert ab 80 %', () => {
  let n = 0;
  const gen = () => ({ kind: 'choice' as const, q: `Frage ${++n}`, options: [], correct: 'a', explain: '' });
  const run = new T.ExamRun([gen, gen, gen, gen, gen]);
  assert.equal(run.total, 5);
  run.answer(true);
  run.answer(false); // → Wiederholung hinten angehängt
  run.answer(true);
  run.answer(true);
  run.answer(true);
  assert.ok(run.isRetry);
  assert.notEqual(run.current!.q, 'Frage 2', 'Wiederholung ist eine neue Variante');
  run.answer(true);
  assert.equal(run.current, null);
  assert.equal(run.score, 4);
  assert.equal(run.passed, true); // 4/5 = 80 %
  const bad = new T.ExamRun([gen, gen, gen, gen, gen]);
  for (let i = 0; i < 5; i++) bad.answer(i < 3);
  assert.equal(bad.passed, false);
  // höchstens 3 Versuche je Aufgabe – keine Endlosschleife
  const stuck = new T.ExamRun([gen]);
  for (let i = 0; i < 10 && stuck.current; i++) stuck.answer(false);
  assert.equal(stuck.current, null);
});

for (const course of COURSES)
  test(`Kurs „${course.title}“: Aufgaben im Kurs und Prüfung sind gültig`, () => {
    for (let round = 0; round < 3; round++) {
      const exam = (course.exam?.() ?? T.defaultExam([...new Set(course.build().flatMap((s) => s.lines ?? []))])).map((g) => g());
      const tasks = exam.filter((t): t is NonNullable<typeof t> => !!t);
      assert.ok(tasks.length >= 4, `nur ${tasks.length} Prüfungsaufgaben`);
      for (const t of tasks) {
        assert.ok(t.q.length > 10, t.q);
        if (t.kind === 'tapStation') assert.ok(t.targets.length > 0);
        if (t.kind === 'tapArea') assert.ok(t.stations.length >= 3);
        if (t.kind === 'order') assert.ok(new Set(t.items.map((x) => x.label)).size === t.items.length, `doppelte Station: ${t.q}`);
        if (t.kind === 'choice') assert.ok(t.options.some((o) => o.id === t.correct), t.q);
        if (t.kind === 'multi') assert.ok(t.correct.every((c) => t.options.some((o) => o.id === c)), t.q);
      }
    }
  });

test('Bus-Kurs: Gegend der 80er und 90er wird im Kurs auf der Karte abgefragt', () => {
  const bus = COURSES.find((c) => c.id === 'busnr')!;
  const qs = bus.build().filter((s) => s.task?.kind === 'tapArea').map((s) => s.task!.q);
  assert.ok(qs.some((q) => q.includes('80er')) && qs.some((q) => q.includes('90er')), qs.join(' | '));
});
