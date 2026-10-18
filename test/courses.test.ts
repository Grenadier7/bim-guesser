// Kurse: jeder Kurs lässt sich mit den echten Netzdaten bauen, jede Frage ist gültig
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { NetworkPublic } from '../shared/types.ts';
import { NetIndex } from '../client/src/net.ts';
import { app } from '../client/src/store.ts';

app.net = new NetIndex(JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url), 'utf8')) as NetworkPublic);
app.net.mode = 'regular';
// Kurse erst nach dem Netz laden (sie lesen beim Bauen app.net)
const { COURSES } = await import('../client/src/learn/courses/list.ts');

for (const course of COURSES)
  test(`Kurs „${course.title}“`, () => {
    // Fragen werden zufällig gewählt – mehrmals bauen
    for (let run = 0; run < 15; run++) {
      const steps = course.build();
      assert.ok(steps.length >= 3, 'zu wenige Schritte');
      for (const st of steps) {
        const text = `${st.title} ${st.html} ${st.quiz ? st.quiz.q + st.quiz.explain + st.quiz.options.map((o) => o.html).join('') : ''}`;
        assert.ok(!/undefined|NaN|\[object Object\]/.test(text), `kaputter Text in „${st.title}“: ${text.slice(0, 200)}`);
        if (!st.quiz) continue;
        const ids = st.quiz.options.map((o) => o.id);
        assert.ok(ids.includes(st.quiz.correct), `richtige Antwort fehlt: ${st.quiz.q}`);
        assert.equal(new Set(ids).size, ids.length, `doppelte Antwort: ${st.quiz.q}`);
        assert.ok(ids.length >= 3, `zu wenige Antworten: ${st.quiz.q}`);
      }
    }
  });
