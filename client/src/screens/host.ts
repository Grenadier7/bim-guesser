// Host-Steuerung während des Spiels (Routenjagd und Quiz): Pause, Runde/Frage abbrechen, Spiel beenden
import { api } from '../api.ts';
import { app, isHost, openTimer } from '../store.ts';
import { h, toast } from '../ui.ts';

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
