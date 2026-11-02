import type { RoundReveal } from '../../../shared/types.ts';
import { fmtTimeLeft, maxRoundPoints } from '../../../shared/rules.ts';
import { app, routeState, getReveal } from '../store.ts';
import { esc } from '../ui.ts';
import { XP } from '../../../shared/career.ts';
import { record } from '../career.ts';
import { bindEndActions, earlyNote, endActions, levelSuggestion, podium, soloCard } from './result.ts';
import type { Screen } from './screen.ts';
import { markPlayed } from '../progress.ts';

export function finalScreen(panel: HTMLElement): Screen {
  app.map.clear();
  app.map.overview();
  markPlayed();
  {
    // Fortschritt: einmal je Spiel (Endstand kann nach Neuladen wieder erscheinen)
    const s = routeState();
    const myId = app.session!.playerId;
    const ranking = [...s.players].sort((a, b) => b.score - a.score);
    const won = ranking.length > 1 && ranking[0]?.id === myId && ranking[0].score > 0;
    record(`game:${s.id}:${s.rounds.map((r) => `${r.from?.id}-${r.to?.id}`).join()}`, { activity: true, xp: XP.game(won), count: { games: 1, wins: won ? 1 : 0 } });
  }
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
    const max = Math.max(1, s.rounds.length) * maxRoundPoints(s.settings);
    const ranking = [...s.players].sort((a, b) => b.score - a.score);
    const me = ranking.find((p) => p.id === myId);
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

    const pct = me ? Math.round((me.score / max) * 100) : 0;
    panel.innerHTML = `
      <div class="final">
        <h2>🏁 Endstand</h2>
        ${earlyNote(s.rounds.length, s.settings.rounds, 'Runde')}
        ${multi ? podium(s.players, myId) : soloCard(me?.score ?? 0, max)}
        <h3>Deine Runden</h3>
        <table><thead><tr><th>#</th><th>Strecke</th><th>Du / Beste</th><th title="Zeit übrig / Zeitlimit">⏱ übrig</th><th>Pkt.</th></tr></thead><tbody>${rows}</tbody></table>
        ${endActions({ suggestion: multi ? null : levelSuggestion(pct, s.settings.difficulty) })}
      </div>`;
    bindEndActions(panel);
  }

  render();
  return { update: render };
}
