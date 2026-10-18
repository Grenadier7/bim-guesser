// Kurs – Querverbindungen: Linien, die nicht ins Zentrum fahren
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { ask, chip, chips, type Course, crossings, farEnd, GUERTEL_RADIAL, have, L, lineQuiz, nearEnd, pick, quiz, RADIAL_FAMILY, RADIAL_OTHER, type Step, table, TANGENTIAL, TRANS_TANGENTIAL, U_LINES } from './common.ts';

export const tangentialCourse: Course = {
  id: 'tangential',
  icon: '🔗',
  title: 'Querverbindungen',
  short: 'Linien, die nicht ins Zentrum fahren – und welche U-Bahnen sie verbinden',
  build() {
    const tang = have(TANGENTIAL);
    const gRad = have(GUERTEL_RADIAL);
    const trans = have(TRANS_TANGENTIAL);
    const us = U_LINES.filter((u) => L(u));
    const links = (id: string) => us.map((u) => [u, crossings(id, u)[0]] as const).filter((x): x is readonly [string, Station] => !!x[1]);
    const linkText = (id: string) => links(id).map(([u, s]) => `${chip(u)} ${esc(s.name)}`).join(' · ') || '–';
    const bus = have(['13A', '10A', '48A']);
    const steps: Step[] = [
      {
        title: 'Quer statt über die Mitte',
        html: `<p>Wer von einem Strahl zum nächsten will, muss nicht ins Zentrum: Querverbindungen wie ${chips(tang)} verbinden die Radiallinien direkt – oft deutlich schneller.</p>`,
        lines: tang,
      },
      {
        title: 'Welche U-Bahnen verbinden sie?',
        html: `<p>Jede Querverbindung kreuzt mehrere U-Bahnen – merk dir die Umstiege:</p>${table(tang.map((id) => [chip(id), linkText(id)]))}`,
        lines: tang,
        context: us,
        marks: [...new Map(tang.flatMap((id) => links(id).map(([, s]) => s)).map((s) => [s.name, s])).values()],
      },
      {
        title: 'Strahlen, die erst am Gürtel starten',
        html: `<p>Manche Bim-Linien beginnen nicht am Ring, sondern am <b>Gürtel</b> bei der U6 und fahren von dort hinaus:</p>
          ${table(gRad.map((id) => [chip(id), `${esc(nearEnd(id).name)} → <b>${esc(farEnd(id).name)}</b>`]))}`,
        lines: gRad,
        context: ['U6'],
        marks: gRad.map(nearEnd),
      },
      {
        title: 'Quer durch Transdanubien',
        html: `<p>Nördlich der Donau verbinden ${chips(trans)} Floridsdorf, Kagran und Aspern – also U6, U1 und U2:</p>${table(trans.map((id) => [chip(id), linkText(id)]))}`,
        lines: trans,
        context: have(['U1', 'U2', 'U6']),
      },
    ];
    if (bus.length)
      steps.push({
        title: 'Auch Busse verbinden',
        html: `<p>Bekannte Quer-Busse wie ${chips(bus)} fahren dort, wo keine Bim ist:</p>${table(bus.map((id) => [chip(id), linkText(id)]))}`,
        lines: bus,
        context: us,
      });
    const multi = tang.filter((id) => links(id).length >= 2);
    if (multi.length) {
      const id = pick(multi);
      const [[ua, sa], [ub, sb]] = links(id);
      const connects = (x: string) => links(x).some(([u]) => u === ua) && links(x).some(([u]) => u === ub);
      steps.push(
        ...ask(
          lineQuiz(
            `Welche Linie verbindet die ${ua} (${sa.name}) mit der ${ub} (${sb.name}) – ohne Umweg übers Zentrum?`,
            id,
            [...tang, ...have(RADIAL_FAMILY)].filter((x) => !connects(x)),
            `Die ${id} verbindet ${links(id).map(([u, s]) => `${u} (${s.name})`).join(', ')}.`,
          ),
        ),
      );
    }
    steps.push(
      ...ask(lineQuiz('Welche dieser Linien fährt NICHT ins Zentrum?', pick(tang), have([...RADIAL_FAMILY, ...RADIAL_OTHER]), `${tang.join(', ')} sind Querverbindungen.`)),
    );
    if (gRad.length) {
      const g = pick(gRad);
      steps.push(
        ...ask(quiz(`Wo beginnt die ${g}?`, nearEnd(g).name, ['Schottentor', 'Oper/Karlsplatz', 'Schwedenplatz', 'Schottenring', ...gRad.map((x) => nearEnd(x).name)], `Die ${g} startet am Gürtel bei ${nearEnd(g).name}.`)),
      );
    }
    return steps;
  },
};
