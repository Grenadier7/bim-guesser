// Kurs – Die Ringe: Ringstraße, Gürtel und Vorortelinie
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { distM } from '../../net.ts';
import type { Piece } from '../../netmap.ts';
import { NET_COLOR } from '../../netcolors.ts';
import { ask, chip, chips, type Course, GUERTEL, have, L, lineQuiz, mainOf, net, pick, RADIAL_FAMILY, RING_LINES, route, stationByName, stationsOf, type Step, table, taskStep } from './common.ts';
import { crossingTask, identifyTask } from './tasks.ts';

/** Nur die Ring-Stücke der Linien – der Rest der Linie lenkt ab. Die Stücke der Ringstraße liegen übereinander,
 *  die Nummernschilder sitzen deshalb an verschiedenen Stellen. */
const RING_PIECES: Piece[] = [
  { line: '1', from: 'Oper/Karlsplatz', to: 'Schwedenplatz', labelFrac: 0.75 },
  { line: '2', from: 'Schwedenplatz', to: 'Parlament', labelFrac: 0.2 },
  { line: '71', from: 'Schottenring', to: 'Schwarzenbergplatz', labelFrac: 0.15 },
  { line: 'D', from: 'Börse', to: 'Schwarzenbergplatz', labelFrac: 0.5 },
];
/** Gürtel im Süden: 6 und 18 fahren gemeinsam bis Matzleinsdorfer Platz – die 18 bleibt durchgehend in Bim-Rot,
 *  nur die 6 bekommt ab dort, wo sie abbiegt, eine eigene Farbe */
const SIX_EIGHTEEN = { both: NET_COLOR.Tfocus, '18': NET_COLOR.Tfocus, '6': '#7048e8' };
// die U6 bis Dresdner Straße: auch dort (Jägerstraße, Dresdner Straße) kreuzt sie noch Bims (31, 2)
const GUERTEL_PIECES: Piece[] = [
  { line: 'U6', from: 'Dresdner Straße', to: 'Längenfeldgasse', labelFrac: 0.3 },
  { line: '6', from: 'Burggasse-Stadthalle', to: 'Matzleinsdorfer Platz', color: SIX_EIGHTEEN.both, label: '6 + 18', labelFrac: 0.45 },
  { line: '18', from: 'Matzleinsdorfer Platz', to: 'Quartier Belvedere', color: SIX_EIGHTEEN['18'], label: '18', labelFrac: 0.6 },
  { line: '6', from: 'Matzleinsdorfer Platz', to: 'Reumannplatz', color: SIX_EIGHTEEN['6'], label: '6', labelFrac: 0.7 },
];

/** je Ring-Stück ein kurzes Stück hinaus (2 Stationen), blass – dort biegt die Linie als Strahl ab */
function ringStubs(): Piece[] {
  const out: Piece[] = [];
  for (const p of RING_PIECES) {
    if (!L(p.line)) continue;
    const m = mainOf(p.line).map((s) => s.name);
    const a = m.indexOf(p.from);
    const b = m.indexOf(p.to);
    if (a < 0 || b < 0) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (lo > 0) out.push({ line: p.line, from: m[Math.max(0, lo - 2)], to: m[lo], color: '#c4697a', label: '', quiet: true });
    if (hi < m.length - 1) out.push({ line: p.line, from: m[hi], to: m[Math.min(m.length - 1, hi + 2)], color: '#c4697a', label: '', quiet: true });
  }
  return out;
}
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
          <p class="muted">Blass auf der Karte: wo die Linien den Ring wieder verlassen. Unter der „Zweierlinie“, parallel zum Ring, fährt die ${chip('U2')}.</p>`,
        pieces: [...ringStubs(), ...RING_PIECES],
        context: ['U2'],
        bands: { ring: true },
      },
      {
        title: '2. Ring: der Gürtel',
        html: `<p>Die ${chip('U6')} fährt den West- und Nordgürtel entlang (Meidling – Spittelau). Im Süden übernehmen ${chips(have(['18', '6']))}:</p>
          ${table([
            [`<span class="swatch" style="background:${SIX_EIGHTEEN.both}"></span> ${chips(have(['6', '18']))}`, 'gemeinsam: Burggasse-Stadthalle – Westbahnhof – <b>Matzleinsdorfer Platz</b>'],
            [chip('18'), 'nur die 18: weiter den Gürtel entlang über Hauptbahnhof zum <b>Quartier Belvedere</b> (und weiter nach St. Marx)'],
            [`<span class="swatch" style="background:${SIX_EIGHTEEN['6']}"></span> ${chip('6', SIX_EIGHTEEN)}`, 'nur die 6: biegt ab nach Favoriten (Reumannplatz) und weiter nach Simmering'],
          ])}`,
        pieces: GUERTEL_PIECES,
        context: guertel,
        bands: { guertel: true },
        marks: [
          ...hubs.filter((s) => ['Westbahnhof', 'Spittelau', 'Längenfeldgasse', 'Meidling'].includes(s.name)),
          ...['Matzleinsdorfer Platz', 'Quartier Belvedere'].map(stationByName).filter((s): s is Station => !!s),
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
