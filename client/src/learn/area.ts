// Lernen → Üben → „Linien einer Gegend“: Bezirk wählen oder auf die Karte tippen, Verkehrsmittel wählen –
// alle Linien, die dort halten, ansehen, üben oder merken (Wunsch N-1).
import type { Mode } from '../../../shared/types.ts';
import { MODE_ICON, MODE_LABEL } from '../../../shared/rules.ts';
import { netLayer, netView } from '../netmap.ts';
import { app } from '../store.ts';
import { esc, h, lineChip, toast } from '../ui.ts';
import { addMine, linesInArea, scopeOfLines, stationsInArea, type AreaPick } from './model.ts';
import { studyView } from './study.ts';

const RADII = [500, 1000, 2000];
const MODES: Mode[] = ['U', 'S', 'T', 'B'];
/** so viele Linien höchstens in einer Übungsrunde – die mit den meisten Halten in der Gegend */
const MAX_PRACTICE = 12;

export function areaView(panel: HTMLElement, back: () => void) {
  const net = app.net;
  let area: AreaPick | null = null;
  let radius = 1000;
  const modes = new Set<Mode>(['U', 'S', 'T', 'B']);

  const label = () => {
    const a = area;
    if (a?.kind === 'district') return `${a.id}. ${net.data.districts.find((d) => d.id === a.id)?.name ?? ''}`;
    return a ? `${(radius / 1000).toLocaleString('de-AT')} km um den Punkt` : '';
  };

  function drawMap(found: ReturnType<typeof linesInArea>) {
    if (!area) {
      netLayer().render(netView({ dimAll: true }));
      app.map.showLearnArea(null, false);
      return;
    }
    const a = area;
    const geo = a.kind === 'district' ? { rings: net.data.districts.find((d) => d.id === a.id)!.rings } : { circle: { lat: a.lat, lon: a.lon, radiusM: a.radiusM } };
    app.map.showLearnArea(geo, true, true);
    netLayer().render(netView({ focus: new Set(found.map((f) => f.line.id)), stops: stationsInArea(area), allLabels: found.length <= 20 }));
  }

  function render() {
    const found = area ? linesInArea(area, modes) : [];
    drawMap(found);
    const el = h('div', { class: 'learn area-pick' });
    el.innerHTML = `
      <button class="link" id="back">← Lernen</button>
      <h2>📍 Linien einer Gegend</h2>
      <p class="muted">Welche Linien fahren dort, wo du wohnst, arbeitest oder oft unterwegs bist? Bezirk wählen oder auf die Karte tippen.</p>
      <label class="field"><span>Bezirk</span>
        <select id="area-district" aria-label="Bezirk wählen"><option value="">— auf die Karte tippen —</option>${net.data.districts
          .map((d) => `<option value="${d.id}" ${area?.kind === 'district' && area.id === d.id ? 'selected' : ''}>${d.id}. ${esc(d.name)}</option>`)
          .join('')}</select></label>
      ${
        area?.kind !== 'district'
          ? `<div class="setting"><span>Umkreis</span><div class="seg">${RADII.map(
              (r) => `<button data-radius="${r}" class="${r === radius ? 'on' : ''}" aria-pressed="${r === radius}">${r < 1000 ? `${r} m` : `${r / 1000} km`}</button>`,
            ).join('')}</div></div>`
          : ''
      }
      <div class="setting"><span>Verkehrsmittel</span><div class="seg">${MODES.map(
        (m) => `<button data-mode="${m}" class="${modes.has(m) ? 'on' : ''}" aria-pressed="${modes.has(m)}" title="${MODE_LABEL[m]}">${MODE_ICON[m]} ${m === 'T' ? 'Bim' : m === 'B' ? 'Bus' : m}</button>`,
      ).join('')}</div></div>
      ${
        !area
          ? '<p class="hint">👆 Tippe auf die Karte oder wähle einen Bezirk.</p>'
          : found.length
            ? `<p><b>${found.length} Linie${found.length === 1 ? '' : 'n'}</b> in ${esc(label())}:</p>
               <div class="chips area-lines">${found.map((f) => `<span title="${f.stops} Halt${f.stops === 1 ? '' : 'e'} in der Gegend">${lineChip(f.line.mode, f.line.id, f.line.color)}</span>`).join('')}</div>
               <div class="hub-actions">
                 <button class="btn btn-primary" id="area-practice">Üben${found.length > MAX_PRACTICE ? ` (die ${MAX_PRACTICE} wichtigsten)` : ` (${found.length})`}</button>
                 <button class="btn btn-ghost" id="area-star">⭐ Alle merken</button>
               </div>
               ${found.length > MAX_PRACTICE ? `<small class="muted">Sortiert nach Halten in der Gegend – geübt werden die ersten ${MAX_PRACTICE}.</small>` : ''}`
            : '<p class="muted">Hier hält keine Linie der gewählten Verkehrsmittel.</p>'
      }`;
    panel.innerHTML = '';
    panel.append(el);

    el.querySelector('#back')!.addEventListener('click', () => {
      app.map.onTap(null);
      app.map.showLearnArea(null, false);
      back();
    });
    el.querySelector<HTMLSelectElement>('#area-district')!.addEventListener('change', (e) => {
      const v = Number((e.target as HTMLSelectElement).value);
      area = v ? { kind: 'district', id: v } : null;
      render();
    });
    el.querySelectorAll<HTMLButtonElement>('[data-radius]').forEach((b) =>
      b.addEventListener('click', () => {
        radius = Number(b.dataset.radius);
        if (area?.kind === 'circle') area = { ...area, radiusM: radius };
        render();
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = b.dataset.mode as Mode;
        if (modes.has(m) && modes.size === 1) return toast('Mindestens ein Verkehrsmittel', 'info');
        if (modes.has(m)) modes.delete(m);
        else modes.add(m);
        render();
      }),
    );
    el.querySelector('#area-practice')?.addEventListener('click', () => {
      const ids = found.slice(0, MAX_PRACTICE).map((f) => f.line.id);
      app.map.onTap(null);
      studyView({ panel, scope: () => scopeOfLines(ids, `Linien in ${label()}`), back: render }).start();
    });
    el.querySelector('#area-star')?.addEventListener('click', () => {
      addMine(found.map((f) => f.line.id));
      toast(`${found.length} Linien gemerkt – zu finden unter „Meine Linien üben“`, 'info');
    });
    // Karte antippen = Kreis um diesen Punkt
    app.map.onTap((ll) => {
      area = { kind: 'circle', lat: ll[0], lon: ll[1], radiusM: radius };
      render();
    });
  }

  render();
}
