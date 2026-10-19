// Quiz – Auflösung einer Frage: Lösung, Punkte, Antworten aller
import type { LatLon } from '../../../../shared/types.ts';
import { QUIZ_TYPES, type QuizQuestionPublic } from '../../../../shared/quiz.ts';
import { api } from '../../api.ts';
import { distM, fmtDist } from '../../net.ts';
import { app, isHost, quizState } from '../../store.ts';
import { esc, h, lineChip, toast } from '../../ui.ts';
import { hostBar } from '../host.ts';
import type { Screen } from '../screen.ts';
import { chip, drawLinesColored, sketchEnds, linesAt, drawLine, areaOf } from './common.ts';

// ---------------------------------------------------------------- Auflösung

function answerText(q: QuizQuestionPublic, a: unknown, correct: unknown): string {
  if (a == null) return '<small>keine Antwort</small>';
  if (q.type === 'draw') return Array.isArray(a) && a.length ? `✏️ ${a.length} Punkte` : '<small>nichts gezeichnet</small>';
  if (q.type === 'locate' && Array.isArray(a) && Array.isArray(correct)) {
    return `${fmtDist(distM({ lat: Number(a[0]), lon: Number(a[1]) }, { lat: Number(correct[0]), lon: Number(correct[1]) }))} daneben`;
  }
  if (Array.isArray(a)) return a.length ? a.map((id) => chip(String(id))).join(' ') : '<small>nichts gewählt</small>';
  const o = q.options?.find((x) => x.id === a);
  return o ? (o.lineId ? chip(o.lineId) : esc(o.label)) : esc(String(a));
}

