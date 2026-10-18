// Quiz (Mehrspieler): Lobby mit Einstellungen, Frage, Auflösung, Endstand
import type { LatLon, Line, Mode, QuizState } from '../../../shared/types.ts';
import { MODE_ICON, MODE_LABEL, linePatterns } from '../../../shared/rules.ts';
import {
  DEFAULT_QUIZ_SETTINGS,
  FREQUENCY_LABELS,
  QUIZ_QUESTION_COUNTS,
  QUIZ_TIMES,
  QUIZ_TYPES,
  QUIZ_TYPE_ORDER,
  type QuizQuestionPublic,
  type QuizSettings,
} from '../../../shared/quiz.ts';
import { api } from '../api.ts';
import { distM, fmtDist } from '../net.ts';
import { netLayer, netView } from '../netmap.ts';
import { app, endSession, inviteLink, isHost, quizState, savePrefs, serverNow, setMapBig } from '../store.ts';
import { esc, h, lineChip, toast } from '../ui.ts';
import { hostBar } from './host.ts';
import { seg } from './lobby.ts';
import type { Screen } from './screen.ts';

const NEUTRAL = '#3a3f47';

function chip(id: string): string {
  const l = app.net.lines.get(id);
  return l ? lineChip(l.mode, l.id, l.color) : esc(id);
}

function linePaths(l: Line): { paths: [number, number][][]; stops: { id: string; lat: number; lon: number; name: string; terminal: boolean }[] } {
  const reg = linePatterns(l, 'regular');
  const pats = reg.length ? reg : linePatterns(l, 'current');
  const ends = new Set(pats.flatMap((p) => [p[0], p[p.length - 1]]));
  return {
    paths: pats.map((p) => p.map((id) => [app.net.station(id).lat, app.net.station(id).lon] as [number, number])),
    stops: [...new Set(pats.flat())].map((id) => {
      const s = app.net.station(id);
      return { id, lat: s.lat, lon: s.lon, name: s.name, terminal: ends.has(id) };
    }),
  };
}

/** Mehrere Linien auf der Netzkarte hervorheben (mit Nummer) */
function drawLinesColored(ids: string[], fit: boolean) {
  const pts = netLayer().render(netView({ focus: new Set(ids.filter((id) => app.net.lines.has(id))), allLabels: true }));
  if (fit && pts.length) app.map.fitPoints(pts, 15);
}

/** Linie zeichnen: Start- und Endstation */
function sketchEnds(q: QuizQuestionPublic): [LatLon, LatLon] | undefined {
  if (q.type !== 'draw' || q.markers?.length !== 2) return undefined;
  const [a, b] = q.markers.map((id) => app.net.station(id));
  return [
    [a.lat, a.lon],
    [b.lat, b.lon],
  ];
}

/** Linien, die von einer Station abfahren (im Quiz-Netz) */
function linesAt(stationId: string): Line[] {
  return app.net
    .station(stationId)
    .lines.map((id) => app.net.lines.get(id))
    .filter((l): l is Line => !!l && linePaths(l).paths.length > 0);
}

/** Linie auf der Netzkarte: während der Frage allein, neutral und still (verrät nichts) – in der Auflösung
 *  in ihrer Farbe mit Endstationen und Namen */
function drawLine(id: string, reveal: boolean, fit: boolean) {
  const l = app.net.lines.get(id);
  if (!l) return;
  const { stops } = linePaths(l);
  const stations = stops.map((s) => app.net.station(s.id));
  const view = reveal
    ? netView({ focus: new Set([id]), stops: stations, marks: stops.filter((s) => s.terminal).map((s) => app.net.station(s.id)) })
    : netView({ focus: new Set([id]), only: new Set([id]), colors: { [id]: NEUTRAL }, stops: stations, quiet: true });
  const pts = netLayer().render(view);
  if (fit && pts.length) app.map.fitPoints(pts, 15);
}

function areaOf(s: QuizSettings) {
  const d = s.area ? app.net.data.districts.find((x) => x.id === s.area) : null;
  return d ? { rings: d.rings } : null;
}

