// Kurs – Busnummern verraten die Gegend
import type { Station } from '../../../../shared/types.ts';
import { esc } from '../../ui.ts';
import { shuffle } from '../model.ts';
import { ask, chips, type Course, DECADE, districtName, ends, have, L, lineQuiz, net, pick, quiz, stationByName, stationsOf, type Step, table } from './common.ts';
import { areaTask, type Task, type TaskGen } from './tasks.ts';

/** Gegend je Zehnerstelle – die Reihenfolge läuft gegen den Uhrzeigersinn um die Stadt */
const BUS_REGION: Record<number, string> = { 2: 'Nordosten', 3: 'Norden', 4: 'Westen', 5: 'Südwesten', 6: 'Süden', 7: 'Südosten', 8: 'Osten', 9: 'Osten' };

export const busCourse: Course = {
  id: 'busnr',
  icon: '🔢',
  title: 'Busnummern verraten die Gegend',
  short: 'Die Zehnerstelle läuft gegen den Uhrzeigersinn um die Stadt',
  build() {
    const buses = net().data.lines.filter((l) => l.mode === 'B' && /^\d+[AB]$/.test(l.id) && L(l.id));
    const groups = new Map<number, { ids: string[]; districts: Map<number, number>; total: number; ends: Map<string, number> }>();
    for (const l of buses) {
      const g = Math.floor(parseInt(l.id, 10) / 10);
      const e = groups.get(g) ?? groups.set(g, { ids: [], districts: new Map(), total: 0, ends: new Map() }).get(g)!;
      e.ids.push(l.id);
      for (const s of stationsOf(l.id)) {
        e.districts.set(s.district, (e.districts.get(s.district) ?? 0) + 1);
        e.total++;
      }
      for (const s of ends(l.id)) e.ends.set(s.name, (e.ends.get(s.name) ?? 0) + 1);
    }
    const rows = [...groups.keys()].filter((g) => g >= 2).sort((a, b) => a - b);
    const ids = (gs: number[]) => gs.filter((g) => groups.has(g)).flatMap((g) => groups.get(g)!.ids);
    const top = (g: number) => [...groups.get(g)!.districts].sort((a, b) => b[1] - a[1])[0][0];
    /** Hauptbezirke mit Anteil, z.B. „23. Liesing (58 %), 10. Favoriten (23 %)“ */
    const where = (g: number) =>
      [...groups.get(g)!.districts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .filter(([, c], k) => k === 0 || c / groups.get(g)!.total >= 0.15)
        .map(([d, c]) => `${esc(districtName(d))} <small>(${Math.round((c / groups.get(g)!.total) * 100)} %)</small>`)
        .join(', ');
    /** Endstationen, an denen mehrere Busse dieser Gruppe enden */
    const hubsOf = (g: number) =>
      [...groups.get(g)!.ends]
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n]) => n);
    const colors: Record<string, string> = {};
    for (const [g, e] of groups) for (const id of e.ids) colors[id] = DECADE[g];
    const swatch = (g: number) => `<span class="swatch" style="background:${DECADE[g]}"></span>`;
    const head = (g: number) => `${swatch(g)} <b>${g}0A–${g}9A</b>`;
    const regionStep = (title: string, gs: number[], text: string): Step => {
      const shown = gs.filter((g) => groups.has(g));
      const hubs = [...new Set(shown.flatMap(hubsOf))];
      return {
        title,
        html: `<p>${text}</p>${table(shown.map((g) => [head(g), `${where(g)}${hubsOf(g).length ? `<br><small>Knoten: ${hubsOf(g).map(esc).join(', ')}</small>` : ''}`]))}`,
        lines: ids(shown),
        colors,
        allLabels: true,
        marks: hubs.map(stationByName).filter((s): s is Station => !!s),
      };
    };

    /** „Tippe in die Gegend, wo die 80er fahren“ – Auflösung zeigt die Gegend als Fläche */
    const areaOf = (g: number) =>
      areaTask(
        `Tippe auf der Karte in die Gegend, wo die ${g}0er-Busse fahren.`,
        groups.get(g)?.ids ?? [],
        DECADE[g],
        `Die ${g}0er fahren vor allem im ${districtName(top(g))}${BUS_REGION[g] ? ` (${BUS_REGION[g]})` : ''}.`,
      );
    const taskStep = (t: Task | null): Step[] => (t ? [{ title: 'Aufgabe', html: '', task: t }] : []);
    const regionWithTask = (title: string, gs: number[], text: string): Step[] => {
      const shown = gs.filter((g) => groups.has(g));
      return [regionStep(title, gs, text), ...(shown.length ? taskStep(areaOf(pick(shown))) : [])];
    };

    const steps: Step[] = [
      {
        title: 'Die Zehnerstelle zählt',
        html: `<p>Die Busse mit zweistelliger Nummer fahren in einer bestimmten Gegend – die Zehnerstelle läuft dabei <b>gegen den Uhrzeigersinn</b> um die Stadt, vom Nordosten über Westen und Süden in den Osten:</p>
          ${table(rows.map((g) => [head(g), `${esc(districtName(top(g)))}${BUS_REGION[g] ? ` <small>(${BUS_REGION[g]})</small>` : ''}`]))}`,
        lines: ids(rows),
        colors,
        allLabels: true,
      },
      ...regionWithTask('Norden: 20er und 30er', [2, 3], 'Jenseits der Donau und im Norden. Die 20er verteilen sich von Kagran und Floridsdorf aus, die 30er fahren in Floridsdorf und hinauf nach Döbling.'),
      ...regionWithTask('Westen: 40er und 50er', [4, 5], 'Die 40er erschließen die westlichen Vororte von Ottakring, Hernals und Hütteldorf aus, die 50er Hietzing und Penzing – oft ab der U4.'),
      ...regionWithTask('Süden: 60er und 70er', [6, 7], 'Die 60er fahren in Liesing und Favoriten (Knoten Liesing und Reumannplatz), die 70er in Simmering bis zum Zentralfriedhof und Alberner Hafen.'),
      regionStep('Osten: 80er und 90er', [8, 9], 'Zurück im Osten: Die 80er fahren durch die Donaustadt und den Prater, die 90er ausschließlich in der Donaustadt – rund um Kagran, Stadlau und Aspern.'),
      ...(groups.has(8) ? taskStep(areaOf(8)) : []),
      ...(groups.has(9) ? taskStep(areaOf(9)) : []),
    ];
    if (groups.has(0) || groups.has(1))
      steps.push({
        title: 'Unter 20: keine Regel',
        html: `<p>Bei den einstelligen und den 10er-Bussen hilft die Nummer nicht weiter:</p>
          <ul><li><b>1A–9A</b> – kurze Busse durch die Innenstadt und die inneren Bezirke (z.B. ${chips(have(['1A', '2A', '3A']))}).</li>
          <li><b>10A–19A</b> – längere Querverbindungen durch die inneren Bezirke, z.B. ${chips(have(['10A', '13A']))}.</li></ul>`,
        lines: ids([0, 1]),
        colors,
        allLabels: true,
      });

    // Fragen: Gegend zur Nummer, Nummer zur Gegend, Knoten zur Gruppe
    const opts = rows.map((g) => districtName(top(g)));
    for (const g of shuffle([...rows]).slice(0, 2)) {
      const id = pick(groups.get(g)!.ids);
      steps.push(...ask(quiz(`In welcher Gegend fährt der ${id} am ehesten?`, districtName(top(g)), opts, `${g}0er-Busse fahren vor allem im ${districtName(top(g))}.`)));
    }
    const g2 = pick(rows);
    steps.push(
      ...ask(
        lineQuiz(
          `Welcher Bus fährt im ${districtName(top(g2))}?`,
          pick(groups.get(g2)!.ids),
          rows.filter((g) => top(g) !== top(g2)).map((g) => pick(groups.get(g)!.ids)),
          `Die ${g2}0er fahren vor allem im ${districtName(top(g2))}.`,
        ),
      ),
    );
    const withHub = rows.filter((g) => hubsOf(g).length);
    if (withHub.length) {
      const g3 = pick(withHub);
      steps.push(
        ...ask(
          quiz(
            `Wo enden viele ${g3}0er-Busse?`,
            hubsOf(g3)[0],
            // nur Knoten, an denen keiner der gefragten Busse endet – sonst gäbe es zwei richtige Antworten
            rows.flatMap((g) => hubsOf(g)).filter((n) => !groups.get(g3)!.ends.has(n)),
            `Knoten der ${g3}0er: ${hubsOf(g3).join(', ')}.`,
          ),
        ),
      );
    }
    return steps;
  },

  exam() {
    const buses = net().data.lines.filter((l) => l.mode === 'B' && /^\d+[AB]$/.test(l.id) && L(l.id));
    const byDecade = new Map<number, string[]>();
    for (const l of buses) {
      const g = Math.floor(parseInt(l.id, 10) / 10);
      if (g >= 2) byDecade.set(g, [...(byDecade.get(g) ?? []), l.id]);
    }
    const decades = [...byDecade.keys()];
    const area: TaskGen = () => {
      const g = pick(decades);
      return areaTask(`Tippe in die Gegend, wo die ${g}0er-Busse fahren.`, byDecade.get(g)!, DECADE[g], `Das ist die Gegend der ${g}0er${BUS_REGION[g] ? ` (${BUS_REGION[g]})` : ''}.`);
    };
    // umgekehrt: Gegend auf der Karte (Linien neutral) → welche Zehnerstelle?
    const which: TaskGen = () => {
      const g = pick(decades);
      const others = shuffle(decades.filter((x) => x !== g)).slice(0, 3);
      return {
        kind: 'choice',
        q: 'Welche Busnummern fahren in der eingezeichneten Gegend?',
        options: shuffle([g, ...others]).map((x) => ({ id: String(x), html: `<b>${x}0A–${x}9A</b>` })),
        correct: String(g),
        explain: `Das sind die ${g}0er${BUS_REGION[g] ? ` im ${BUS_REGION[g]}` : ''}.`,
        show: { lines: byDecade.get(g)!, neutral: true },
      };
    };
    return [area, which, area, which, area, which];
  },
};
