// Lernmodus – "Lernen": Netzplan mit Linien-Steckbriefen und "Linie für Linie" (ansehen → nachzeichnen → vergleichen)
import type { LatLon, Line } from '../../../shared/types.ts';
import { app, setMapBig } from '../store.ts';
import { esc, h, lineChip } from '../ui.ts';
import {
  PALETTE,
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

type Tab = 'map' | 'cards';
type Phase = 'study' | 'draw' | 'review';

const LEARNED = 2;
const lineKey = (l: Line) => `line:${l.id}`;

export function studyView(ctx: LearnCtx) {
  const net = app.net;
  let tab: Tab = 'map';
  let selLine: Line | null = null;
  let selStation: string | null = null;
  // Linie für Linie
  const seen = new Set<string>();
  let card: { line: Line; phase: Phase; taps: LatLon[]; result: SketchResult | null } | null = null;

  const colorOf = (l: Line) => {
    if (l.mode === 'U' || l.mode === 'S') return l.color;
    const i = ctx.scope().lines.indexOf(l);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  };

  // -------------------------------------------------------------- Karte

  /** Linie mit markanten Punkten (beschriftet) und allen Stationen (Name beim Drüberfahren) */
  function drawProfile(prof: LineProfile, fit: boolean, onStop?: (id: string) => void) {
    const marks = new Set(prof.waypoints);
    const pats = patternsOf(prof.line);
    const paths = pats.map((p) => p.map((id) => [net.station(id).lat, net.station(id).lon] as LatLon));
    const stops = [...new Set(pats.flat())].map((id) => {
      const s = net.station(id);
      return { id, lat: s.lat, lon: s.lon, name: s.name, terminal: marks.has(id) };
    });
    app.map.showNetworkLine(paths, prof.line.color, stops, { labels: true, onStop, fit });
  }

  function drawOverview(fit: boolean) {
    const scope = ctx.scope();
    app.map.clearLearn();
    app.map.onTap(null);
    app.map.showLearnArea(scope.area, false);
    if (selLine) {
      drawProfile(lineProfile(selLine), fit, selectStation);
      return;
    }
    app.map.showStops(scope.stations, selectStation);
    // Nummer der Linie auf eine Station im Bereich setzen (versetzt, damit sich die Schilder weniger überlappen)
    const labelAt = (l: Line, i: number): LatLon | undefined => {
      const inside = lineProfile(l).main.filter((id) => scope.stationSet.has(id));
      if (!inside.length) return undefined;
      const s = net.station(inside[Math.min(inside.length - 1, Math.floor(((i % 5) + 1) * (inside.length / 6)))]);
      return [s.lat, s.lon];
    };
    app.map.showNetworkOverview(
      scope.lines.map((l, i) => ({
        id: l.id,
        color: colorOf(l),
        paths: patternsOf(l).map((p) => p.map((id) => [net.station(id).lat, net.station(id).lon] as LatLon)),
        labelAt: scope.area ? labelAt(l, i) : undefined,
      })),
      (id) => selectLine(net.lines.get(id)!),
      fit && !scope.area,
    );
    // bei Gebieten auf das Gebiet zoomen, nicht auf die ganzen Linien
    if (fit && scope.area) app.map.showLearnArea(scope.area, true);
    if (selStation) {
      const s = net.station(selStation);
      app.map.showTarget(s.lat, s.lon, s.name);
    }
  }

  function selectLine(l: Line | null) {
    selLine = l;
    selStation = null;
    drawOverview(true);
    render();
  }

  function selectStation(id: string) {
    selStation = id;
    selLine = null;
    drawOverview(false);
    render();
  }

  // -------------------------------------------------------------- Bausteine

  function profileHtml(prof: LineProfile, full: boolean): string {
    const transfers = prof.transfers
      .map((t) => `<span class="transfer">${t.lines.map((l) => lineChip(l.mode, l.id, l.color)).join('')} <small>${esc(t.station.name)}</small></span>`)
      .join('');
    return `
      <div class="learn-line">${lineChip(prof.line.mode, prof.line.id, prof.line.color)}<span>${prof.stopCount} Stationen</span></div>
      <p class="sentence">${esc(prof.sentence)}</p>
      ${prof.districts.length ? `<p><b>Bezirke:</b> ${prof.districts.map((d) => `${d.id}. ${esc(d.name)}`).join(' → ')}</p>` : ''}
      ${transfers ? `<p><b>Umstieg zu U-/S-Bahn:</b></p><div class="transfers">${transfers}</div>` : ''}
      ${
        full
          ? `<details class="all-stops"><summary>Alle Stationen</summary><ol class="stop-list">${prof.main
              .map((id) => `<li data-st="${id}" class="${prof.waypoints.includes(id) ? 'in' : ''}">${esc(net.station(id).name)}</li>`)
              .join('')}</ol></details>`
          : ''
      }`;
  }

  function header(): HTMLElement {
    const scope = ctx.scope();
    const learned = scope.lines.filter((l) => boxOf(lineKey(l)) >= LEARNED).length;
    const el = h(
      'div',
      { class: 'learn-head' },
      `<button class="link" id="setup">← Bereich ändern</button>
       <h2>📖 ${esc(scope.label)}</h2>
       <div class="learn-progress"><div class="bar"><i style="width:${scope.lines.length ? Math.round((learned / scope.lines.length) * 100) : 0}%"></i></div>
         <small>${learned} von ${scope.lines.length} Linien gelernt</small></div>
       <div class="tabs">
         <button data-tab="map" class="${tab === 'map' ? 'on' : ''}">🗺️ Netzplan</button>
         <button data-tab="cards" class="${tab === 'cards' ? 'on' : ''}">🃏 Linie für Linie</button>
       </div>`,
    );
    el.querySelector('#setup')!.addEventListener('click', () => {
      setMapBig(false);
      ctx.back();
    });
    el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => start(b.dataset.tab as Tab)),
    );
    return el;
  }

  // -------------------------------------------------------------- Netzplan

  function renderMap(): HTMLElement {
    const scope = ctx.scope();
    const box = h('div', { class: 'learn-body' });
    if (selStation) {
      const st = net.station(selStation);
      const deps = departuresFrom(st, scope);
      const c = h(
        'div',
        { class: 'learn-card' },
        `<h3>📍 ${esc(st.name)}</h3><small>Von hier fährst du mit …</small>
         <ul class="deps">${deps
           .map(
             (d) => `<li><button class="line-opt" data-line="${esc(d.line.id)}">${lineChip(d.line.mode, d.line.id, d.line.color)}</button>
               <span>${d.dirs.map((x) => `→ <b>${esc(x.to)}</b>${x.via ? ` <small>über ${esc(x.via)}</small>` : ''}`).join('<br>')}</span></li>`,
           )
           .join('')}</ul>
         <button class="link" id="close">Alle Linien zeigen</button>`,
      );
      c.querySelectorAll<HTMLElement>('[data-line]').forEach((b) => b.addEventListener('click', () => selectLine(net.lines.get(b.dataset.line!)!)));
      c.querySelector('#close')!.addEventListener('click', () => {
        selStation = null;
        drawOverview(false);
        render();
      });
      box.append(c);
      return box;
    }
    if (selLine) {
      const prof = lineProfile(selLine);
      const c = h('div', { class: 'learn-card' }, profileHtml(prof, true));
      c.querySelectorAll<HTMLElement>('[data-st]').forEach((li) => li.addEventListener('click', () => selectStation(li.dataset.st!)));
      const actions = h('div', { class: 'learn-actions' }, `<button class="btn btn-primary" id="draw">✏️ Nachzeichnen üben</button><button class="btn btn-ghost" id="all">Alle Linien</button>`);
      actions.querySelector('#draw')!.addEventListener('click', () => {
        tab = 'cards';
        openCard(selLine!, 'draw');
      });
      actions.querySelector('#all')!.addEventListener('click', () => selectLine(null));
      box.append(c, actions);
      return box;
    }
    box.append(h('p', { class: 'muted' }, 'Linie antippen (Karte oder Liste) zeigt ihren Steckbrief · Haltestelle antippen zeigt, wohin du von dort kommst.'));
    const list = h('ul', { class: 'line-list' });
    list.innerHTML = scope.lines
      .map((l) => {
        const prof = lineProfile(l);
        const ends = `${esc(net.station(prof.main[0]).name)} ↔ ${esc(net.station(prof.main[prof.main.length - 1]).name)}`;
        const via = prof.waypoints.slice(1, -1).map((id) => net.station(id).name);
        const ok = boxOf(lineKey(l)) >= LEARNED;
        return `<li data-line="${esc(l.id)}"><span class="swatch" style="background:${colorOf(l)}"></span>${lineChip(l.mode, l.id, l.color)}
          <span class="ll-text">${ends}${via.length ? `<small>über ${via.map(esc).join(', ')}</small>` : ''}</span>${ok ? '<span class="ok">✓</span>' : ''}</li>`;
      })
      .join('');
    list.querySelectorAll<HTMLElement>('[data-line]').forEach((li) => li.addEventListener('click', () => selectLine(net.lines.get(li.dataset.line!)!)));
    box.append(list);
    return box;
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
      app.map.clearLearn();
      render();
      return;
    }
    card = { line, phase, taps: [], result: null };
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
    const scope = ctx.scope();
    app.map.clearLearn();
    app.map.onTap(null);
    app.map.showLearnArea(scope.area, false);
    setMapBig(c.phase === 'draw');
    if (c.phase === 'study') drawProfile(prof, true);
    else {
      const [a, b] = endpoints(prof);
      if (c.phase === 'draw') {
        const sa = net.station(prof.main[0]);
        const sb = net.station(prof.main[prof.main.length - 1]);
        app.map.showTarget(sa.lat, sa.lon, sa.name);
        app.map.showTarget(sb.lat, sb.lon, sb.name);
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
      box.append(h('div', { class: 'learn-card' }, profileHtml(prof, false)));
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
           <p>Tippe auf der Karte den Weg von <b>${esc(from)}</b> nach <b>${esc(to)}</b> entlang – so genau du kannst. Kurven und Umwege mitnehmen!</p>
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
    ctx.panel.append(header(), tab === 'map' ? renderMap() : renderCards());
  }

  function start(t: Tab) {
    tab = t;
    setMapBig(false);
    if (t === 'map') drawOverview(true);
    else if (card) showPhase();
    else {
      app.map.clearLearn();
      app.map.onTap(null);
      app.map.showLearnArea(ctx.scope().area, true);
      render();
      return;
    }
    render();
  }

  return { start };
}
