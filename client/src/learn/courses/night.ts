// Kurs – Nachts in Transdanubien
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { ask, chip, chips, type Course, ends, farEnd, have, L, lineQuiz, nearEnd, net, pick, quiz, route, stationByName, stationsOf, type Step, table, TRANSDANUBIEN } from './common.ts';

export const nightCourse: Course = {
  id: 'night',
  icon: '🌙',
  title: 'Nachts in Transdanubien',
  short: 'Nightline-Busse, Nacht-U-Bahn und die Knoten Floridsdorf & Kagran',
  build() {
    const night = net().data.lines.filter((l) => l.mode === 'N' && L(l.id));
    // Nacht-Knoten im Zentrum: wo die meisten Nachtlinien halten
    const count = new Map<string, Set<string>>();
    for (const l of night) for (const s of stationsOf(l.id)) (count.get(s.name) ?? count.set(s.name, new Set()).get(s.name)!).add(l.id);
    const hubs = [...count].sort((a, b) => b[1].size - a[1].size).slice(0, 3);
    const trans = night.filter((l) => stationsOf(l.id).some((s) => TRANSDANUBIEN.has(s.district))).map((l) => l.id);
    const toCenter = trans.filter((id) => stationsOf(id).some((s) => !TRANSDANUBIEN.has(s.district)));
    const local = trans.filter((id) => !toCenter.includes(id));
    const serves = (id: string, name: string) => stationsOf(id).some((s) => s.name === name);
    const steps: Step[] = [
      {
        title: 'So funktioniert die Nacht',
        html: `<ul><li><b>Jede Nacht</b> (ca. 0:30–5:00) fahren die <b>Nightline-Busse</b> (N…).</li>
          <li><b>Fr/Sa-Nacht und vor Feiertagen</b> fahren zusätzlich <b>alle U-Bahnen durchgehend</b> (etwa alle 15 min).</li>
          <li>Die großen Nacht-Knoten im Zentrum: ${hubs.map(([n, s]) => `<b>${esc(n)}</b> (${s.size} Linien)`).join(', ')}.</li></ul>
          <p class="muted">Auf der Karte: die Nachtlinien in Transdanubien kräftig, die übrigen blass.</p>`,
        lines: trans,
        context: night.map((l) => l.id).filter((id) => !trans.includes(id)),
        marks: hubs.map(([n]) => stationByName(n)).filter((s): s is Station => !!s),
      },
      {
        title: 'Ins Zentrum und zurück',
        html: `<p>Nur wenige Nachtlinien queren die Donau:</p>${table(toCenter.map((id) => [chip(id), route(id)]))}
          <p class="muted">Am Wochenende kommst du auch mit ${chips(have(['U1', 'U2', 'U6']))} die ganze Nacht über die Donau.</p>`,
        lines: toCenter,
        context: have(['U1', 'U2', 'U6']),
      },
      {
        title: 'Verteilt wird in Floridsdorf und Kagran',
        html: `<p>Die übrigen Nachtlinien fahren nur nördlich der Donau – meist ab den großen Knoten:</p>
          ${table(
            local.map((id) => {
              const hub = ['Floridsdorf', 'Kagraner Platz', 'Kagran', 'Aspern Nord'].find((n) => serves(id, n) && !ends(id).some((e) => e.name === n));
              return [chip(id), `${route(id)}${hub ? ` <small>· über ${esc(hub)}</small>` : ''}`];
            }),
          )}`,
        lines: local,
        context: toCenter,
        marks: ['Floridsdorf', 'Kagraner Platz'].map(stationByName).filter((s): s is Station => !!s),
      },
    ];
    const t = pick(trans);
    steps.push(
      ...ask(
        quiz(
          `Wo startet die ${t} (Richtung ${farEnd(t).name})?`,
          nearEnd(t).name,
          ['Schwedenplatz', 'Oper/Karlsplatz', 'Floridsdorf', 'Kagran', 'Kagraner Platz', 'Westbahnhof'],
          `Die ${t} fährt ${ends(t)[0].name} ↔ ${ends(t)[1].name}.`,
        ),
      ),
      ...ask(
        quiz(
          'Wo ist der größte Nacht-Knoten im Zentrum?',
          hubs[0]?.[0] ?? 'Schwedenplatz',
          ['Praterstern', 'Westbahnhof', 'Floridsdorf', 'Kagran', ...hubs.slice(1).map(([n]) => n)],
          `An ${hubs[0]?.[0]} halten ${hubs[0]?.[1].size} Nachtlinien.`,
        ),
      ),
      ...ask(
        quiz(
          'Wann fährt die U-Bahn die ganze Nacht?',
          'Fr/Sa-Nacht und vor Feiertagen',
          ['Jede Nacht', 'Nur Samstag', 'Nie – nachts fahren nur Busse'],
          'In den Nächten vor Samstag, Sonntag und Feiertagen fahren alle U-Bahn-Linien durch.',
        ),
      ),
    );
    if (toCenter.length) {
      const c = pick(toCenter);
      steps.push(
        ...ask(
          lineQuiz(
            `Mit welcher Nachtlinie kommst du von ${nearEnd(c).name} nach ${farEnd(c).name}?`,
            c,
            // nur Linien, die gar nicht ins Zentrum fahren – es reicht zu wissen, welche Linien die Donau queren
            local.length >= 2 ? local : trans.filter((x) => !(serves(x, nearEnd(c).name) && serves(x, farEnd(c).name))),
            `Die ${c} quert die Donau – die anderen fahren nur nördlich der Donau.`,
          ),
        ),
      );
    }
    return steps;
  },
};
