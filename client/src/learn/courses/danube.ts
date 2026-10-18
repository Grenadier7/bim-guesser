// Kurs – Über die Donau & Transdanubien
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import type { Piece } from '../../netmap.ts';
import { ask, chip, chips, colorOf, type Course, farEnd, have, L, lineQuiz, mainOf, net, pick, quiz, stationByName, stationsOf, type Step, table, TRANSDANUBIEN, U_LINES } from './common.ts';

export const danubeCourse: Course = {
  id: 'danube',
  icon: '🌉',
  title: 'Über die Donau & Transdanubien',
  short: 'Die Brücken – und wie U6, U1 und U2 drüben verbunden sind',
  build() {
    const crossers = net()
      .data.lines.filter((l) => l.mode !== 'N' && L(l.id))
      .filter((l) => {
        const st = stationsOf(l.id);
        return st.some((s) => TRANSDANUBIEN.has(s.district)) && st.some((s) => !TRANSDANUBIEN.has(s.district));
      });
    const by = (m: string) => crossers.filter((l) => l.mode === m).map((l) => l.id);
    const trams = by('T');
    const buses = by('B');
    /** wo die Linie die Donau quert: letzte Station davor, erste danach */
    const bridge = (id: string) => {
      const m = mainOf(id);
      const i = m.findIndex((s, k) => k > 0 && TRANSDANUBIEN.has(s.district) !== TRANSDANUBIEN.has(m[k - 1].district));
      return i > 0 ? { m, i } : null;
    };
    /** nur die Querung zeichnen (2 Stationen je Seite); Linien über dieselbe Brücke zu einem Strich zusammenfassen */
    const crossPieces = (ids: string[]): Piece[] => {
      const groups = new Map<string, { ids: string[]; sts: Station[] }>();
      for (const id of ids) {
        const b = bridge(id);
        if (!b) continue;
        const key = [b.m[b.i - 1].id, b.m[b.i].id].sort().join('|');
        const g = groups.get(key);
        if (g) g.ids.push(id);
        else groups.set(key, { ids: [id], sts: b.m.slice(Math.max(0, b.i - 2), b.i + 2) });
      }
      return [...groups.values()].map(({ ids: g, sts }) => ({
        line: g[0],
        from: sts[0].name,
        to: sts[sts.length - 1].name,
        label: (['S1', 'S2', 'S3', 'S4'].every((x) => g.includes(x)) ? ['S1–S4', ...g.filter((x) => !/^S[1-4]$/.test(x))] : g).join(' · '),
        labelFrac: 0.5,
      }));
    };
    const steps: Step[] = [
      {
        title: 'Über die Donau nur auf Schienen',
        html: `<p>Der 21. und 22. Bezirk liegen jenseits der Donau. Hinüber fahren:</p>
          ${table([
            ['U-Bahn', chips(by('U'))],
            ['S-Bahn', chips(by('S'))],
            ['Bim', chips(trams) || '–'],
          ])}
          <p>${buses.length ? `Dazu die Busse ${chips(buses)}.` : '<b>Kein einziger Tagbus</b> quert laut Fahrplan die Donau – über den Fluss geht es tagsüber nur auf Schienen.'}</p>
          <p class="muted">Tipp: Am schnellsten kommst du fast immer mit U1, U2, U6 oder der S-Bahn hinüber.</p>
          <p class="muted">Auf der Karte nur die Stücke über den Fluss – S-Bahnen auf derselben Brücke als ein Strich.</p>`,
        pieces: crossPieces([...by('U'), ...by('S'), ...trams, ...buses]),
      },
      {
        title: 'Wo die Brücken sind',
        html: table(
          [...by('U'), ...trams].map((id) => {
            const br = bridge(id);
            if (!br) return [chip(id), '–'];
            const [a, b] = TRANSDANUBIEN.has(br.m[br.i].district) ? [br.m[br.i - 1], br.m[br.i]] : [br.m[br.i], br.m[br.i - 1]];
            return [chip(id), `${esc(a.name)} → ${esc(b.name)}`];
          }),
        ),
        pieces: crossPieces([...by('U'), ...trams]),
        marks: [...by('U'), ...trams].flatMap((id) => {
          const br = bridge(id);
          return br ? [TRANSDANUBIEN.has(br.m[br.i].district) ? br.m[br.i] : br.m[br.i - 1]] : [];
        }),
      },
      ...transdanubienSteps(),
    ];
    if (trams.length)
      steps.push(...ask(lineQuiz('Welche Bim fährt über die Donau?', pick(trams), have(['5', '18', '43', '49', 'D', '71', '6']).filter((x) => !trams.includes(x)), `Nur ${trams.join(', ')} quert die Donau.`)));
    steps.push(
      ...ask(lineQuiz('Welche U-Bahn fährt NICHT über die Donau?', pick(U_LINES.filter((u) => L(u) && !by('U').includes(u))), by('U'), 'U3 und U4 bleiben südlich der Donau.')),
      ...ask(quiz('Welcher Bus fährt über die Donau?', buses.length ? buses[0] : 'Keiner – nur Schienen', ['13A', '48A', '5A', '11A', 'Keiner – nur Schienen'], buses.length ? `Der ${buses[0]} quert die Donau.` : 'Tagsüber quert kein Bus die Donau.')),
    );
    return steps;
  },
};

