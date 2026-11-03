// Quiz – Endstand: Punkte (allein mit Balken), Liste der Fragen mit richtig/falsch, „Diese üben“, Revanche
import { XP } from '../../../../shared/career.ts';
import { api } from '../../api.ts';
import { record } from '../../career.ts';
import { app, endSession, quizState } from '../../store.ts';
import { esc, lineChip } from '../../ui.ts';
import type { Screen } from '../screen.ts';
import { markPlayed } from '../../progress.ts';
import { bindEndActions, earlyNote, endActions, podium, soloCard } from '../result.ts';

export function quizFinalScreen(panel: HTMLElement): Screen {
  app.map.clear();
  app.map.overview();
  const st0 = quizState();
  const myId = app.session!.playerId;
  const log = [...app.quizLog.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  const answered = log.filter((e) => e.base != null).length;
  // nur wer etwas beantwortet hat, hat gespielt (alles übersprungen zählt nicht – auch nicht fürs Tutorial-Angebot)
  if (answered) {
    markPlayed();
    const ranking = [...st0.players].sort((a, b) => b.score - a.score);
    const me = ranking.find((p) => p.id === myId);
    const won = ranking.length > 1 && ranking[0]?.id === myId && (me?.score ?? 0) > 0;
    const ace = answered >= 5 && log.every((e) => e.base == null || e.base >= 0.99);
    record(`quiz:${st0.id}:${st0.startedAt}`, { activity: true, xp: XP.quiz(me?.score ?? 0, won), count: { quiz: 1, wins: won ? 1 : 0, quizAce: ace ? 1 : 0 } });
  }

  function render() {
    const st = quizState();
    const max = st.total * 1000;
    const me = st.players.find((p) => p.id === myId);
    const wrong = log.filter((e) => e.base != null && e.base < 0.99);
    const wrongLines = [...new Set(wrong.flatMap((e) => e.lines))].filter((id) => app.net.lines.has(id));
    const solo = st.players.length <= 1;
    panel.innerHTML = `
      <div class="final">
        <h2>🧠 Quiz-Endstand</h2>
        ${earlyNote(st.total, st.settings.questions, 'Frage')}
        ${solo ? soloCard(me?.score ?? 0, max) : podium(st.players, myId)}
        ${
          log.length
            ? `<h3>Deine Fragen</h3><ol class="q-log">${log
                .map(
                  (e) => `<li class="${e.base == null ? 'skip' : e.base >= 0.99 ? 'right' : e.base > 0 ? 'part' : 'wrong'}">
                    <span class="ql-mark">${e.base == null ? '–' : e.base >= 0.99 ? '✓' : e.base > 0 ? '½' : '✗'}</span>
                    <span class="ql-text">${e.icon} ${esc(e.prompt)}${e.base != null && e.base < 0.99 ? `<small>${esc(e.explanation)}</small>` : ''}</span>
                    <b class="ql-pts">+${e.points}</b></li>`,
                )
                .join('')}</ol>`
            : ''
        }
        ${
          wrongLines.length
            ? `<div class="practice-box"><p>Zum Wiederholen gemerkt: ${wrongLines
                .slice(0, 12)
                .map((id) => {
                  const l = app.net.lines.get(id)!;
                  return lineChip(l.mode, l.id, l.color);
                })
                .join(' ')}</p>
                ${solo ? '<button class="btn btn-ghost" id="practice">📚 Diese jetzt üben</button>' : '<small class="muted">Später unter Lernen → Üben → „Fehler wiederholen“.</small>'}</div>`
            : ''
        }
        ${endActions()}
      </div>`;
    bindEndActions(panel);
    panel.querySelector('#practice')?.addEventListener('click', async () => {
      await api.leave(app.session!).catch(() => {});
      app.view = 'learn';
      app.learnStart = 'mistakes';
      endSession();
    });
  }
  render();
  return { update: render };
}
