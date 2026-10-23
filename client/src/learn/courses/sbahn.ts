// Kurs – Die S-Bahn: Stammstrecke, Äste und die übrigen S-Bahnen
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { shuffle } from '../model.ts';
import { distM } from '../../net.ts';
import type { Piece } from '../../netmap.ts';
import { ask, chip, chips, type Course, crossings, ends, farEnd, have, L, lineQuiz, pick, quiz, route, S_BRANCH, segment, stationByName, stationsOf, type Step, table, taskStep, TRANSDANUBIEN, U_LINES } from './common.ts';
import { crossingTask, identifyTask, orderTask, servesTask, terminalTask } from './tasks.ts';

export const sbahnCourse: Course = {
  id: 'sbahn',
  icon: '🚆',
  title: 'Die S-Bahn',
  short: 'Stammstrecke, ihre Äste und die übrigen S-Bahnen',
  build() {
    const core = have(['S1', 'S2', 'S3', 'S4']);
    if (!core.length) return [];
    const us = U_LINES.filter((u) => L(u));
    const stamm = segment('S1', 'Floridsdorf', 'Meidling');
    const uAt = (s: Station) => us.filter((u) => stationsOf(u).some((x) => x.id === s.id || distM(x, s) < 250));
    const withU = stamm.filter((s) => uAt(s).length);
    const seg = (line: string, from: string, to: string, color: string, label: string, labelFrac?: number): Piece => ({ line, from, to, color, label, labelFrac });
    const stammPiece = seg('S1', 'Floridsdorf', 'Meidling', S_BRANCH.common, 'S1–S4', 0.5);
    const branchColors = { S1: S_BRANCH.S1, S2: S_BRANCH.S2, S3: S_BRANCH.S34, S4: S_BRANCH.S34, S7: S_BRANCH.S7 };
    /** Nord-Ende eines Asts = die Endstation nördlich der Donau */
    const north = (id: string) => ends(id).find((s) => TRANSDANUBIEN.has(s.district)) ?? farEnd(id);
    const others = have(['S40', 'S45', 'S50', 'S60', 'S80']);
    const steps: Step[] = [
      {
        title: 'Die Stammstrecke',
        html: `<p>Zwischen <b>Floridsdorf</b> und <b>Meidling</b> fahren ${chips(core)} auf denselben Gleisen – ${stamm.length} Stationen quer durch die Stadt. Hier kommt alle paar Minuten eine S-Bahn, und <b>es ist egal, welche du nimmst</b>.</p>`,
        pieces: [stammPiece],
        marks: [stamm[0], stamm[stamm.length - 1]].filter(Boolean),
      },
      {
        title: 'Die Äste',
        html: `<p>An den Enden der Stammstrecke teilen sich die Linien:</p>
          ${table([
            [chip('S1', branchColors), `Norden: über Leopoldau → <b>${esc(north('S1').name)}</b>`],
            [chip('S2', branchColors), `Norden: → <b>${esc(north('S2').name)}</b>`],
            [`${chip('S3', branchColors)} ${chip('S4', branchColors)}`, `Norden: über Brünner Straße → <b>${esc(north('S3').name)}</b>`],
            [chips(core, branchColors), 'Süden: alle gemeinsam über Meidling → <b>Liesing</b>'],
          ])}
          <p class="muted">Richtung Norden also genau schauen, welche S-Bahn kommt – Richtung Süden ist es egal.</p>`,
        pieces: [
          stammPiece,
          seg('S1', 'Floridsdorf', north('S1').name, S_BRANCH.S1, 'S1'),
          seg('S2', 'Floridsdorf', north('S2').name, S_BRANCH.S2, 'S2'),
          seg('S3', 'Floridsdorf', north('S3').name, S_BRANCH.S34, 'S3/S4'),
          seg('S1', 'Meidling', 'Liesing', S_BRANCH.common, ''),
        ],
        // Verzweigungen und alle Ast-Enden als große Punkte mit Namen
        marks: [
          ...['Floridsdorf', 'Meidling'].map(stationByName),
          ...[...new Map(['S1', 'S2', 'S3'].filter((id) => L(id)).map((id) => [north(id).id, north(id)])).values()],
          stationByName('Liesing'),
        ].filter((s): s is Station => !!s),
      },
      ...taskStep(
        stationByName('Floridsdorf')
          ? {
              kind: 'tapStation',
              q: 'Tippe auf der Karte: Wo teilt sich die Stammstrecke im Norden in ihre Äste?',
              targets: [stationByName('Floridsdorf')!],
              tolM: 600,
              show: core,
              explain: 'In Floridsdorf: S1 über Leopoldau, S2 Richtung Mistelbach, S3/S4 über die Brünner Straße.',
            }
          : null,
      ),
      {
        title: 'Umsteigen in die U-Bahn',
        html: table(withU.map((s) => [`<b>${esc(s.name)}</b>`, chips(uAt(s))])),
        pieces: [stammPiece],
        context: us,
        marks: withU,
      },
    ];
    if (L('S7'))
      steps.push({
        title: 'Die S7 – zum Flughafen',
        html: `<p>Die ${chip('S7', branchColors)} fährt von <b>${esc(north('S7').name)}</b> über Floridsdorf auf der Stammstrecke bis <b>Rennweg</b> und biegt dann ab: St. Marx – Geiselbergstraße – <b>${esc(ends('S7').find((x) => x.id !== north('S7').id)!.name)}</b> – weiter Richtung <b>Flughafen Wien</b>.</p>`,
        pieces: [seg('S7', ends('S7')[0].name, ends('S7')[1].name, S_BRANCH.S7, 'S7')],
        context: core,
        marks: ['Rennweg'].map(stationByName).filter((s): s is Station => !!s),
      });
    steps.push(
      {
        title: 'Im Westen: S40, S45, S50',
        html: table(
          [
            ['S45', 'Vorortelinie im Bogen durch die Vororte'],
            ['S50', 'Westbahn ab Westbahnhof Richtung Wienerwald'],
            ['S40', 'Franz-Josefs-Bahn ab Franz-Josefs-Bahnhof Richtung Tulln'],
          ]
            .filter(([id]) => L(id))
            .map(([id, txt]) => [chip(id), `${route(id)}<br><small>${txt}</small>`]),
        ),
        lines: have(['S40', 'S45', 'S50']),
        context: have(['U4', 'U6']),
      },
      {
        title: 'Im Süden und Osten: S60, S80',
        html: `${table(have(['S60', 'S80']).map((id) => [chip(id), route(id)]))}
          <p>Die ${chip('S80')} ist die lange Querverbindung im Süden: Hütteldorf – Meidling – Hauptbahnhof – Simmering – über die Donau nach Stadlau und Aspern Nord.</p>`,
        lines: have(['S60', 'S80']),
        context: core,
      },
    );
    const unique = us
      .map((u) => [u, withU.filter((s) => uAt(s).includes(u))] as const)
      .filter(([, at]) => at.length === 1)
      .map(([u, at]) => [u, at[0]] as const);
    // auf der Karte: wo kreuzt die Stammstrecke diese U-Bahn?
    if (unique.length) steps.push(...taskStep(crossingTask('S1', pick(unique)[0])));
    for (const [u, s] of shuffle([...unique]).slice(0, 2))
      steps.push(...ask(quiz(`Wo steigst du von der Stammstrecke in die ${u} um?`, s.name, stamm.filter((x) => !uAt(x).includes(u)).map((x) => x.name), `Bei ${s.name} hält die ${u}.`)));
    steps.push(
      ...ask(lineQuiz('Welche S-Bahn fährt Richtung Flughafen?', 'S7', have(['S1', 'S2', 'S45', 'S50', 'S80']), 'Die S7 biegt nach Rennweg Richtung Flughafen ab.')),
      ...ask(quiz('Wo beginnt die S50?', 'Westbahnhof', ['Franz-Josefs-Bahnhof', 'Hauptbahnhof', 'Praterstern', 'Handelskai'], 'Die S50 ist die Westbahn – sie startet am Westbahnhof.')),
      ...ask(lineQuiz('Welche S-Bahn verbindet Hütteldorf mit Aspern Nord?', 'S80', have(['S45', 'S50', 'S7', 'S2']), 'Die S80 fährt quer durch den Süden bis Aspern Nord.')),
      ...ask(lineQuiz('Welche S-Bahn fährt NICHT über die Stammstrecke?', pick(others), core, `${core.join(', ')} fahren die Stammstrecke.`)),
    );
    return steps;
  },

  exam() {
    const core = have(['S1', 'S2', 'S3', 'S4']);
    const all = have(['S1', 'S2', 'S3', 'S4', 'S7', 'S40', 'S45', 'S50', 'S60', 'S80']);
    const us = U_LINES.filter((u) => L(u));
    const sCross = all.flatMap((s) => us.filter((u) => crossings(s, u).length === 1).map((u) => [s, u] as const));
    return [
      () => (sCross.length ? crossingTask(...(pick(sCross) as [string, string])) : null),
      () => terminalTask(pick(all)),
      () => orderTask(pick(all)),
      () => identifyTask(pick(all), all),
      () => (sCross.length ? crossingTask(...(pick(sCross) as [string, string])) : null),
      () => servesTask(pick(core.flatMap((id) => stationsOf(id))), all),
    ];
  },
};
