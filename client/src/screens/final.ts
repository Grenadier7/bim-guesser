import type { RoundReveal } from '../../../shared/types.ts';
import { fmtTimeLeft, maxRoundPoints } from '../../../shared/rules.ts';
import { api } from '../api.ts';
import { app, routeState, endSession, getReveal, isHost } from '../store.ts';
import { accountTag, esc, toast } from '../ui.ts';
import type { Screen } from './screen.ts';
import { markPlayed } from '../progress.ts';

export function finalScreen(panel: HTMLElement): Screen {
  app.map.clear();
  app.map.overview();
  markPlayed();
  let reveals: RoundReveal[] = [];

  Promise.all(routeState().rounds.map((r) => getReveal(r.index).catch(() => null)))
    .then((rs) => {
      reveals = rs.filter(Boolean) as RoundReveal[];
      render();
    })
    .catch(() => {});

  function render() {
    const s = routeState();
    const myId = app.session!.playerId;
    const max = s.settings.rounds * maxRoundPoints(s.settings);
    const ranking = [...s.players].sort((a, b) => b.score - a.score);
    const me = ranking.find((p) => p.id === myId);
    const medals = ['🥇', '🥈', '🥉'];
    const multi = ranking.length > 1;

    const rows = reveals
      .map((rv) => {
        const r = s.rounds[rv.index];
        const ev = rv.evaluations.find((e) => e.playerId === myId);
        return `<tr><td>${rv.index + 1}</td><td>${esc(r.from?.name ?? '')} → ${esc(r.to?.name ?? '')}</td>
          <td>${rv.cancelled ? '<small>abgebrochen</small>' : `${ev?.durationMin ?? '–'} / ${rv.routes[0]?.medianMin ?? '–'} min`}</td>
          <td>${ev?.elapsedSec != null ? fmtTimeLeft(ev.elapsedSec, r.limitSec).replace(' übrig', '') : '–'}</td><td><b>${ev?.score.total ?? 0}</b></td></tr>`;
      })
      .join('');

    const pct = me ? me.score / max : 0;
    panel.innerHTML = `
      <div class="final">
        ${
          multi
            ? `<h2>Endstand</h2><ol class="podium">${ranking
                .map(
                  (p, i) =>
                    `<li class="${p.id === myId ? 'is-me' : ''}"><span>${medals[i] ?? `${i + 1}.`}</span><b>${esc(p.name)}${accountTag(p)}</b><span class="pts">${p.score.toLocaleString('de-AT')}</span></li>`,
                )
                .join('')}</ol>`
            : `<h1>${(me?.score ?? 0).toLocaleString('de-AT')} <small>/ ${max.toLocaleString('de-AT')} Punkte</small></h1>
               <p>${pct >= 0.75 ? 'Öffi-Profi! 🏆' : pct >= 0.5 ? 'Solide – du kennst dich aus.' : 'Da geht noch was – nächstes Mal vielleicht öfter die U-Bahn? 😉'}</p>`
        }
        <h3>Deine Runden</h3>
        <table><thead><tr><th>#</th><th>Strecke</th><th>Du / Beste</th><th title="Zeit übrig / Zeitlimit">⏱ übrig</th><th>Pkt.</th></tr></thead><tbody>${rows}</tbody></table>
        ${isHost() ? '<button class="btn btn-primary btn-big" id="again">Zurück zur Lobby</button>' : '<div class="waiting-host">Der Host kann eine neue Runde in derselben Lobby starten.</div>'}
        <button class="link leave" id="leave">Lobby verlassen</button>
      </div>`;
    panel.querySelector('#again')?.addEventListener('click', async () => {
      try {
        await api.lobby(app.session!);
      } catch (e) {
        toast((e as Error).message);
      }
    });
    panel.querySelector('#leave')!.addEventListener('click', async () => {
      await api.leave(app.session!).catch(() => {});
      endSession();
    });
  }

  render();
  return { update: render };
}
