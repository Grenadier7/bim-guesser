// Kurs – Die S-Bahn: Stammstrecke, Äste, S45, S80 und die Pendler-S-Bahnen (S40/S50/S60)
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { shuffle } from '../model.ts';
import { distM } from '../../net.ts';
import type { Piece } from '../../netmap.ts';
import { ask, chip, chips, type Course, crossings, ends, farEnd, have, L, lineQuiz, mainOf, pick, quiz, S_BRANCH, segment, stationByName, stationsOf, type Step, table, taskStep, TRANSDANUBIEN, U_LINES } from './common.ts';
import { type AssignTask, crossingTask, identifyTask, orderTask, servesTask, terminalTask } from './tasks.ts';
import { NET_COLOR } from '../../netcolors.ts';

/** Pendler-S-Bahnen gut unterscheidbar (keine U-Bahn-Farbe) */
const COMMUTER_COLOR: Record<string, string> = { S40: '#0c8599', S50: '#9c36b5', S60: '#e8590c' };

/**
 * „Welche Farbe ist welche S-Bahn?“ – jede S-Bahn mit eigenem Stück in eigener Farbe und Buchstaben; S1–S4 teilen
 * sich die Stammstrecke (ein Stück), von der S7 zählt nur ihr eigener Teil ab Rennweg.
 */
function assignTask(): AssignTask | null {
  const parts: [string, Piece, string][] = [];
  const add = (answer: string, line: string, from: string, to: string, color: string, labelFrac = 0.5) => {
    if (L(line) && segment(line, from, to).length > 1) parts.push([answer, { line, from, to, labelFrac }, color]);
  };
  add('S1–S4', 'S1', 'Floridsdorf', 'Meidling', NET_COLOR.S, 0.35);
  if (L('S7')) add('S7', 'S7', 'Rennweg', ends('S7').find((s) => !TRANSDANUBIEN.has(s.district))?.name ?? '', '#f08c00', 0.7);
  for (const [id, color, frac] of [
    ['S40', '#0c8599', 0.3],
    ['S45', '#2f9e44', 0.5],
    ['S50', '#9c36b5', 0.4],
    ['S60', '#e03131', 0.2],
    ['S80', '#495057', 0.25],
  ] as const)
    if (L(id)) add(id, id, ends(id)[0].name, ends(id)[1].name, color, frac);
  if (parts.length < 4) return null;
  const keys = 'ABCDEFGH';
  const slots = shuffle(parts).map(([answer, piece, color], k) => ({ key: keys[k], color, answer, piece }));
  return {
    kind: 'assign',
    q: 'Welche S-Bahn ist welche? Ordne die Linien den farbigen Strecken zu.',
    slots,
    show: have(['S1', 'S2', 'S3', 'S4', 'S7', 'S40', 'S45', 'S50', 'S60', 'S80']),
    explain: 'S1–S4 teilen sich die Stammstrecke, die S7 biegt bei Rennweg ab, S45 fährt im Bogen durch die Vororte, S80 quer durch den Süden.',
  };
}

