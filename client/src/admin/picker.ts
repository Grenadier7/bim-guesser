// Auswahl von Linien und Stationen wie im Routen-Baukasten: tippen → farbige Linien-Chips bzw. Stationen mit ihren
// Linien. In der Seite als Platzhalter <div data-picker="line|station" data-key="…" data-value="…">, mountPickers
// macht daraus das Eingabefeld; gewählt wird per Klick oder Enter (erster Treffer).
import type { Line, Station } from '../../../shared/types.ts';
import { normName } from '../../../shared/geo.ts';
import type { NetIndex } from '../net.ts';
import { esc, lineChip } from '../ui.ts';

const chip = (l: Line) => lineChip(l.mode, l.id, l.color);

/** Platzhalter für eine Auswahl (Text ist das, was im Feld steht) */
export function pickerSlot(kind: 'line' | 'station', key: string, value: string, placeholder = ''): string {
  return `<div class="picker" data-picker="${kind}" data-key="${esc(key)}" data-value="${esc(value)}" data-placeholder="${esc(placeholder)}"></div>`;
}

function findLines(net: NetIndex, q: string): Line[] {
  const n = q.trim().toLowerCase().replace(/\s+/g, '');
  if (!n) return [];
  const all = net.data.lines.filter((l) => l.mode !== 'W');
  return [...all.filter((l) => l.id.toLowerCase() === n), ...all.filter((l) => l.id.toLowerCase().startsWith(n) && l.id.toLowerCase() !== n)].slice(0, 14);
}

function findStations(net: NetIndex, q: string): Station[] {
  const n = normName(q);
  if (n.length < 2) return [];
  // genauer Name zuerst, dann Anfang, dann irgendwo; bei Gleichstand wichtige Stationen (U/S, viele Linien) vorne
  const rank = (s: Station) => {
    const x = normName(s.name);
    return x === n ? 0 : x.startsWith(n) ? 1 : x.includes(n) ? 2 : 9;
  };
  const weight = (s: Station) => (s.modes.includes('U') ? 20 : 0) + (s.modes.includes('S') ? 15 : 0) + (s.modes.includes('T') ? 5 : 0) + s.lines.length;
  return net.data.stations
    .filter((s) => rank(s) < 9)
    .sort((a, b) => rank(a) - rank(b) || weight(b) - weight(a) || a.name.localeCompare(b.name, 'de'))
    .slice(0, 8);
}

function stationHtml(net: NetIndex, s: Station): string {
  const lines = s.lines
    .map((id) => net.lines.get(id))
    .filter((l): l is Line => !!l && l.mode !== 'N')
    .slice(0, 10);
  return `📍 <b>${esc(s.name)}</b> <small class="muted">${s.district ? `${s.district}.` : ''}</small><span class="chips">${lines.map(chip).join('')}</span>`;
}

/** Alle Platzhalter in `root` zu Eingabefeldern machen */
export function mountPickers(root: HTMLElement, net: NetIndex, onPick: (key: string, id: string) => void) {
  root.querySelectorAll<HTMLElement>('[data-picker]').forEach((slot) => {
    const kind = slot.dataset.picker as 'line' | 'station';
    const key = slot.dataset.key!;
    const value = slot.dataset.value ?? '';
    const shown = kind === 'line' ? value : (net.stations.get(value)?.name ?? '');
    slot.innerHTML = `${
      value && (kind === 'line' ? net.lines.get(value) : net.stations.get(value))
        ? `<div class="picked">${kind === 'line' ? chip(net.lines.get(value)!) : stationHtml(net, net.stations.get(value)!)} <button type="button" class="link" data-change>ändern</button></div>`
        : ''
    }<input class="line-input picker-input" ${value && shown ? 'hidden' : ''} placeholder="${esc(slot.dataset.placeholder || (kind === 'line' ? 'Linie, z.B. S40' : 'Station suchen …'))}" value="${esc(shown)}" autocomplete="off" spellcheck="false">
      <div class="picker-results"></div>`;
    const input = slot.querySelector<HTMLInputElement>('input')!;
    const results = slot.querySelector<HTMLElement>('.picker-results')!;
    const hits = () => (kind === 'line' ? findLines(net, input.value).map((l) => l.id) : findStations(net, input.value).map((s) => s.id));
    const update = () => {
      const ids = hits();
      results.innerHTML = ids.length
        ? kind === 'line'
          ? `<div class="chips">${ids.map((id) => `<button type="button" class="line-opt" data-id="${esc(id)}">${chip(net.lines.get(id)!)}</button>`).join('')}</div>`
          : ids.map((id) => `<button type="button" class="station-opt" data-id="${esc(id)}">${stationHtml(net, net.stations.get(id)!)}</button>`).join('')
        : input.value.trim()
          ? '<span class="muted">Nichts gefunden.</span>'
          : '';
    };
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = hits()[0];
      if (first) onPick(key, first);
    });
    results.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
      if (id) onPick(key, id);
    });
    slot.querySelector('[data-change]')?.addEventListener('click', () => {
      slot.querySelector('.picked')?.remove();
      input.hidden = false;
      input.select();
      input.focus();
      update();
    });
  });
}
