import type { Mode, RouteLeg, RouteOption } from '../../shared/types.ts';
import { MODE_ICON, MODE_LABEL } from '../../shared/rules.ts';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.innerHTML = html;
  return el;
}

/** Linien-Chip, z.B. [🚇 U2] in Linienfarbe */
export function lineChip(mode: Mode, line: string | null, color: string): string {
  const label = line ? esc(line) : '';
  return `<span class="chip chip-${mode}" style="--c:${color}" title="${MODE_LABEL[mode]}${line ? ' ' + label : ''}">${MODE_ICON[mode]}${label ? `<b>${label}</b>` : ''}</span>`;
}

export function modeChip(mode: Mode): string {
  return `<span class="chip chip-${mode} chip-mode" title="${MODE_LABEL[mode]}">${MODE_ICON[mode]}</span>`;
}

/** Kette der öffentlichen Teilstrecken: [🚌 5B] › [🚇 U2] */
export function chain(legs: RouteLeg[]): string {
  const pt = legs.filter((l) => l.mode !== 'W');
  if (!pt.length) return lineChip('W', 'zu Fuß', '#777');
  return pt.map((l) => lineChip(l.mode, l.line, l.color)).join('<span class="sep">›</span>');
}

export function viaText(route: RouteOption): string {
  const pt = route.legs.filter((l) => l.mode !== 'W');
  const transfers = pt.slice(0, -1).map((l) => l.toName);
  return transfers.length ? `Umstieg: ${transfers.map(esc).join(', ')}` : 'ohne Umstieg';
}

function legMinutes(dep: string, arr: string): number {
  const [h1, m1] = dep.split(':').map(Number);
  const [h2, m2] = arr.split(':').map(Number);
  return (((h2 * 60 + m2 - (h1 * 60 + m1)) % 1440) + 1440) % 1440;
}

/** Aufgeklappte Route: jede Teilstrecke mit Ein-/Ausstieg, Zeiten und Fußwegen */
export function routeDetails(route: RouteOption): string {
  return `<ol class="leg-detail">${route.legs
    .map((l) => {
      const min = legMinutes(l.dep, l.arr);
      if (l.mode === 'W')
        return `<li class="ld-walk"><span class="ld-time">${esc(l.dep)}</span><span>🚶 ${min ? `${min} min ` : ''}zu Fuß${l.toName && l.toName !== l.fromName ? ` nach ${esc(l.toName)}` : ''}</span></li>`;
      return `<li><span class="ld-time">${esc(l.dep)}</span><span>${lineChip(l.mode, l.line, l.color)} <b>${esc(l.fromName)}</b> → <b>${esc(l.toName)}</b>
        <small>${esc(l.dep)}–${esc(l.arr)} · ${min} min</small></span></li>`;
    })
    .join('')}<li class="ld-end"><span class="ld-time">${esc(route.legs[route.legs.length - 1]?.arr ?? '')}</span><span>🏁 Ankunft</span></li></ol>${waitNote(route)}`;
}

/** Erklärt, warum die gewertete Zeit länger ist als die Beispielfahrt (Wartezeit am Start) */
function waitNote(route: RouteOption): string {
  if (route.waits?.length) {
    const items = route.waits
      .map((w) => `<li>${esc(w.station)} → ${esc(w.line)}: ${w.walkMin ? `${w.walkMin} min Umsteigen + ` : ''}Ø ${w.waitMin} min <small>(alle ~${w.everyMin} min)</small></li>`)
      .join('');
    return `<div class="wait-note">⏳ Gewertet: <b>${route.medianMin} min</b> mit Ø-Wartezeiten (halber Takt):<ul>${items}</ul><small>Oben eine Beispielfahrt – deren Anschlüsse können zufällig besser oder schlechter sein.</small></div>`;
  }
  const wait = route.medianMin - route.rideMin;
  if (wait < 2) return '';
  return `<p class="wait-note">⏳ Gewertet: <b>${route.medianMin} min</b> = Ø ${wait} min Warten auf die erste Abfahrt + ${route.rideMin} min unterwegs. Oben eine Beispielfahrt.</p>`;
}

/** Listeneinträge per Klick auf-/zuklappen */
export function makeExpandable(list: HTMLElement) {
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li.expandable');
    if (li && list.contains(li) && !(e.target as HTMLElement).closest('.rdetail')) li.classList.toggle('open');
  });
}

export function toast(msg: string, kind: 'error' | 'info' = 'error') {
  const el = h('div', { class: `toast toast-${kind}` }, esc(msg));
  document.body.append(el);
  setTimeout(() => el.classList.add('hide'), 3800);
  setTimeout(() => el.remove(), 4400);
}