export const sbahnCourse: Course = {
  id: 'sbahn',
  icon: '🚆',
  title: 'Die S-Bahn',
  short: 'Stammstrecke und Äste, S45, S80 und die Pendlerzüge nach Niederösterreich',
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
      {
        title: 'Umsteigen in die U-Bahn',
        html: table(withU.map((s) => [`<b>${esc(s.name)}</b>`, chips(uAt(s))])),
        pieces: [stammPiece],
        context: us,
        marks: withU,
      },
    ];
    if (L('S7')) {
      const south7 = ends('S7').find((x) => x.id !== north('S7').id)!;
      // eigener Teil ab Rennweg kräftig und mit Namen – das Stück auf der Stammstrecke nur in deren Blau
      const own = segment('S7', 'Rennweg', south7.name);
      steps.push({
        title: 'Die S7 – zum Flughafen',
        html: `<p>Die ${chip('S7', branchColors)} fährt von <b>${esc(north('S7').name)}</b> über Floridsdorf auf der Stammstrecke bis <b>Rennweg</b> und biegt dann ab: ${own
          .slice(1)
          .map((s) => esc(s.name))
          .join(' – ')} – weiter Richtung <b>Flughafen Wien</b>.</p>`,
        pieces: [seg('S7', 'Rennweg', south7.name, S_BRANCH.S7, 'S7', 0.6)],
        // der Weg bis Rennweg nur blass (Stammstrecke und Nord-Äste)
        context: have(['S1', 'S2', 'S7']),
        marks: own,
      });
    }
    /** Umstiege einer Linie zur U-Bahn (je Station einmal, in Fahrtrichtung) */
    const uStops = (id: string) => mainOf(id).filter((s) => uAt(s).length);
    const transferTable = (id: string) => table(uStops(id).map((s) => [`<b>${esc(s.name)}</b>`, chips(uAt(s))]));
    const commuter = (
      [
        ['S40', 'Franz-Josefs-Bahn – weiter über Klosterneuburg nach Tulln'],
        ['S50', 'Westbahn – weiter durch den Wienerwald Richtung Neulengbach'],
        ['S60', 'weiter Richtung Wiener Neustadt und Bruck an der Leitha'],
      ] as const
    ).filter(([id]) => L(id));
    if (commuter.length)
      steps.push({
        title: 'S40, S50, S60 – hinaus nach Niederösterreich',
        html: `<p>Diese S-Bahnen sind vor allem Pendlerzüge: In Wien halten sie nur an <b>wenigen Stationen</b>, dann geht es weiter ins Umland. In der Stadt brauchst du sie selten – am ehesten, um schnell an den Stadtrand zu kommen.</p>
          ${table(commuter.map(([id, txt]) => [chip(id, COMMUTER_COLOR), `${mainOf(id).map((s) => esc(s.name)).join(' – ')}<br><small>${txt}</small>`]))}`,
        lines: commuter.map(([id]) => id),
        colors: COMMUTER_COLOR,
        context: core,
        // wo man in Wien am ehesten einsteigt: Hauptbahnhof und Grillgasse (S60) – dazu die Stadtränder
        marks: [...commuter.map(([id]) => farEnd(id)), ...['Hauptbahnhof', 'Grillgasse'].map(stationByName).filter((s): s is Station => !!s)],
      });
    if (L('S45')) {
      steps.push({
        title: 'Die S45 – die Vorortelinie',
        html: `<p>Die ${chip('S45')} fährt im Bogen durch die westlichen Bezirke: <b>Handelskai – Heiligenstadt – Gersthof – Hernals – Ottakring – Hütteldorf</b>. Sie meidet das Zentrum und verbindet die Außenbezirke direkt miteinander – ohne Umweg über die Innenstadt.</p>
          <p><b>Umsteigen in die U-Bahn:</b></p>${transferTable('S45')}`,
        lines: ['S45'],
        context: us,
        // gleich so nah, dass alle Stationen zu sehen sind
        marks: mainOf('S45'),
        fitMarks: true,
      });
      steps.push(...taskStep(crossingTask('S45', 'U3')));
    }
    if (L('S80')) {
      steps.push({
        title: 'Die S80 – quer durch den Süden',
        html: `<p>Die ${chip('S80')} ist die lange Querverbindung: von <b>Liesing</b> (oder über Speising von <b>Hütteldorf</b>) über Meidling, Hauptbahnhof und Simmering, dann über die Donau nach Stadlau und <b>Aspern Nord</b>. Wer vom Süden in die Donaustadt will, spart sich damit die Fahrt durchs Zentrum.</p>
          <p><b>Umsteigen in die U-Bahn:</b></p>${transferTable('S80')}`,
        lines: ['S80'],
        context: core,
        marks: uStops('S80'),
      });
      steps.push(...taskStep(terminalTask('S80')));
    }
    // alle S-Bahnen auf einen Blick: welche Farbe ist welche Linie?
    steps.push(...taskStep(assignTask()));
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
      ...ask(quiz('Wo beginnt die S40?', 'Franz-Josefs-Bahnhof', ['Westbahnhof', 'Hauptbahnhof', 'Praterstern', 'Handelskai'], 'Die S40 ist die Franz-Josefs-Bahn – sie startet am Franz-Josefs-Bahnhof.')),
      ...ask(lineQuiz('Welche S-Bahn verbindet Heiligenstadt, Hernals und Ottakring?', 'S45', have(['S40', 'S50', 'S80', 'S7', 'S60']), 'Die S45 fährt im Bogen durch die Vororte.')),
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