export function quizRevealScreen(panel: HTMLElement): Screen {
  const st0 = quizState();
  const q = st0.question!;
  const myId = app.session!.playerId;

  function drawMap() {
    const r = quizState().reveal;
    if (!r) return;
    app.map.clear();
    app.map.showLearnArea(areaOf(st0.settings), false);
    if (q.drawLines?.length) drawLinesColored(q.drawLines, true);
    else if (q.type === 'district' && r.revealStationId) drawLinesColored(linesAt(r.revealStationId).map((l) => l.id), true);
    else if (r.revealLineId) drawLine(r.revealLineId, true, true);
    if (q.type === 'draw') {
      const mine = r.results.find((x) => x.playerId === myId);
      if (Array.isArray(mine?.answer) && mine.answer.length) app.map.showSketch(mine.answer as LatLon[], sketchEnds(q));
    }
    // bei "Linie zeichnen" beschriftet die Linie ihre Endstationen schon selbst
    if (q.markers && q.type !== 'draw')
      for (const id of q.markers) {
        const s = app.net.station(id);
        app.map.showTarget(s.lat, s.lon, s.name);
      }
    if (q.type === 'locate' && r.revealStationId) {
      const s = app.net.station(r.revealStationId);
      const guesses = r.results
        .filter((x) => Array.isArray(x.answer))
        .map((x) => ({ name: x.playerId === myId ? 'Du' : x.playerName, ll: x.answer as LatLon, me: x.playerId === myId }));
      app.map.showPlayerGuesses(guesses, s);
    } else if (r.revealStationId) {
      const s = app.net.station(r.revealStationId);
      app.map.showTarget(s.lat, s.lon, s.name);
      if (!r.revealLineId && q.type !== 'district') app.map.zoomTo(s.lat, s.lon, 14);
    } else if (q.stationId) {
      const s = app.net.station(q.stationId);
      app.map.showTarget(s.lat, s.lon, s.name);
      app.map.zoomTo(s.lat, s.lon, 15);
    }
  }

  function render() {
    const st = quizState();
    const r = st.reveal;
    if (!r) return;
    const mine = r.results.find((x) => x.playerId === myId);
    const correct = r.correct;
    let answerBlock = '';
    if (q.options && !q.multi) {
      answerBlock = `<div class="quiz-options ${q.options.some((o) => !o.lineId) ? 'quiz-text' : ''}">${q.options
        .map((o) => {
          const cls = o.id === correct ? 'right' : o.id === mine?.answer ? 'wrong' : 'dim';
          return `<button class="${cls}" disabled>${o.lineId ? chip(o.lineId) : esc(o.label)}</button>`;
        })
        .join('')}</div>`;
    } else if (q.multi && Array.isArray(correct)) {
      const myPick = new Set(Array.isArray(mine?.answer) ? (mine!.answer as string[]) : []);
      answerBlock = `<div class="pick-lines">${(q.options ?? [])
        .map((o) => {
          const ok = (correct as string[]).includes(o.id);
          const cls = ok && myPick.has(o.id) ? 'right' : ok ? 'missed' : myPick.has(o.id) ? 'wrong' : 'dim';
          return `<button class="${cls}" disabled>${o.lineId ? chip(o.lineId) : esc(o.label)}</button>`;
        })
        .join('')}</div>`;
    }
    panel.innerHTML = '';
    panel.append(hostBar());
    const multi = st.players.length > 1;
    const body = h(
      'div',
      { class: 'quiz-q' },
      `<small class="ex-label">${QUIZ_TYPES[q.type].icon} ${QUIZ_TYPES[q.type].label} · Frage ${st.current + 1}/${st.total}</small>
       ${r.cancelled ? '<div class="cancelled">✖ Frage übersprungen – keine Punkte.</div>' : ''}
       <h2>${esc(q.prompt)}</h2>
       ${mine && !r.cancelled ? `<div class="result-card ${mine.base >= 0.99 ? 'great' : mine.base > 0 ? 'ok' : 'meh'}"><div class="points">+${mine.points}<small>${Math.round(mine.base * 100)} % richtig</small></div>
          <div class="mine">${q.type === 'locate' ? `Dein Tipp: ${answerText(q, mine.answer, correct)}` : mine.answer == null ? 'Keine Antwort' : mine.base >= 0.99 ? 'Richtig! 🎉' : mine.base > 0 ? 'Teilweise richtig' : 'Leider falsch'}
          ${mine.elapsedSec != null ? `<small> · ⏱ ${mine.elapsedSec.toLocaleString('de-AT')} s</small>` : ''}</div></div>` : ''}
       ${answerBlock}
       <p class="sentence">${esc(r.explanation)}</p>
       ${
         q.type === 'district' && r.revealStationId
           ? `<div class="deps-inline"><small>Von hier fahren:</small><div class="chips">${linesAt(r.revealStationId)
               .map((l) => lineChip(l.mode, l.id, l.color))
               .join('')}</div></div>`
           : ''
       }
       ${q.type === 'draw' ? '<p class="muted">Gestrichelt: deine Zeichnung · farbig: der echte Verlauf.</p>' : ''}
       ${
         multi
           ? `<h3>Diese Frage</h3><ol class="ranking-q">${r.results
               .map((x) => `<li class="${x.playerId === myId ? 'is-me' : ''}"><span class="pname">${esc(x.playerName)}</span><span class="pans">${answerText(q, x.answer, correct)}</span><b>+${x.points}</b></li>`)
               .join('')}</ol>
              <h3>Gesamt</h3><ol class="podium small">${[...st.players]
                .sort((a, b) => b.score - a.score)
                .map((p, i) => `<li class="${p.id === myId ? 'is-me' : ''}"><span>${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`}</span><b>${esc(p.name)}</b><span class="pts">${p.score.toLocaleString('de-AT')}</span></li>`)
                .join('')}</ol>`
           : ''
       }`,
    );
    panel.append(body);
    const last = st.current + 1 >= st.total;
    if (isHost()) {
      const btn = h('button', { class: 'btn btn-primary btn-big' }, last ? 'Zum Endergebnis' : 'Nächste Frage →');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api.next(app.session!);
        } catch (e) {
          toast((e as Error).message);
          btn.disabled = false;
        }
      });
      panel.append(btn);
      queueMicrotask(() => btn.focus());
    } else panel.append(h('div', { class: 'waiting-host' }, 'Warte auf den Host …'));
  }

  drawMap();
  render();
  let wasHost = isHost();
  return {
    update() {
      if (isHost() !== wasHost) {
        wasHost = isHost();
        render();
      }
    },
  };
}
