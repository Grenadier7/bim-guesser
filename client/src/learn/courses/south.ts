// Kurs – Der Süden: Meidling, Liesing, Favoriten, Simmering
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { ask, chip, chips, type Course, crossings, DECADE, ends, farEnd, have, L, lineQuiz, net, pick, quiz, S_BRANCH, stationByName, stationsOf, type Step, table } from './common.ts';

/** Der Süden: Meidling (12), Liesing (23), Favoriten (10) und Simmering (11) */
const SOUTH = new Set([10, 11, 12, 23]);

export const southCourse: Course = {
  id: 'south',
  icon: '🧭',
  title: 'Der Süden',
  short: 'Meidling, Liesing, Favoriten und Simmering – U6, U1, U3, S-Bahn und die Querverbindungen',
  build() {
    const inSouth = (st: Station) => SOUTH.has(st.district);
    const southEnd = (id: string) => ends(id).find(inSouth) ?? farEnd(id);
    const rapid = (st: Station) =>
      net()
        .data.lines.filter((l) => (l.mode === 'U' || l.mode === 'S') && L(l.id) && stationsOf(l.id).some((x) => x.id === st.id))
        .map((l) => l.id);
    // Knoten: über den Süden verteilt (nach reiner Linienzahl lägen lauter S-Bahn-Stationen vorn)
    const lineCount = (st: Station) => st.lines.filter((id) => L(id) && net().lines.get(id)!.mode !== 'N').length;
    const hubs = ['Meidling', 'Hauptbahnhof', 'Matzleinsdorfer Platz', 'Reumannplatz', 'Simmering', 'Liesing']
      .map(stationByName)
      .filter((x): x is Station => !!x && rapid(x).length > 0);
    const tramRole: Record<string, string> = {
      '6': 'vom Gürtel über Matzleinsdorfer Platz und Reumannplatz nach Simmering',
      '11': 'quer: Favoriten (Reumannplatz) – Simmering – Kaiserebersdorf',
      '71': 'vom Ring über Simmering zum Zentralfriedhof',
      '62': 'von der Oper über Matzleinsdorfer Platz und Meidling nach Lainz',
      BB: 'Badner Bahn: von der Oper über Meidling nach Baden',
      '1': 'vom Ring nach Favoriten (Stefan-Fadinger-Platz)',
    };
    const trams = have(Object.keys(tramRole));
    const sRows: [string, string][] = [
      [chips(have(['S1', 'S2', 'S3', 'S4'])), 'Stammstrecke ab Meidling gemeinsam über Hetzendorf und Atzgersdorf nach <b>Liesing</b> – dichtester Takt'],
      ...(L('S80') ? [[chip('S80'), 'quer durch den Süden: Meidling – Hauptbahnhof – Simmering – über die Donau'] as [string, string]] : []),
      ...(L('S7') ? [[chip('S7'), 'über Geiselbergstraße und Kaiserebersdorf Richtung Flughafen'] as [string, string]] : []),
    ];
    const southBuses = net()
      .data.lines.filter((l) => l.mode === 'B' && /^[67]\d[AB]$/.test(l.id) && L(l.id))
      .map((l) => l.id);
    const busColors = Object.fromEntries(southBuses.map((id) => [id, DECADE[Math.floor(parseInt(id, 10) / 10)]]));

    const steps: Step[] = [
      {
        title: 'Drei U-Bahnen fächern nach Süden',
        html: `<p>Südlich des Gürtels teilen sich drei U-Bahnen das Gebiet:</p>
          ${table([
            [chip('U6'), `ab Meidling nach <b>${esc(southEnd('U6').name)}</b> <small>(Meidling, Liesing)</small>`],
            [chip('U1'), `ab Hauptbahnhof über Reumannplatz nach <b>${esc(southEnd('U1').name)}</b> <small>(Favoriten)</small>`],
            [chip('U3'), `über Gasometer nach <b>${esc(southEnd('U3').name)}</b> <small>(Simmering)</small>`],
          ])}
          <p class="muted">Die ${chip('U4')} streift den Süden nur bei Meidling Hauptstraße und Längenfeldgasse.</p>`,
        lines: have(['U6', 'U1', 'U3']),
        context: have(['U4']),
        marks: have(['U6', 'U1', 'U3']).map(southEnd),
      },
      {
        title: 'Die S-Bahn im Süden',
        html: table(sRows),
        pieces: L('S1') ? [{ line: 'S1', from: 'Meidling', to: 'Liesing', color: S_BRANCH.common, label: 'S1–S4', labelFrac: 0.6 }] : [],
        lines: have(['S80', 'S7']),
        marks: ['Meidling', 'Hauptbahnhof', 'Liesing'].map(stationByName).filter((x): x is Station => !!x),
      },
      {
        title: 'Die großen Knoten',
        html: `<p>Hier treffen sich die meisten Linien – gute Umsteigepunkte:</p>
          ${table(hubs.map((st) => [`<b>${esc(st.name)}</b> <small>${st.district}.</small>`, `${chips(rapid(st))} <small>· ${lineCount(st)} Linien</small>`]))}`,
        lines: [...new Set(hubs.flatMap(rapid))],
        marks: hubs,
        fitMarks: true,
      },
      {
        title: 'Bim im Süden',
        html: `<p>Die Straßenbahnen verbinden die Knoten miteinander und mit dem Zentrum:</p>
          ${table(trams.map((id) => [chip(id), tramRole[id]]))}
          <p class="muted">Merke: ${chip('11')} und ${chip('6')} sind die Querverbindungen zwischen Favoriten und Simmering.</p>`,
        lines: trams,
        context: have(['U6', 'U1', 'U3']),
      },
    ];
    if (southBuses.length)
      steps.push({
        title: 'Busse: 60er und 70er',
        html: `<p>Wie im Kurs „Busnummern“: Die <b>60er</b> fahren in Liesing und Favoriten (Knoten Liesing, Reumannplatz, Alterlaa), die <b>70er</b> in Simmering bis zum Zentralfriedhof und Alberner Hafen.</p>`,
        lines: southBuses,
        colors: busColors,
        allLabels: true,
        marks: ['Liesing', 'Reumannplatz', 'Simmering'].map(stationByName).filter((x): x is Station => !!x),
      });

    // Fragen – nur mit eindeutiger Antwort
    const ubahnEnds = have(['U6', 'U1', 'U3']).map((u) => [u, southEnd(u).name] as const);
    const [qu, qend] = pick(ubahnEnds);
    steps.push(...ask(lineQuiz(`Welche U-Bahn fährt nach ${qend}?`, qu, have(['U1', 'U2', 'U3', 'U4', 'U6']).filter((u) => u !== qu), `Die ${qu} endet im Süden in ${qend}.`)));
    const meet = crossings('U6', 'S1').filter(inSouth);
    if (meet.length === 1)
      steps.push(
        ...ask(quiz('Wo steigst du im Süden zwischen U6 und S-Bahn um?', meet[0].name, hubs.map((h) => h.name).filter((n) => !crossings('U6', 'S1').some((c) => c.name === n)), `Bei ${meet[0].name} treffen sich U6 und Stammstrecke.`)),
      );
    const taught = trams.filter((id) => ['62', '71', '6'].includes(id));
    const tq = pick(taught.length ? taught : trams.filter((id) => id !== 'BB'));
    const [ta, tb] = ends(tq);
    steps.push(
      ...ask(
        lineQuiz(
          `Welche Bim fährt von ${ta.name} nach ${tb.name}?`,
          tq,
          trams.filter((id) => !(stationsOf(id).some((x) => x.name === ta.name) && stationsOf(id).some((x) => x.name === tb.name))),
          `Die ${tq} fährt ${tramRole[tq]}.`,
        ),
      ),
    );
    return steps;
  },
};
