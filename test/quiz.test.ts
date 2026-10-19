// Quiz: Fragen aus den echten Netzdaten – gültige Antworten, keine Sonderlinien oder Sonderhalte
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_QUIZ_SETTINGS, generateQuiz, gradeQuiz, QUIZ_TYPE_ORDER, type QuizNet, type QuizSettings } from '../shared/quiz.ts';
import { regularPatterns } from '../shared/rules.ts';
import type { NetworkPublic } from '../shared/types.ts';

const data = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8')) as NetworkPublic;
const byId = new Map(data.stations.map((s) => [s.id, s]));
const lines = new Map(data.lines.map((l) => [l.id, l]));
const net: QuizNet = {
  stations: data.stations,
  station: (id) => byId.get(id)!,
  line: (id) => lines.get(id),
  lines: data.lines,
  districts: data.districts,
  patterns: regularPatterns,
};

for (const type of QUIZ_TYPE_ORDER)
  test(`Fragetyp „${type}“`, () => {
    const weights = Object.fromEntries(QUIZ_TYPE_ORDER.map((t) => [t, t === type ? 4 : 1])) as QuizSettings['weights'];
    // mit Bussen, damit auch „Busnummer“ Fragen bekommt
    const qs = generateQuiz(net, { ...DEFAULT_QUIZ_SETTINGS, modes: ['U', 'S', 'T', 'B'], questions: 20, weights });
    assert.ok(qs.length >= 10, `nur ${qs.length} Fragen erzeugt`);
    for (const q of qs) {
      assert.equal(q.type, type);
      assert.ok(!/\b\d+E\b/.test(q.prompt), `Sonderlinie in „${q.prompt}“`);
      assert.ok(!/Dr\.-Natterer-Gasse|Stubenbastei/.test(q.prompt), `Sonderhalt in „${q.prompt}“`);
      if (q.options) {
        const ids = q.options.map((o) => o.id);
        assert.equal(new Set(ids).size, ids.length, `doppelte Antwort: ${q.prompt}`);
        const correct = Array.isArray(q.correct) ? (q.correct as string[]) : [q.correct as string];
        for (const c of correct) assert.ok(ids.includes(c), `richtige Antwort fehlt: ${q.prompt}`);
        assert.equal(gradeQuiz(q, q.correct), 1, `richtige Antwort gibt nicht 100 %: ${q.prompt}`);
      }
    }
  });