function playersHtml(st: QuizState): string {
  return st.players
    .map(
      (p) => `<li class="${p.connected ? '' : 'offline'}"><span class="dot"></span>${esc(p.name)}${p.id === app.session?.playerId ? ' <small>(du)</small>' : ''}${p.isHost ? ' <span title="Host">👑</span>' : ''}</li>`,
    )
    .join('');
}

// ---------------------------------------------------------------- Lobby

function freqLabel(v: number): string {
  return v === 1 ? '🚫 Gar nicht' : `${'●'.repeat(v - 1)}<span class="freq-off">${'●'.repeat(7 - v)}</span> ${FREQUENCY_LABELS[v]}`;
}

export function quizLobbyScreen(panel: HTMLElement): Screen {
  app.map.clear();
  let pending = false;
  let advancedOpen = false;
  let lastArea = -1;

  const send = async (patch: Partial<QuizSettings>) => {
    if (pending) return;
    pending = true;
    try {
      const st = (await api.settings(app.session!, patch)) as QuizState;
      app.prefs.quiz = st.settings;
      savePrefs();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      pending = false;
    }
  };

  function render() {
    const st = quizState();
    const s = st.settings;
    const host = isHost();
    const ro = !host;
    if (s.area !== lastArea) {
      lastArea = s.area;
      app.map.clearLearn();
      app.map.showLearnArea(areaOf(s), true, true);
    }
    const scroll = panel.scrollTop;
    const typeRows = QUIZ_TYPE_ORDER.map(
      (t) => `<div class="qtype ${s.weights[t] === 1 ? 'off' : ''}"><div class="qt-label"><b>${QUIZ_TYPES[t].icon} ${QUIZ_TYPES[t].label}</b><small>${QUIZ_TYPES[t].hint}</small></div>
        <label class="freq"><input type="range" min="1" max="7" step="1" value="${s.weights[t]}" data-w="${t}" ${ro ? 'disabled' : ''}>
          <b class="freq-label">${freqLabel(s.weights[t])}</b></label></div>`,
    ).join('');
    const isDefault = QUIZ_TYPE_ORDER.every((t) => s.weights[t] === DEFAULT_QUIZ_SETTINGS.weights[t]);
    const active = QUIZ_TYPE_ORDER.filter((t) => s.weights[t] > 1).map((t) => QUIZ_TYPES[t].icon).join(' ');
    panel.innerHTML = `
      <div class="lobby">
        <div class="lobby-code">
          <div><small>🧠 Quiz · Lobby-Code</small><div class="code">${st.id}</div></div>
          <button class="btn btn-ghost" id="copy">🔗 Link kopieren</button>
        </div>
        <h3>Spieler <small>(${st.players.length})</small></h3>
        <ul class="players">${playersHtml(st)}</ul>
        <h3>Einstellungen ${ro ? '<small>– nur der Host kann sie ändern</small>' : ''}</h3>
        <div class="setting"><span>Fragen</span>${seg('questions', QUIZ_QUESTION_COUNTS.map((n) => ({ value: String(n), label: String(n) })), String(s.questions), ro)}</div>
        <div class="setting"><span>Zeit pro Frage</span>${seg('timeSec', QUIZ_TIMES.map((n) => ({ value: String(n), label: `${n} s` })), String(s.timeSec), ro)}
          <small class="hint">Richtig gibt 500–1000 Punkte – je schneller, desto mehr.</small></div>
        <div class="setting"><span>Gebiet</span>
          <select id="area" ${ro ? 'disabled' : ''}><option value="0">Ganz Wien</option>${app.net.data.districts.map((d) => `<option value="${d.id}" ${d.id === s.area ? 'selected' : ''}>${d.id}. ${esc(d.name)}</option>`).join('')}</select></div>
        <div class="setting"><span>Verkehrsmittel</span><div class="quiz-modes">${(['U', 'S', 'T', 'B', 'N'] as Mode[])
          .map((m) => `<button data-mode="${m}" class="${s.modes.includes(m) ? 'on' : ''}" ${ro ? 'disabled' : ''}>${MODE_ICON[m]} ${MODE_LABEL[m]}</button>`)
          .join('')}</div></div>
        <details class="advanced" ${advancedOpen ? 'open' : ''}>
          <summary>⚙️ Fragetypen & Häufigkeit <small>${active}</small></summary>
          <p class="hint">Regler ganz links = <b>gar nicht</b>, Mitte = normal, ganz rechts = sehr häufig.</p>
          <div class="qtypes">${typeRows}</div>
          ${host ? `<button class="btn btn-ghost" id="resetW" ${isDefault ? 'disabled' : ''}>↺ Standard-Häufigkeiten</button>` : ''}
        </details>
        ${host ? '<button class="link reset-settings" id="resetAll">↺ Alle Einstellungen zurücksetzen</button>' : ''}
        ${
          host
            ? `<button class="btn btn-primary btn-big" id="start">${st.players.length > 1 ? `Quiz starten (${st.players.length} Spieler)` : 'Quiz starten'}</button>`
            : `<div class="waiting-host">Warte, bis ${esc(st.players.find((p) => p.isHost)?.name ?? 'der Host')} startet …</div>`
        }
        <button class="link leave" id="leave">Lobby verlassen</button>
      </div>`;
    panel.scrollTop = scroll;

    panel.querySelector<HTMLDetailsElement>('details.advanced')!.addEventListener('toggle', (e) => {
      advancedOpen = (e.target as HTMLDetailsElement).open;
    });
    panel.querySelector('#copy')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteLink(st.id));
        toast('Einladungslink kopiert', 'info');
      } catch {
        toast(`Code: ${st.id}`, 'info');
      }
    });
    panel.querySelectorAll<HTMLButtonElement>('button[data-k]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.k!;
        const v = Number(b.dataset.v);
        send({ [k]: v } as Partial<QuizSettings>);
      }),
    );
    panel.querySelectorAll<HTMLInputElement>('input[data-w]').forEach((r) => {
      const t = r.dataset.w as keyof QuizSettings['weights'];
      r.addEventListener('input', () => {
        r.nextElementSibling!.innerHTML = freqLabel(Number(r.value));
        r.closest('.qtype')!.classList.toggle('off', r.value === '1');
      });
      r.addEventListener('change', () => send({ weights: { ...s.weights, [t]: Number(r.value) } as QuizSettings['weights'] }));
    });
    panel.querySelector('#resetW')?.addEventListener('click', () => send({ weights: { ...DEFAULT_QUIZ_SETTINGS.weights } }));
    panel.querySelector('#resetAll')?.addEventListener('click', () => {
      if (!confirm('Alle Quiz-Einstellungen auf den Standard zurücksetzen?')) return;
      send(structuredClone(DEFAULT_QUIZ_SETTINGS));
    });
    panel.querySelector<HTMLSelectElement>('#area')!.addEventListener('change', (e) => send({ area: Number((e.target as HTMLSelectElement).value) }));
    panel.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = b.dataset.mode as Mode;
        const modes = s.modes.includes(m) ? s.modes.filter((x) => x !== m) : [...s.modes, m];
        if (modes.length) send({ modes });
      }),
    );
    panel.querySelector('#start')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      try {
        await api.start(app.session!);
      } catch (err) {
        toast((err as Error).message);
        btn.disabled = false;
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
      app.map.showTarget(s.lat, s.lon, q.type === 'nextStop' || q.type === 'stopLines' ? s.name : null);
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
    if (q.type === 'transfer' && q.drawLines?.length) drawLinesColored(q.drawLines, true);
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

// ---------------------------------------------------------------- Endstand

export function quizFinalScreen(panel: HTMLElement): Screen {
  app.map.clear();
  app.map.overview();
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
                .map((p, i) => `<li class="${p.id === myId ? 'is-me' : ''}"><span>${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`}</span><b>${esc(p.name)}</b><span class="pts">${p.score.toLocaleString('de-AT')}</span></li>`)
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

