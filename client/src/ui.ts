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
/** 👤 hinter Spielernamen mit Account – antippen öffnet das Profil (accountui.ts) */
export const accountTag = (p: { account?: string }) =>
  p.account ? ` <button class="acct-tag" data-profile="${esc(p.account)}" title="Profil von ${esc(p.account)}" aria-label="Profil von ${esc(p.account)}">👤</button>` : '';

export function lineChip(mode: Mode, line: string | null, color: string): string {
  const label = line ? esc(line) : '';
  return `<span class="chip chip-${mode}" style="--c:${color}" ${line && mode !== 'W' ? `data-chip-line="${label}"` : ''} title="${MODE_LABEL[mode]}${line ? ' ' + label : ''}">${!label || mode === 'W' ? MODE_ICON[mode] : ''}${label ? `<b>${label}</b>` : ''}</span>`;
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
/** Stern zum Merken einer Linie hinter der Liniennummer (optional, z.B. in der Routenjagd-Auflösung) */
type StarFn = (line: string) => string;

export function routeDetails(route: RouteOption, star?: StarFn): string {
  if (route.steps?.length) return stepsDetails(route, star);
  return `<ol class="leg-detail">${route.legs
    .map((l) => {
      const min = legMinutes(l.dep, l.arr);
      if (l.mode === 'W')
        return `<li class="ld-walk"><span class="ld-time">${esc(l.dep)}</span><span>🚶 ${min ? `${min} min ` : ''}zu Fuß${l.toName && l.toName !== l.fromName ? ` nach ${esc(l.toName)}` : ''}</span></li>`;
      return `<li><span class="ld-time">${esc(l.dep)}</span><span>${lineChip(l.mode, l.line, l.color)}${star && l.line ? star(l.line) : ''} <b>${esc(l.fromName)}</b> → <b>${esc(l.toName)}</b>
        <small>${esc(l.dep)}–${esc(l.arr)} · ${min} min${withText(l.with, 'auch ')}</small></span></li>`;
    })
    .join('')}<li class="ld-end"><span class="ld-time">${esc(route.legs[route.legs.length - 1]?.arr ?? '')}</span><span>🏁 Ankunft</span></li></ol>${waitNote(route)}`;
}

/** „ · mit REX4, REX41“ – Regionalzüge, die auf dem S-Bahn-Abschnitt im Takt mitzählen */
function withText(trains: string[] | undefined, prefix: string): string {
  if (!trains?.length) return '';
  const shown = trains.length > 4 ? [...trains.slice(0, 3), `+${trains.length - 3}`] : trains;
  return ` · <span class="with-trains" title="Der Takt gilt für S-Bahn und diese Regionalzüge zusammen – alle fahren hier gleich">${prefix}${esc(shown.join(', '))}</span>`;
}

/** Erklärt, warum die gewertete Zeit länger ist als die Beispielfahrt (Wartezeit am Start) */
function waitNote(route: RouteOption): string {
  const wait = route.medianMin - route.rideMin;
  if (wait < 2) return '';
  return `<p class="wait-note">⏳ Gewertet: <b>${route.medianMin} min</b> – inkl. Ø ${wait} min Warten auf die erste Abfahrt.</p>`;
}

/** Berechneter Zeitplan (Ø-Wartezeiten): genau die Minuten, die gewertet werden */
function stepsDetails(route: RouteOption, star?: StarFn): string {
  const rows = route.steps!.map((st) => {
    if (st.kind === 'ride')
      return `<li><span class="ld-time">${esc(st.at)}</span><span>${lineChip(st.mode!, st.line!, st.color!)}${star && st.line ? star(st.line) : ''} <b>${esc(st.from!)}</b> → <b>${esc(st.to)}</b> <small>Ø ${st.min} min Fahrt</small></span></li>`;
    if (st.kind === 'wait')
      return `<li class="ld-wait"><span class="ld-time">${esc(st.at)}</span><span>⏳ Ø ${st.min} min warten <small>(fährt etwa alle ${st.every} min${withText(st.with, 'mit ')})</small></span></li>`;
    if (st.kind === 'transfer')
      return `<li class="ld-walk"><span class="ld-time">${esc(st.at)}</span><span>🔀 ${st.min} min umsteigen</span></li>`;
    return `<li class="ld-walk"><span class="ld-time">${esc(st.at)}</span><span>🚶 ${st.min} min zu Fuß nach ${esc(st.to)}</span></li>`;
  });
  const end = route.steps!.length ? route.steps![route.steps!.length - 1] : null;
  const endAt = end ? addMin(end.at, end.min) : '';
  return `<ol class="leg-detail">${rows.join('')}<li class="ld-end"><span class="ld-time">${esc(endAt)}</span><span>🏁 Ankunft – <b>${route.medianMin} min</b></span></li></ol>`;
}

function addMin(hhmm: string, min: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (h * 60 + m + min) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * ⓘ-Fenster: so platzieren, dass sie nie aus dem Bildschirm ragen (fixe Position, an den Rand geklemmt).
 * Einmal global registriert – gilt für alle .info-tip auf jeder Seite.
 */
function placeTip(btn: HTMLElement) {
  const pop = btn.querySelector<HTMLElement>('.tip-pop');
  if (!pop) return;
  const r = btn.getBoundingClientRect();
  const w = Math.min(300, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  const left = Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + 6}px`;
  pop.classList.add('placed');
  // passt es unten nicht mehr hin → über dem ⓘ anzeigen
  requestAnimationFrame(() => {
    const h = pop.offsetHeight;
    if (r.bottom + 6 + h > window.innerHeight - 8) pop.style.top = `${Math.max(8, r.top - h - 6)}px`;
  });
}
/** Beim Scrollen stimmt die fixe Position nicht mehr → zurück auf „direkt unter dem ⓘ“ */
function unplaceTips() {
  for (const pop of document.querySelectorAll<HTMLElement>('.tip-pop.placed')) {
    pop.classList.remove('placed');
    pop.style.left = pop.style.top = pop.style.width = '';
  }
}
// (ohne Browser – z.B. in Tests – gibt es kein document)
if (typeof document !== 'undefined') {
  for (const ev of ['mouseover', 'focusin', 'click'] as const)
    document.addEventListener(ev, (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.info-tip');
      if (btn) placeTip(btn);
    });
  document.addEventListener('scroll', unplaceTips, { capture: true, passive: true });
}

/** Listeneinträge per Klick auf-/zuklappen */
export function makeExpandable(list: HTMLElement) {
  // per Tastatur erreichbar: Tab → Enter/Leertaste klappt auf
  for (const li of list.querySelectorAll<HTMLElement>('li.expandable')) {
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-expanded', String(li.classList.contains('open')));
  }
  const toggle = (li: HTMLElement) => li.setAttribute('aria-expanded', String(li.classList.toggle('open')));
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li.expandable');
    if (li && list.contains(li) && !(e.target as HTMLElement).closest('.rdetail')) toggle(li);
  });
  list.addEventListener('keydown', (e) => {
    const li = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && li.matches('li.expandable')) {
      e.preventDefault();
      toggle(li);
    }
  });
}

export function toast(msg: string, kind: 'error' | 'info' = 'error', action?: { label: string; run: () => void }) {
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status', 'aria-live': kind === 'error' ? 'assertive' : 'polite' }, esc(msg));
  // optionaler Knopf (z.B. „nur S1 merken“) – Meldung bleibt dann etwas länger
  if (action) {
    const b = h('button', { class: 'toast-action' }, esc(action.label));
    b.addEventListener('click', () => {
      action.run();
      el.remove();
    });
    el.append(' ', b);
  }
  document.body.append(el);
  const ms = action ? 6500 : 3800;
  setTimeout(() => el.classList.add('hide'), ms);
  setTimeout(() => el.remove(), ms + 600);
}
