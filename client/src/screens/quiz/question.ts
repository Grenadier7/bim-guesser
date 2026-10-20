// Quiz – Frage: antworten (Auswahl, Mehrfachauswahl, Karte tippen, Linie zeichnen)
import type { LatLon } from '../../../../shared/types.ts';
import { QUIZ_TYPES, type QuizQuestionPublic } from '../../../../shared/quiz.ts';
import { api } from '../../api.ts';
import { distM } from '../../net.ts';
import { app, isHost, quizState, serverNow, setMapBig } from '../../store.ts';
import { esc, h, toast } from '../../ui.ts';
import { hostBar } from '../host.ts';
import type { Screen } from '../screen.ts';
import { chip, sketchEnds, drawLine, areaOf } from './common.ts';

// ---------------------------------------------------------------- Frage

export function quizQuestionScreen(panel: HTMLElement): Screen {
  const st0 = quizState();
  const q = st0.question!;
  const index = st0.current;
  const myId = app.session!.playerId;
  let guess: LatLon | null = null;
  const sketch: LatLon[] = [];
  const picked = new Set<string>();
  let sent = st0.answered.includes(myId);

  // Karte vorbereiten
  app.map.clear();
  setMapBig((q.type === 'locate' || q.type === 'draw') && !sent);
  setupMap(q);

  function setupMap(q: QuizQuestionPublic) {
    const area = areaOf(st0.settings);
    app.map.showLearnArea(area, q.type === 'locate' || (!q.stationId && !q.drawLineId && !q.markers));
    if (q.drawLineId) drawLine(q.drawLineId, false, !q.stationId);
    if (q.stationId) {
      const s = app.net.station(q.stationId);
      app.map.showTarget(s.lat, s.lon, q.type === 'nextStop' || q.type === 'stopLines' || q.type === 'towards' ? s.name : null);
      if (!q.drawLineId) app.map.zoomTo(s.lat, s.lon, 14);
    }
    if (q.markers) {
      for (const id of q.markers) {
        const s = app.net.station(id);
        app.map.showTarget(s.lat, s.lon, s.name);
      }
      const [a, b] = q.markers.map((id) => app.net.station(id));
      if (q.type === 'draw') app.map.fitPoints([[a.lat, a.lon], [b.lat, b.lon]]);
      else app.map.zoomTo((a.lat + b.lat) / 2, (a.lon + b.lon) / 2, distM(a, b) > 6000 ? 12 : 13);
    }
    if (q.type === 'draw' && !sent)
      app.map.onTap((ll) => {
        if (sketch.length >= 80) return;
        sketch.push(ll);
        app.map.showSketch(sketch, sketchEnds(q));
        render();
      });
    if (q.type === 'locate' && !sent)
      app.map.onTap((ll) => {
        guess = ll;
        app.map.clearLearn();
        app.map.showTarget(ll[0], ll[1], 'dein Tipp');
        render();
      });
  }

  async function submit(answer: string | string[] | LatLon | LatLon[]) {
    if (sent) return;
    sent = true;
    app.map.onTap(null);
    setMapBig(false);
    render();
    try {
      await api.quizAnswer(app.session!, index, answer);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  function render() {
    const st = quizState();
    panel.innerHTML = '';
    panel.append(hostBar());
    const box = h(
      'div',
      { class: 'quiz-q' },
      `<small class="ex-label">${QUIZ_TYPES[q.type].icon} ${QUIZ_TYPES[q.type].label} · Frage ${index + 1}/${st.total}</small>
       <h2>${esc(q.prompt)}</h2>
       ${q.chips?.length ? `<div class="chips">${q.chips.map(chip).join('')}</div>` : ''}`,
    );
    panel.append(box);

    if (sent) {
      const waiting = st.players.filter((p) => !st.answered.includes(p.id) && p.connected);
      box.insertAdjacentHTML(
        'beforeend',
        `<div class="waiting"><div class="big-check">✓</div><h3>Antwort abgegeben</h3>
         ${waiting.length ? `<p>Warte auf ${waiting.map((p) => `<b>${esc(p.name)}</b>`).join(', ')} …</p>` : '<p>Auflösung kommt …</p>'}
         ${isHost() && waiting.length ? '<button class="btn btn-ghost" id="force">Jetzt auflösen</button>' : ''}</div>`,
      );
      box.querySelector('#force')?.addEventListener('click', () => api.quizReveal(app.session!).catch((e) => toast(e.message)));
    } else if (q.type === 'draw') {
      box.insertAdjacentHTML(
        'beforeend',
        `<p class="muted">👆 Tippe auf der Karte den Verlauf der Linie nach – vom einen Ende zum anderen, Punkt für Punkt.</p>`,
      );
      const row = h('div', { class: 'sketch-row' });
      const undo = h('button', { class: 'btn btn-ghost' }, '↶ Rückgängig');
      undo.toggleAttribute('disabled', !sketch.length);
      undo.addEventListener('click', () => {
        sketch.pop();
        app.map.showSketch(sketch, sketchEnds(q));
        render();
      });
      const btn = h('button', { class: 'btn btn-primary' }, sketch.length ? `Abgeben (${sketch.length} Punkte)` : 'Erst Punkte setzen');
      btn.toggleAttribute('disabled', !sketch.length);
      btn.addEventListener('click', () => sketch.length && submit([...sketch]));
      row.append(undo, btn);
      box.append(row);
    } else if (q.type === 'locate') {
      box.insertAdjacentHTML('beforeend', `<p class="muted">👆 Tippe auf die Karte, wo die Station liegt.</p>`);
      const btn = h('button', { class: 'btn btn-primary btn-big' }, guess ? 'Antworten' : 'Erst auf die Karte tippen');
      btn.toggleAttribute('disabled', !guess);
      btn.addEventListener('click', () => guess && submit(guess));
      box.append(btn);
    } else if (q.multi) {
      const grid = h('div', { class: 'pick-lines' });
      grid.innerHTML = (q.options ?? []).map((o) => `<button data-o="${esc(o.id)}" class="${picked.has(o.id) ? 'on' : ''}">${o.lineId ? chip(o.lineId) : esc(o.label)}</button>`).join('');
      grid.querySelectorAll<HTMLButtonElement>('[data-o]').forEach((b) =>
        b.addEventListener('click', () => {
          const id = b.dataset.o!;
          picked.has(id) ? picked.delete(id) : picked.add(id);
          b.classList.toggle('on');
        }),
      );
      const btn = h('button', { class: 'btn btn-primary btn-big' }, 'Antworten');
      btn.addEventListener('click', () => submit([...picked]));
      box.append(h('p', { class: 'muted' }, 'Alle richtigen auswählen – falsche ziehen Punkte ab.'), grid, btn);
    } else {
      const opts = h('div', { class: `quiz-options ${(q.options ?? []).some((o) => !o.lineId) ? 'quiz-text' : ''}` });
      opts.innerHTML = (q.options ?? []).map((o) => `<button data-o="${esc(o.id)}">${o.lineId ? chip(o.lineId) : esc(o.label)}</button>`).join('');
      opts.querySelectorAll<HTMLButtonElement>('[data-o]').forEach((b) => b.addEventListener('click', () => submit(b.dataset.o!)));
      box.append(opts);
    }
    // Wer hat schon geantwortet?
    if (st.players.length > 1)
      box.insertAdjacentHTML(
        'beforeend',
        `<div class="player-strip">${st.players.map((p) => `<span class="pchip ${st.answered.includes(p.id) ? 'done' : ''}">${st.answered.includes(p.id) ? '✓' : '…'} ${esc(p.name)}</span>`).join('')}</div>`,
      );
  }

  render();
  return {
    update() {
      const st = quizState();
      if (st.answered.includes(myId)) sent = true;
      render();
    },
    tick() {
      const st = quizState();
      if (sent || !st.deadline || st.pausedAt) return;
      if (serverNow() >= st.deadline) {
        // Zeit um: was schon da ist, wird abgegeben
        if (q.type === 'locate' && guess) void submit(guess);
        else if (q.type === 'draw' && sketch.length) void submit([...sketch]);
        else if (q.multi && picked.size) void submit([...picked]);
        else {
          sent = true;
          render();
        }
      }
    },
    destroy() {
      app.map.onTap(null);
      setMapBig(false);
    },
  };
}
