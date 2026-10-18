// Lernmodus – Üben: Linie für Linie (Steckbrief ansehen → nachzeichnen → vergleichen) auf meinen Linien
import type { LatLon, Line } from '../../../shared/types.ts';
import { netLayer, netView } from '../netmap.ts';
import { app, setMapBig } from '../store.ts';
import { esc, h, lineChip } from '../ui.ts';
import {
  DAY_SCOPE,
  boxOf,
  departuresFrom,
  evaluateSketch,
  lineProfile,
  patternsOf,
  setBox,
  type LineProfile,
  type SketchResult,
} from './model.ts';
import type { Scope } from './model.ts';

export interface LearnCtx {
  panel: HTMLElement;
  scope: () => Scope;
  back: () => void;
}

type Phase = 'study' | 'draw' | 'review';

const LEARNED = 2;
const lineKey = (l: Line) => `line:${l.id}`;

export function studyView(ctx: LearnCtx) {
  const net = app.net;
  const seen = new Set<string>();
  let card: { line: Line; phase: Phase; taps: LatLon[]; result: SketchResult | null } | null = null;
  /** beim Ansehen angetippte Stationen – erscheinen zusätzlich im Panel, bis man weitergeht oder auf die Karte tippt */
  let peek: string[] = [];

  // -------------------------------------------------------------- Karte

  /** Linie auf der Netzkarte: markante Punkte beschriftet, alle Haltestellen (Name beim Drüberfahren, antippbar) */
  function drawProfile(prof: LineProfile, fit: boolean, onStation?: (id: string) => void) {
    const stops = [...new Set(patternsOf(prof.line).flat())].map((id) => net.station(id));
    const pts = netLayer().render(
      netView({ focus: new Set([prof.line.id]), marks: prof.waypoints.map((id) => net.station(id)), stops, onStation }),
    );
    if (fit && pts.length) app.map.fitPoints(pts, 14);
  }

  function addPeek(id: string) {
    if (!peek.includes(id)) peek = [...peek, id];
    render();
  }

  /** angetippte Stationen: wohin man von dort kommt */
  function peekHtml(): string {
    return peek
      .map((id) => {
        const st = net.station(id);
        const deps = departuresFrom(st, DAY_SCOPE());
        return `<div class="learn-card peek-card"><b>📍 ${esc(st.name)}</b>
          <ul class="deps">${deps
            .map((d) => `<li>${lineChip(d.line.mode, d.line.id, d.line.color)}<span>${d.dirs.map((x) => `→ ${esc(x.to)}`).join('<br>')}</span></li>`)
            .join('')}</ul></div>`;
      })
      .join('');
  }

  /** Beim Nachzeichnen: leise U-/S-Bahn zur Orientierung – aber nie die gesuchte Linie (und bei S-Bahnen keine
   *  anderen S-Bahnen, die oft dieselben Gleise fahren) */
  function drawOrientation(line: Line) {
    const ids = net.data.lines
      .filter((l) => l.id !== line.id && (l.mode === 'U' || (l.mode === 'S' && line.mode !== 'S')) && patternsOf(l).length)
      .map((l) => l.id);
    netLayer().render(netView({ only: new Set(ids), context: new Set(ids), hubs: false, labels: false }));
  }

  // -------------------------------------------------------------- Bausteine

  function profileHtml(prof: LineProfile): string {
    const transfers = prof.transfers
      .map((t) => `<span class="transfer">${t.lines.map((l) => lineChip(l.mode, l.id, l.color)).join('')} <small>${esc(t.station.name)}</small></span>`)
      .join('');
    return `
      <div class="learn-line">${lineChip(prof.line.mode, prof.line.id, prof.line.color)}<span>${prof.stopCount} Stationen</span></div>
      <p class="sentence">${esc(prof.sentence)}</p>
      ${prof.districts.length ? `<p><b>Bezirke:</b> ${prof.districts.map((d) => `${d.id}. ${esc(d.name)}`).join(' → ')}</p>` : ''}
      ${transfers ? `<p><b>Umstieg zu U-/S-Bahn:</b></p><div class="transfers">${transfers}</div>` : ''}
      ${stopListHtml(prof)}`;
  }

  /** der exakte Verlauf: alle Stationen der Reihe nach (markante Punkte fett), antippbar */
  function stopListHtml(prof: LineProfile): string {
    const marks = new Set(prof.waypoints);
    const seen = new Set<string>();
    const stops = prof.main.filter((id) => !seen.has(net.station(id).name) && seen.add(net.station(id).name));
    return `<details class="all-stops"><summary>Exakter Verlauf: alle ${stops.length} Stationen</summary><ol class="stop-list">${stops
      .map((id) => `<li class="${marks.has(id) ? 'in' : ''}" data-peek="${id}">${esc(net.station(id).name)}</li>`)
      .join('')}</ol></details>`;
  }

  function header(): HTMLElement {
    const scope = ctx.scope();
    const learned = scope.lines.filter((l) => boxOf(lineKey(l)) >= LEARNED).length;
    const el = h(
      'div',
      { class: 'learn-head' },
      `<button class="link" id="setup">← Lernen</button>
       <h2>🏋 Üben</h2>
       <div class="learn-progress"><div class="bar"><i style="width:${scope.lines.length ? Math.round((learned / scope.lines.length) * 100) : 0}%"></i></div>
         <small>${learned} von ${scope.lines.length} Linien gelernt</small></div>`,
    );
    el.querySelector('#setup')!.addEventListener('click', () => {
      setMapBig(false);
      ctx.back();
    });
    return el;
  }

  // -------------------------------------------------------------- Linie für Linie

  /** Nächste Linie: zuerst Unbekanntes, keine Wiederholung in dieser Sitzung */
  function nextLine(): Line | null {
    const order = ['U', 'S', 'T', 'B', 'N'];
    const lines = ctx.scope().lines.filter((l) => !seen.has(l.id));
    lines.sort((a, b) => boxOf(lineKey(a)) - boxOf(lineKey(b)) || order.indexOf(a.mode) - order.indexOf(b.mode));
    return lines[0] ?? null;
  }

  function openCard(line: Line | null, phase: Phase = 'study') {
    if (!line) {
      card = null;
      start();
      return;
    }
    card = { line, phase, taps: [], result: null };
    peek = [];
    showPhase();
  }

  function endpoints(prof: LineProfile): [LatLon, LatLon] {
    const a = net.station(prof.main[0]);
    const b = net.station(prof.main[prof.main.length - 1]);
    return [
      [a.lat, a.lon],
      [b.lat, b.lon],
    ];
  }

  function showPhase() {
    const c = card!;
    const prof = lineProfile(c.line);
    app.map.clearLearn();
    app.map.clearEndpoints();
    app.map.onTap(null);
    peek = [];
    setMapBig(c.phase === 'draw');
    if (c.phase === 'study') {
      drawProfile(prof, true, addPeek);
      // Tipp daneben auf die Karte: angetippte Stationen wieder weg
      app.map.onTap(() => {
        if (!peek.length) return;
        peek = [];
        render();
      });
    } else {
      const [a, b] = endpoints(prof);
      const sa = net.station(prof.main[0]);
      const sb = net.station(prof.main[prof.main.length - 1]);
      // A = Start, B = Ende
      app.map.showEndpoints(sa, sb, false, true);
      if (c.phase === 'draw') {
        drawOrientation(c.line);
        app.map.showSketch([a, ...c.taps]);
        app.map.onTap((ll) => {
          c.taps.push(ll);
          app.map.showSketch([a, ...c.taps]);
          render();
        });
        // Ausschnitt: beide Endstationen
        fitEnds(a, b);
      } else {
        drawProfile(prof, false);
        app.map.showSketch([a, ...c.taps, b]);
        app.map.showMarkedStops(c.result!.missed, '#c81e1e');
      }
    }
    render();
  }

  function fitEnds(a: LatLon, b: LatLon) {
    const lat = (a[0] + b[0]) / 2;
    const lon = (a[1] + b[1]) / 2;
    const span = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]) * 0.66);
    const zoom = span > 0.12 ? 11 : span > 0.06 ? 12 : span > 0.03 ? 13 : 14;
    app.map.zoomTo(lat, lon, zoom);
  }

  function renderCards(): HTMLElement {
    const box = h('div', { class: 'learn-body' });
    if (!card) {
      const next = nextLine();
      const intro = h(
        'div',
        { class: 'learn-card' },
        next
          ? `<h3>Linie für Linie</h3>
             <p>So lernst du die Linienführung: <b>1.</b> Steckbrief und Verlauf ansehen · <b>2.</b> aus dem Gedächtnis nachzeichnen · <b>3.</b> mit dem echten Verlauf vergleichen und selbst einschätzen.</p>
             <p class="muted">Unbekannte Linien kommen zuerst, „sitzt“ markierte später wieder zur Auffrischung.</p>`
          : `<h3>🎉 Alle Linien durch!</h3><p>Du hast in dieser Runde alle Linien des Bereichs angesehen.</p>`,
      );
      const btn = h('button', { class: 'btn btn-primary btn-big' }, next ? `Los geht's mit ${esc(next.id)} →` : 'Nochmal von vorne');
      btn.addEventListener('click', () => {
        if (!next) seen.clear();
        openCard(nextLine());
      });
      box.append(intro, btn);
      return box;
    }

    const c = card;
    const prof = lineProfile(c.line);
    const from = net.station(prof.main[0]).name;
    const to = net.station(prof.main[prof.main.length - 1]).name;
    if (c.phase === 'study') {
      const info = h('div', { class: 'learn-card' }, profileHtml(prof));
      info.querySelectorAll<HTMLElement>('[data-peek]').forEach((li) => li.addEventListener('click', () => addPeek(li.dataset.peek!)));
      box.append(info);
      if (peek.length) box.insertAdjacentHTML('beforeend', peekHtml());
      const actions = h('div', { class: 'learn-actions' }, `<button class="btn btn-primary" id="go">Eingeprägt → nachzeichnen</button><button class="btn btn-ghost" id="skip">Überspringen</button>`);
      actions.querySelector('#go')!.addEventListener('click', () => {
        c.phase = 'draw';
        showPhase();
      });
      actions.querySelector('#skip')!.addEventListener('click', () => {
        seen.add(c.line.id);
        openCard(nextLine());
      });
      box.append(actions);
    } else if (c.phase === 'draw') {
      box.append(
        h(
          'div',
          { class: 'learn-card' },
          `<div class="learn-line">${lineChip(c.line.mode, c.line.id, c.line.color)}<span>nachzeichnen</span></div>
           <p>Tippe auf der Karte den Weg von <b>Ⓐ ${esc(from)}</b> nach <b>Ⓑ ${esc(to)}</b> entlang – so genau du kannst. Kurven und Umwege mitnehmen!</p>
           <small class="muted">${c.taps.length} Punkte gesetzt</small>`,
        ),
      );
      const actions = h(
        'div',
        { class: 'learn-actions three' },
        `<button class="btn btn-primary" id="done" ${c.taps.length ? '' : 'disabled'}>Fertig</button>
         <button class="btn btn-ghost" id="undo" ${c.taps.length ? '' : 'disabled'}>↶ Zurück</button>
         <button class="btn btn-ghost" id="peek">Nochmal ansehen</button>
         <button class="link skip-draw" id="skip">Überspringen – nächste Linie</button>`,
      );
      actions.querySelector('#skip')!.addEventListener('click', () => {
        seen.add(c.line.id);
        setMapBig(false);
        openCard(nextLine());
      });
      actions.querySelector('#done')!.addEventListener('click', () => {
        const [a, b] = endpoints(prof);
        c.result = evaluateSketch(prof, [a, ...c.taps, b]);
        c.phase = 'review';
        showPhase();
      });
      actions.querySelector('#undo')!.addEventListener('click', () => {
        c.taps.pop();
        const [a] = endpoints(prof);
        app.map.showSketch([a, ...c.taps]);
        render();
      });
      actions.querySelector('#peek')!.addEventListener('click', () => {
        c.phase = 'study';
        c.taps = [];
        showPhase();
      });
      box.append(actions);
    } else {
      const r = c.result!;
      const pct = Math.round(Math.min(r.coverage, Math.max(r.precision, 0.0001)) * 100);
      const msg =
        pct >= 85 ? 'Super – die Linienführung sitzt!' : pct >= 60 ? 'Schon ziemlich gut – schau dir die rot markierten Stationen nochmal an.' : 'Da fehlt noch einiges – sieh dir den Verlauf nochmal genau an.';
      box.append(
        h(
          'div',
          { class: 'learn-card' },
          `<div class="learn-line">${lineChip(c.line.mode, c.line.id, c.line.color)}<span>Vergleich</span></div>
           <div class="score-ring ${pct >= 85 ? 'great' : pct >= 60 ? 'ok' : 'meh'}"><b>${pct} %</b><small>getroffen</small></div>
           <p>${msg}</p>
           ${r.missed.length ? `<p class="muted">Verfehlt: ${r.missed.slice(0, 8).map((s) => esc(s.name)).join(', ')}${r.missed.length > 8 ? ' …' : ''}</p>` : ''}
           <p class="sentence">${esc(prof.sentence)}</p>
           ${stopListHtml(prof)}
           <p><b>Wie gut kennst du die ${esc(c.line.id)} jetzt?</b></p>`,
        ),
      );
      const actions = h(
        'div',
        { class: 'learn-actions' },
        `<button class="btn btn-primary" id="good">😊 Sitzt</button><button class="btn btn-ghost" id="again">🔁 Nochmal üben</button>`,
      );
      actions.querySelector('#good')!.addEventListener('click', () => {
        setBox(lineKey(c.line), boxOf(lineKey(c.line)) + 1);
        seen.add(c.line.id);
        setMapBig(false);
        openCard(nextLine());
      });
      actions.querySelector('#again')!.addEventListener('click', () => {
        setBox(lineKey(c.line), 0);
        c.phase = 'study';
        c.taps = [];
        c.result = null;
        showPhase();
      });
      box.append(actions);
    }
    return box;
  }

  // -------------------------------------------------------------- allgemein

  function render() {
    ctx.panel.innerHTML = '';
    ctx.panel.append(header(), renderCards());
  }

  function start() {
    setMapBig(false);
    app.map.clearEndpoints();
    if (card) showPhase();
    else {
      app.map.clearLearn();
      app.map.onTap(null);
      netLayer().render(netView({ focus: new Set(ctx.scope().lines.map((l) => l.id)), allLabels: true }));
      render();
    }
  }

  return { start };
}
