// Kurs – Radiallinien: Strahlen vom Ring hinaus – und wo sie U2 und U6 kreuzen
import { NET_COLOR } from '../../netcolors.ts';
import { app } from '../../store.ts';
import { esc } from '../../ui.ts';
import { compass } from '../../training/coach.ts';
import { ask, CENTER, chip, chips, type Course, crossings, DIAMETRAL, districtName, farEnd, have, lineQuiz, mainOf, nearEnd, pick, quiz, RADIAL_FAMILY, RADIAL_OTHER, RING_LINES, route, stationByName, stationsOf, type Step, table, TANGENTIAL } from './common.ts';

/**
 * Farben für den Gesamtüberblick: drei Sorten Strahlen. U-Bahnen behalten immer ihre Linienfarbe; die übrigen Farben
 * dürfen keiner U-Bahn (U3 orange, U4 grün …) und nicht der S-Bahn (blau) ähneln.
 */
const KIND_COLOR = { radial: '#9e1b32', diameter: '#5f3dc4', ring: '#0c8599' };

export const radialCourse: Course = {
  id: 'radial',
  icon: '🎯',
  title: 'Radiallinien',
  short: 'Strahlen vom Ring hinaus – und wo sie U2 und U6 kreuzen',
  build() {
    const family = have(RADIAL_FAMILY);
    const others = have(RADIAL_OTHER);
    const diam = have(DIAMETRAL);
    const radials = [...family, ...others];
    const schottentor = stationByName('Schottentor');
    const firstX = (id: string, u: string) => crossings(id, u)[0];
    const u6x = radials.filter((id) => firstX(id, 'U6')).map((id) => [id, firstX(id, 'U6')!] as const);
    /** Gesamtbild: alle Strahlen zusammen, nach Sorte eingefärbt */
    const overview = (): Step => {
      const ringRays = have(RING_LINES);
      const diameters = diam.filter((id) => !ringRays.includes(id));
      // jede Linie nur in einer Sorte – wer ein Stück die Ringstraße fährt, ist ein Ring-Strahl
      const rays = radials.filter((id) => !ringRays.includes(id));
      const colors: Record<string, string> = {};
      // Badner Bahn bleibt blau wie überall
      for (const id of rays) colors[id] = id === 'BB' ? NET_COLOR.BB : KIND_COLOR.radial;
      for (const id of diameters) colors[id] = app.net.lines.get(id)?.mode === 'U' ? app.net.lines.get(id)!.color : KIND_COLOR.diameter;
      for (const id of ringRays) colors[id] = KIND_COLOR.ring;
      const sw = (c: string) => `<span class="swatch" style="background:${c}"></span>`;
      return {
        title: 'Alle Strahlen zusammen',
        html: `<p>So sieht das ganze Spinnennetz aus – drei Sorten Strahlen:</p>
          ${table([
            [`${sw(KIND_COLOR.radial)} <b>Radial</b>`, `vom Ring hinaus: ${chips(rays, colors)}`],
            [`${diameters.every((id) => app.net.lines.get(id)?.mode === 'U') ? '🚇' : sw(KIND_COLOR.diameter)} <b>Durchmesser</b>`, `quer durchs Zentrum: ${chips(diameters, colors)}${diameters.some((id) => app.net.lines.get(id)?.mode === 'U') ? ' <small class="muted">(U-Bahn in ihren Linienfarben)</small>' : ''}`],
            [`${sw(KIND_COLOR.ring)} <b>Ring-Strahlen</b>`, `ein Stück die Ringstraße entlang, dann hinaus: ${chips(ringRays, colors)}`],
          ])}
          <p class="muted">Fast jede Gegend hat „ihren“ Strahl ins Zentrum – wer ihn kennt, findet fast immer eine direkte Verbindung.</p>`,
        lines: [...rays, ...diameters, ...ringRays],
        colors,
        bands: { ring: true },
        allLabels: true,
      };
    };
    const steps: Step[] = [
      {
        title: 'Wien ist ein Spinnennetz',
        html: `<p>Das Wiener Netz hat drei Sorten Linien:</p>
          <ul><li><b>Radiallinien</b> – Strahlen, die vom Zentrum (Ring) nach außen fahren.</li>
          <li><b>Ringe</b> – Ringstraße, Gürtel, Vorortelinie: sie laufen ums Zentrum herum.</li>
          <li><b>Querverbindungen</b> – verbinden Strahlen miteinander, ohne ins Zentrum zu fahren.</li></ul>
          <p>Auf der Karte: die Bim-Radiallinien. Sie alle beginnen am Ring.</p>`,
        lines: radials,
      },
      {
        title: 'Die Schottentor-Familie',
        html: `<p>${chips(family)} starten alle bei <b>Schottentor</b> (U2) und fächern sich nach <b>Nordwesten</b> auf:</p>
          ${table(family.map((id) => [chip(id), `→ ${esc(farEnd(id).name)} <small>(${esc(districtName(farEnd(id).district))})</small>`]))}
          <p class="muted">Merkhilfe: 37/38 → Döbling · 40/41/42 → Währing · 43 → Hernals · 44 → Ottakring.</p>`,
        lines: family,
        marks: schottentor ? [schottentor] : [],
      },
      {
        title: 'Weitere Strahlen vom Ring',
        html: table(others.map((id) => [chip(id), `${esc(nearEnd(id).name)} → <b>${esc(farEnd(id).name)}</b> <small>(nach ${compass(CENTER, farEnd(id))})</small>`])),
        lines: others,
        marks: others.map(nearEnd),
      },
      {
        title: 'Durchmesserlinien',
        html: `<p>${chips(diam)} fahren <b>durch</b> das Zentrum – auf beiden Seiten sind sie Radiallinien:</p>${table(diam.map((id) => [chip(id), route(id)]))}`,
        lines: diam,
      },
      overview(),
      {
        title: 'Zwei Ringe kreuzen (fast) alle',
        html: `<p>Wer einen Strahl hinausfährt, kreuzt fast immer zuerst die ${chip('U2')} (am Ring) und dann die ${chip('U6')} (am Gürtel). Dort steigt man um, um <b>quer</b> zu fahren:</p>
          ${table(radials.map((id) => [chip(id), `${chip('U2')} ${esc(firstX(id, 'U2')?.name ?? '–')} · ${chip('U6')} ${esc(firstX(id, 'U6')?.name ?? '–')}`]))}`,
        lines: radials,
        context: ['U2', 'U6'],
        marks: u6x.map(([, s]) => s),
      },
    ];
    const [qLine, qStation] = pick(u6x);
    steps.push(
      ...ask(
        quiz(
          `Wo kreuzt die ${qLine} die U6?`,
          qStation.name,
          [...u6x.map(([, s]) => s.name), ...mainOf('U6').map((s) => s.name)].filter((n) => !crossings(qLine, 'U6').some((c) => c.name === n)),
          `Die ${qLine} trifft die U6 bei ${qStation.name}.`,
        ),
      ),
      ...ask(
        quiz(
          `Wo beginnen ${family.join(', ')}?`,
          'Schottentor',
          ['Schottenring', 'Oper/Karlsplatz', 'Parlament/Volkstheater', 'Schwedenplatz'],
          'Die ganze Familie startet bei Schottentor, direkt an der U2.',
        ),
      ),
      ...ask(lineQuiz('Welche dieser Linien ist eine Radiallinie?', pick(radials), have(TANGENTIAL), 'Radiallinien beginnen am Ring – die anderen sind Querverbindungen.')),
    );
    const q4 = pick(family);
    steps.push(
      ...ask(
        quiz(
          `Wohin fährt die ${q4} vom Schottentor?`,
          farEnd(q4).name,
          family.filter((id) => !stationsOf(q4).some((s) => s.id === farEnd(id).id)).map((id) => farEnd(id).name),
          `Die ${q4} fährt nach ${farEnd(q4).name}.`,
        ),
      ),
    );
    return steps;
  },
};
