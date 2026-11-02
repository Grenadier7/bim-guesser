// Testseite für Tages-Challenges (nur lokal: /#challenge-test, Server mit --dev): jede Challenge – nicht nur die
// heutigen – mit einem Klick allein spielen.
import type { GameSettings } from '../../../shared/types.ts';
import { DEFAULT_SETTINGS } from '../../../shared/defaults.ts';
import { api } from '../api.ts';
import { everyChallenge, todaysChallenges } from '../challenges.ts';
import { app, startSession } from '../store.ts';
import { esc, toast } from '../ui.ts';
import type { Screen } from './screen.ts';

/** Standard + Challenge (wie „Spielen“ im Lobby-Banner) */
export function challengeSettings(patch: Partial<GameSettings>, id: string): Partial<GameSettings> {
  // „Wo liegt das?“ aus – Challenges sind kurz (Ortskenner & Co. schalten es selbst ein)
  const base: Partial<GameSettings> = { ...DEFAULT_SETTINGS, focus: null, locate: false };
  if (patch.difficulty) {
    delete base.stations;
    delete base.distance;
    delete base.minTransfers;
  }
  return { ...base, ...patch, challenge: id };
}

export function challengeTestScreen(panel: HTMLElement, onBack: () => void): Screen {
  app.map.clear();
  app.map.overview();
  const today = new Set(todaysChallenges().map((c) => c.id));
  const all = everyChallenge();
  panel.innerHTML = '<div class="learn"><p class="muted">Lade …</p></div>';
  fetch('/api/dev')
    .then((r) => r.json())
    .then((d: { dev?: boolean }) => {
      if (!d.dev) {
        panel.innerHTML = `<div class="learn"><button class="link" id="back">← Zurück</button><p class="err">Die Testseite gibt es nur lokal: <code>npm run dev</code>.</p></div>`;
        panel.querySelector('#back')!.addEventListener('click', onBack);
        return;
      }
      render();
    })
    .catch(() => render());

  function render() {
    const districts = all.filter((c) => c.id.startsWith('district-'));
    const rest = all.filter((c) => !c.id.startsWith('district-'));
    panel.innerHTML = `
      <div class="learn ch-test">
        <button class="link" id="back">← Zurück</button>
        <h2>🧪 Alle Tages-Challenges</h2>
        <p class="muted">Klick → Lobby mit der Challenge (allein) und sofort los. ⭐ = heute im Banner.</p>
        <ul class="ch-list">${rest
          .map(
            (c) => `<li><span class="cb-icon">${c.icon}</span><span class="cb-text"><b>${esc(c.title)}${today.has(c.id) ? ' ⭐' : ''}</b><small>${esc(c.text)}</small>
              <small class="muted">${c.settings.rounds} Runde${c.settings.rounds === 1 ? '' : 'n'} (wählbar ${c.roundOptions.join('/')}) · geschafft ab ${c.done} Routenpunkten</small></span>
              <button class="btn btn-primary" data-play="${c.id}">Spielen</button></li>`,
          )
          .join('')}</ul>
        <h3>🏘️ Bezirk des Tages</h3>
        <div class="ch-districts">${districts.map((c) => `<button class="btn btn-ghost" data-play="${c.id}" title="${esc(c.title)}">${esc(c.id.slice(9))}.${today.has(c.id) ? ' ⭐' : ''}</button>`).join('')}</div>
      </div>`;
    panel.querySelector('#back')!.addEventListener('click', onBack);
    panel.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) =>
      b.addEventListener('click', async () => {
        const c = all.find((x) => x.id === b.dataset.play)!;
        b.disabled = true;
        try {
          const res = await api.create(app.prefs.name || 'Test', 'route', challengeSettings(c.settings, c.id));
          startSession({ code: res.state.id, playerId: res.playerId, token: res.token }, res.state);
          await api.start(app.session!);
        } catch (e) {
          toast((e as Error).message);
          b.disabled = false;
        }
      }),
    );
  }
  return {};
}
