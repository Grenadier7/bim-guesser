// Kurs – Die Ringe: Ringstraße, Gürtel und Vorortelinie
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { distM } from '../../net.ts';
import type { Piece } from '../../netmap.ts';
import { ask, chip, chips, type Course, GUERTEL, have, L, lineQuiz, net, pick, RADIAL_FAMILY, RING_LINES, route, stationByName, stationsOf, type Step, table, taskStep } from './common.ts';
import { crossingTask, identifyTask } from './tasks.ts';

/** Nur die Ring-Stücke der Linien – der Rest der Linie lenkt ab. Die Stücke der Ringstraße liegen übereinander,
 *  die Nummernschilder sitzen deshalb an verschiedenen Stellen. */
const RING_PIECES: Piece[] = [
  { line: '1', from: 'Oper/Karlsplatz', to: 'Schwedenplatz', labelFrac: 0.75 },
  { line: '2', from: 'Schwedenplatz', to: 'Parlament', labelFrac: 0.2 },
  { line: '71', from: 'Schottenring', to: 'Schwarzenbergplatz', labelFrac: 0.15 },
  { line: 'D', from: 'Börse', to: 'Schwarzenbergplatz', labelFrac: 0.5 },
];
const GUERTEL_PIECES: Piece[] = [
  { line: 'U6', from: 'Spittelau', to: 'Längenfeldgasse', labelFrac: 0.3 },
  { line: '18', from: 'Burggasse-Stadthalle', to: 'Quartier Belvedere' },
  { line: '6', from: 'Burggasse-Stadthalle', to: 'Matzleinsdorfer Platz', labelFrac: 0.6 },
];
/** wo die 6 den Gürtel verlässt: ab Matzleinsdorfer Platz nach Favoriten und Simmering */
const SIX_OFF: Piece = { line: '6', from: 'Matzleinsdorfer Platz', to: 'Geiereckstraße', color: '#8a8f98', label: '6', labelFrac: 0.85 };
const OUTER_PIECES: Piece[] = [{ line: 'S45', from: 'Handelskai', to: 'Hütteldorf', labelFrac: 0.5 }];

export const ringCourse: Course = {
  id: 'ring',
  icon: '💍',
  title: 'Die Ringe',
  short: 'Ringstraße, Gürtel und Vorortelinie',
  build() {
    const ring = have(RING_LINES);
    const guertel = have(GUERTEL);
    // Außenring: nur die Vorortelinie (die 10 ist eine Querverbindung, kein Ring)
    const outer = have(['S45']);
    const hub = (n: string) => stationByName(n);
    const hubs = ['Westbahnhof', 'Spittelau', 'Längenfeldgasse', 'Meidling', 'Hütteldorf', 'Handelskai'].map(hub).filter((s): s is Station => !!s);
    const rapidAt = (s: Station) =>
      net()
        .data.lines.filter((l) => (l.mode === 'U' || l.mode === 'S') && L(l.id) && stationsOf(l.id).some((x) => x.id === s.id || distM(x, s) < 250))
        .map((l) => l.id);
    const steps: Step[] = [
      {
        title: 'Drei Ringe um die Stadt',
        html: `<p>Um das Zentrum liegen drei „Ringe“ – alle Radiallinien schneiden sie:</p>
          <ol><li><b>Ringstraße</b> – ${chips(ring)} fahren je ein Stück davon.</li>
          <li><b>Gürtel</b> – ${chips(guertel)}.</li>
          <li><b>Außenring im Westen</b> – ${chips(outer)} (Vorortelinie).</li></ol>
          <p class="muted">Auf der Karte nur die Ring-Abschnitte – außerhalb fahren diese Linien als Strahlen weiter.</p>`,
        pieces: [...RING_PIECES, ...GUERTEL_PIECES, ...OUTER_PIECES],
        bands: { ring: true, guertel: true, vorort: true },
      },
      {
        title: '1. Ring: die Ringstraße',
        html: `<p>Keine Linie fährt den ganzen Ring rundherum – ${chips(ring)} teilen ihn sich und biegen dann als Strahlen hinaus:</p>
          ${table(ring.map((id) => [chip(id), route(id)]))}
          <p class="muted">Unter der „Zweierlinie“, parallel zum Ring, fährt die ${chip('U2')}.</p>`,
        pieces: RING_PIECES,
        context: ['U2'],
        bands: { ring: true },
      },
      {
        title: '2. Ring: der Gürtel',
        html: `<p>Die ${chip('U6')} fährt den West- und Nordgürtel entlang (Meidling – Spittelau). Im Süden übernehmen ${chips(have(['18', '6']))}:</p>
          ${table(guertel.map((id) => [chip(id), route(id)]))}
          ${L('6') ? `<p>Die ${chip('6')} verlässt den Gürtel am <b>Matzleinsdorfer Platz</b> und fährt über Quellenplatz und Reumannplatz weiter nach Simmering (grau auf der Karte).</p>` : ''}`,
        pieces: [...GUERTEL_PIECES, ...(L('6') ? [SIX_OFF] : [])],
        context: guertel,
        bands: { guertel: true },
        marks: [
          ...hubs.filter((s) => ['Westbahnhof', 'Spittelau', 'Längenfeldgasse', 'Meidling'].includes(s.name)),
          ...['Matzleinsdorfer Platz'].map(stationByName).filter((s): s is Station => !!s),
        ],
      },
      {
        title: '3. Ring: Vorortelinie',
        html: `<p>Die ${chip('S45')} fährt im Bogen durch die Vororte: <b>Handelskai – Heiligenstadt – Gersthof – Hernals – Ottakring – Hütteldorf</b>.</p>
          <p>Praktisch, um im Westen von Nord nach Süd zu kommen, ohne über den Gürtel zu fahren.</p>`,
        lines: outer,
        context: ['U6'],
        bands: { vorort: true },
        marks: hubs.filter((s) => ['Hütteldorf', 'Handelskai'].includes(s.name)),
      },
      {
        title: 'Wo sich Ringe und Strahlen treffen',
        html: `<p>An diesen Knoten trifft ein Ring auf eine Schnellbahn-Radiale – ideal zum Umsteigen:</p>${table(hubs.map((s) => [`<b>${esc(s.name)}</b>`, chips(rapidAt(s))]))}`,
        lines: have(['U6', 'S45']),
        context: have(['U3', 'U4', 'S50']),
        marks: hubs,
      },
    ];
    // eigene Aufgaben zu den Ringen (sonst kämen zufällige, z.B. „Wohin fährt die 1?“ – zu schwer)
    steps.push(
      ...taskStep(crossingTask('S45', 'U6')),
      ...taskStep(identifyTask(pick(have(['U6', 'S45', '18'])), have(['U6', 'S45', '18', '6', ...ring, ...RADIAL_FAMILY]))),
    );
    steps.push(
      ...ask(lineQuiz('Welche Linie fährt am Gürtel entlang?', pick(guertel), have([...RADIAL_FAMILY, '49', '31']), `${guertel.join(', ')} sind die Gürtel-Linien.`)),
      ...ask(lineQuiz('Welche S-Bahn ist die Vorortelinie?', 'S45', have(['S40', 'S50', 'S7', 'S80', 'S60']), 'Die S45 fährt von Handelskai im Bogen nach Hütteldorf.')),
      ...ask(lineQuiz('Welche Bim fährt ein Stück über die Ringstraße?', pick(ring), have(['5', '6', '9', '18', '46', '52', '60']), `${ring.join(', ')} teilen sich die Ringstraße.`)),
    );
    return steps;
  },
};
