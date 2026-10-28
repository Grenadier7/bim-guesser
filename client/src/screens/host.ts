// Host-Steuerung (Routenjagd und Quiz): Pause, Runde/Frage abbrechen, Spiel beenden, Spieler verwalten
// (zum Host machen, entfernen) – im Spiel als ausklappbare Leiste (am Handy zugeklappt), in der Lobby an der Spielerliste.
import { api } from '../api.ts';
import { app, isHost, openTimer } from '../store.ts';
import { accountTag, esc, h, toast } from '../ui.ts';

async function run(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    toast((e as Error).message);
  }
}

const isQuiz = () => app.state?.mode === 'quiz';

export const hostActions = {
  pause: () => run(() => api.pause(app.session!)),
  resume: () => run(() => api.resume(app.session!)),
  cancel: () => {
    const msg = isQuiz() ? 'Frage überspringen? Die Lösung wird gezeigt, niemand bekommt Punkte.' : 'Runde abbrechen? Die Lösung wird gezeigt, niemand bekommt Punkte.';
    if (confirm(msg)) void run(() => api.cancel(app.session!));
  },
  end: () => {
    if (confirm('Spiel beenden und alle zurück in die Lobby schicken?')) void run(() => api.lobby(app.session!));
  },
};

/** 👑 (Host geben/nehmen) und ✕ (entfernen) neben einem Mitspieler – nur für Hosts, nicht bei sich selbst */
export function playerActions(p: { id: string; name: string; isHost: boolean }): string {
  if (!isHost() || p.id === app.session?.playerId) return '';
  return `<button class="crown ${p.isHost ? 'on' : ''}" data-host="${esc(p.id)}" data-on="${p.isHost ? '0' : '1'}" data-name="${esc(p.name)}"
      title="${p.isHost ? `${esc(p.name)} die Host-Rechte nehmen` : `${esc(p.name)} zum Host machen`}" aria-label="${p.isHost ? 'Host-Rechte nehmen' : 'Zum Host machen'}: ${esc(p.name)}">👑</button><button class="kick" data-kick="${esc(p.id)}" data-name="${esc(p.name)}" title="${esc(p.name)} aus der Lobby entfernen" aria-label="${esc(p.name)} entfernen">✕</button>`;
}
/** alter Name – Spielerlisten in den Lobbys */
export const kickButton = playerActions;

/** Klicks auf 👑 und ✕ in einer Spielerliste */
export function bindKick(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-kick]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm(`${b.dataset.name} aus der Lobby entfernen?`)) return;
      b.disabled = true;
      void run(() => api.kick(app.session!, b.dataset.kick!));
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-host]').forEach((b) =>
    b.addEventListener('click', () => {
      b.disabled = true;
      void run(() => api.setHost(app.session!, b.dataset.host!, b.dataset.on === '1'));
    }),
  );
}

/** offen/zu merken – die Leiste wird bei jedem Live-Update neu gebaut */
let barOpen: boolean | null = null;
let playersOpen = false;

/** Ausklappbare Host-Leiste (leer für Nicht-Hosts); am Handy zugeklappt, damit sie nicht den Platz frisst */
export function hostBar(): HTMLElement {
  if (!isHost()) return h('div', { class: 'host-bar' });
  const el = h('details', { class: 'host-bar' }) as HTMLDetailsElement;
  barOpen ??= matchMedia('(min-width: 900px)').matches;
  el.open = barOpen;
  el.addEventListener('toggle', () => (barOpen = el.open));
  fill(el);
  return el;
}

function fill(el: HTMLElement) {
  const t = openTimer();
  const others = (app.state?.players ?? []).filter((p) => p.id !== app.session?.playerId);
  el.innerHTML = `<summary class="host-label">👑 Host${t?.pausedAt ? ' <small>(pausiert)</small>' : ''}</summary>
    <div class="hb-actions">
      ${t ? (t.pausedAt ? '<button class="hb-resume" data-a="resume">▶ Fortsetzen</button>' : '<button class="hb-pause" data-a="pause">⏸ Pause</button>') : ''}
      ${t ? `<button class="hb-cancel" data-a="cancel">✖ ${isQuiz() ? 'Frage überspringen' : 'Runde abbrechen'}</button>` : ''}
      <button class="hb-end" data-a="end">⏹ Spiel beenden</button>
      ${others.length ? `<button class="hb-players" data-a="players" aria-expanded="${playersOpen}">👥 Spieler (${others.length})</button>` : ''}
    </div>
    ${
      playersOpen && others.length
        ? `<ul class="hb-list">${others
            .map((p) => `<li class="${p.connected ? '' : 'offline'}"><span>${esc(p.name)}${accountTag(p)}${p.isHost ? ' 👑' : ''}</span>${playerActions(p)}</li>`)
            .join('')}</ul>`
        : ''
    }`;
  el.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.a === 'players') {
        playersOpen = !playersOpen;
        return fill(el);
      }
      void hostActions[b.dataset.a as keyof typeof hostActions]();
    }),
  );
  bindKick(el);
}
