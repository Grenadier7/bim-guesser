// Quiz – Endstand
import { api } from '../../api.ts';
import { app, endSession, isHost, quizState } from '../../store.ts';
import { accountTag, esc, toast } from '../../ui.ts';
import type { Screen } from '../screen.ts';
import { markPlayed } from '../../progress.ts';

// ---------------------------------------------------------------- Endstand

export function quizFinalScreen(panel: HTMLElement): Screen {
  app.map.clear();
  app.map.overview();
  markPlayed();
  function render() {
    const st = quizState();
    const myId = app.session!.playerId;
    const ranking = [...st.players].sort((a, b) => b.score - a.score);
    const max = st.total * 1000;
    const me = ranking.find((p) => p.id === myId);
    panel.innerHTML = `
      <div class="final">
        <h2>🧠 Quiz-Endstand</h2>
        ${
          ranking.length > 1
            ? `<ol class="podium">${ranking
                .map((p, i) => `<li class="${p.id === myId ? 'is-me' : ''}"><span>${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`}</span><b>${esc(p.name)}${accountTag(p)}</b><span class="pts">${p.score.toLocaleString('de-AT')}</span></li>`)
                .join('')}</ol>`
            : `<h1>${(me?.score ?? 0).toLocaleString('de-AT')} <small>/ ${max.toLocaleString('de-AT')} Punkte</small></h1>`
        }
        ${isHost() ? '<button class="btn btn-primary btn-big" id="again">Zurück zur Lobby</button>' : '<div class="waiting-host">Der Host kann eine neue Runde starten.</div>'}
        <button class="link leave" id="leave">Lobby verlassen</button>
      </div>`;
    panel.querySelector('#again')?.addEventListener('click', () => api.lobby(app.session!).catch((e) => toast(e.message)));
    panel.querySelector('#leave')!.addEventListener('click', async () => {
      await api.leave(app.session!).catch(() => {});
      endSession();
    });
  }
  render();
  return { update: render };
}