/** Verkehr nördlich der Donau: drei U-Bahnen, quer verbunden durch Bim und Busse */
function transdanubienSteps(): Step[] {
  const us = have(['U6', 'U1', 'U2']);
  if (us.length < 3) return [];
  const uIds = new Map(us.map((u) => [u, new Set(stationsOf(u).map((s) => s.id))]));
  /** U-Bahnen, die die Linie nördlich der Donau trifft (mit Station), von West nach Ost: U6 → U1 → U2 */
  const uSeq = (id: string) => {
    const seq: { u: string; at: Station }[] = [];
    for (const s of mainOf(id))
      for (const [u, set] of uIds) if (TRANSDANUBIEN.has(s.district) && set.has(s.id) && !seq.some((x) => x.u === u)) seq.push({ u, at: s });
    return seq.sort((a, b) => us.indexOf(a.u) - us.indexOf(b.u));
  };
  /** „U1 Kagran → U2 Stadlau → weiter bis …“ – in Richtung U1 → U2 gelesen */
  const via12 = (id: string) => {
    const seq = uSeq(id);
    const u1 = seq.find((x) => x.u === 'U1')!;
    const u2 = seq.find((x) => x.u === 'U2')!;
    const m = mainOf(id);
    const om = m.findIndex((x) => x.id === u1.at.id) > m.findIndex((x) => x.id === u2.at.id) ? [...m].reverse() : m;
    const end = om[om.length - 1];
    return `${chip('U1')} ${esc(u1.at.name)} → ${chip('U2')} ${esc(u2.at.name)}${end.id !== u2.at.id ? ` → weiter bis <b>${esc(end.name)}</b>` : ''}`;
  };
  const inTd = (id: string) => {
    const m = mainOf(id);
    return m.filter((s) => TRANSDANUBIEN.has(s.district)).length / m.length >= 0.6;
  };
  // Querverbindungen: Bims, die mindestens zwei der drei U-Bahnen treffen
  const trams = net()
    .data.lines.filter((l) => l.mode === 'T' && L(l.id))
    .map((l) => l.id)
    .filter((id) => uSeq(id).length >= 2);
  const buses = net()
    .data.lines.filter((l) => l.mode === 'B' && L(l.id) && inTd(l.id))
    .map((l) => l.id);
  const touches = (id: string) => new Set(uSeq(id).map((x) => x.u));
  const links12 = buses.filter((id) => touches(id).has('U1') && touches(id).has('U2'));
  const links61 = buses.filter((id) => touches(id).has('U6') && touches(id).has('U1') && !links12.includes(id));
  const feeders = buses.filter((id) => touches(id).size === 1);
  // Zubringer nach Knoten: wo der Bus die U-Bahn trifft
  const hubs = new Map<string, { u: string; ids: string[] }>();
  for (const id of feeders) {
    const { u, at } = uSeq(id)[0];
    const e = hubs.get(at.name) ?? hubs.set(at.name, { u, ids: [] }).get(at.name)!;
    e.ids.push(id);
  }
  const bigHubs = [...hubs].filter(([, e]) => e.ids.length >= 2).sort((a, b) => us.indexOf(a[1].u) - us.indexOf(b[1].u) || b[1].ids.length - a[1].ids.length);
  const uColor = Object.fromEntries(us.map((u) => [u, colorOf(L(u)!)]));
  const feederColors: Record<string, string> = {};
  for (const [, e] of bigHubs) for (const id of e.ids) feederColors[id] = uColor[e.u];
  const tramLinks = (id: string) =>
    uSeq(id)
      .map(({ u, at }) => `${chip(u)} ${esc(at.name)}`)
      .join(' · ') || '–';
  const allThree = trams.filter((id) => touches(id).size === 3);

  const steps: Step[] = [
    {
      title: 'Transdanubien: drei U-Bahnen',
      html: `<p>Nördlich der Donau gibt es drei U-Bahnen, die wie Finger vom Zentrum hinausfahren:</p>
        ${table([
          [chip('U6'), `im Westen nach <b>Floridsdorf</b>`],
          [chip('U1'), `in der Mitte über <b>Kagran</b> nach <b>${esc(farEnd('U1').name)}</b>`],
          [chip('U2'), `im Osten über <b>Stadlau</b> nach <b>${esc(farEnd('U2').name)}</b>`],
        ])}
        <p>Quer dazwischen verbinden die Bims ${chips(trams)} die drei Finger:</p>
        ${table(trams.map((id) => [chip(id), tramLinks(id)]))}`,
      lines: trams,
      context: us,
      marks: ['Floridsdorf', 'Kagran', 'Stadlau'].map(stationByName).filter((x): x is Station => !!x),
    },
  ];
  if (links12.length)
    steps.push({
      title: 'Von der U1 zur U2 – und weiter',
      html: `<p>Typisch für Transdanubien: Viele Busse fahren <b>von der U1 zur U2</b> und von dort weiter hinaus. So kommst du ohne Umweg übers Zentrum von einem Finger zum nächsten:</p>
        ${table(links12.map((id) => [chip(id), via12(id)]))}
        ${links61.length ? `<p class="muted">Zwischen ${chip('U6')} und ${chip('U1')} pendeln ${chips(links61)}.</p>` : ''}`,
      lines: [...links12, ...links61],
      context: ['U1', 'U2', ...(links61.length ? ['U6'] : [])],
      allLabels: true,
    });
  if (bigHubs.length)
    steps.push({
      title: 'Zubringer: alles fährt zur U-Bahn',
      html: `<p>Die übrigen Busse sind <b>Zubringer</b>: Sie sammeln die Siedlungen ein und enden an einer U-Bahn-Station. Die Farbe zeigt, zu welcher U-Bahn:</p>
        ${table(bigHubs.map(([name, e]) => [`${chip(e.u)} <b>${esc(name)}</b>`, chips(e.ids, feederColors)]))}
        <p class="muted">Faustregel: Wer nach Breitenlee, Eßling oder Aspern will, fährt mit der U2 hinaus und steigt in die 80er/90er um – nach Leopoldau oder Süßenbrunn mit der U1 und den 20er/30ern.</p>`,
      lines: bigHubs.flatMap(([, e]) => e.ids),
      colors: feederColors,
      context: us,
      allLabels: true,
      marks: bigHubs.slice(0, 6).map(([name]) => stationByName(name)).filter((x): x is Station => !!x),
    });
  if (links12.length)
    steps.push(
      ...ask(lineQuiz('Welcher Bus verbindet die U1 mit der U2?', pick(links12), feeders, `${links12.join(', ')} fahren von der U1 zur U2.`)),
    );
  if (allThree.length)
    steps.push(
      ...ask(
        lineQuiz(
          'Welche Bim verbindet U6, U1 und U2?',
          pick(allThree),
          [...trams.filter((id) => !allThree.includes(id)), ...have(['30', '31', '29A', '24A', '26A'])],
          `${allThree.join(' und ')} ${allThree.length > 1 ? 'kreuzen' : 'kreuzt'} alle drei U-Bahnen.`,
        ),
      ),
    );
  return steps;
}
