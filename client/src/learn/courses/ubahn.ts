// Kurs – U-Bahn-Kreuzungen
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { shuffle } from '../model.ts';
import { ask, chip, type Course, crossings, L, quiz, route, type Step, table, U_LINES } from './common.ts';

export const ubahnCourse: Course = {
  id: 'ubahn',
  icon: '🚇',
  title: 'U-Bahn-Kreuzungen',
  short: 'Wo sich welche U-Bahnen treffen',
  build() {
    const us = U_LINES.filter((u) => L(u));
    const pairs: { a: string; b: string; at: Station[] }[] = [];
    for (let i = 0; i < us.length; i++)
      for (let j = i + 1; j < us.length; j++) {
        const at = crossings(us[i], us[j]);
        if (at.length) pairs.push({ a: us[i], b: us[j], at });
      }
    const allStations = [...new Map(pairs.flatMap((p) => p.at).map((s) => [s.name, s])).values()];
    const steps: Step[] = [
      {
        title: 'Das U-Bahn-Netz',
        html: `<p>Fünf Linien, ${allStations.length} Umsteigestationen zwischen ihnen (Punkte auf der Karte – Name beim Drüberfahren). Wer die kennt, findet fast jede Verbindung:</p>
          ${table(us.map((u) => [chip(u), route(u)]))}`,
        lines: us,
        marks: allStations,
      },
      {
        title: 'Wo sie sich kreuzen',
        html: table(pairs.map((p) => [`${chip(p.a)} × ${chip(p.b)}`, p.at.map((s) => esc(s.name)).join(', ')])),
        lines: us,
        marks: allStations,
      },
    ];
    for (const p of shuffle(pairs.filter((x) => x.at.length === 1)).slice(0, 4))
      steps.push(...ask(quiz(`Wo kreuzen sich ${p.a} und ${p.b}?`, p.at[0].name, allStations.map((s) => s.name), `${p.a} und ${p.b} treffen sich bei ${p.at[0].name}.`)));
    return steps;
  },
};
