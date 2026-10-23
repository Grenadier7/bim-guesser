// Host-Steuerung während des Spiels (Routenjagd und Quiz): Pause, Runde/Frage abbrechen, Spiel beenden
import { api } from '../api.ts';
import { app, isHost, openTimer } from '../store.ts';
import { esc, h, toast } from '../ui.ts';

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

/** ✕ neben einem Mitspieler (nur für den Host, nicht bei sich selbst) */
export function kickButton(p: { id: string; name: string }): string {
  if (!isHost() || p.id === app.session?.playerId) return '';
  return `<button class="kick" data-kick="${esc(p.id)}" data-name="${esc(p.name)}" title="${esc(p.name)} aus der Lobby entfernen" aria-label="${esc(p.name)} entfernen">✕</button>`;
}

/** Klicks auf ✕ in einer Spielerliste */
export function bindKick(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-kick]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm(`${b.dataset.name} aus der Lobby entfernen?`)) return;
      b.disabled = true;
      void run(() => api.kick(app.session!, b.dataset.kick!));
    }),
  );
}

/** Leiste mit Host-Knöpfen (leer für Nicht-Hosts) */
export function hostBar(): HTMLElement {
  const el = h('div', { class: 'host-bar' });
  if (!isHost()) return el;
  const t = openTimer();
  el.innerHTML = `<span class="host-label">👑 Host-Steuerung</span>
    ${t ? (t.pausedAt ? '<button class="hb-resume" data-a="resume">▶ Fortsetzen</button>' : '<button class="hb-pause" data-a="pause">⏸ Pause</button>') : ''}
    ${t ? `<button class="hb-cancel" data-a="cancel">✖ ${isQuiz() ? 'Frage überspringen' : 'Runde abbrechen'}</button>` : ''}
    <button class="hb-end" data-a="end">⏹ Spiel beenden</button>`;
  el.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) =>
    b.addEventListener('click', () => hostActions[b.dataset.a as keyof typeof hostActions]()),
  );
  return el;
}
