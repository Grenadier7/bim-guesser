// Lernmodus – Netzkarte: suchen oder antippen → Linien-Steckbrief bzw. „Von hier fährst du mit …“, ⭐ merken,
// zwei Linien vergleichen. Man hangelt sich durchs Netz: Station im Steckbrief → „Von hier“ → Linie → …
import type { Line, Station } from '../../../shared/types.ts';
import { distM } from '../net.ts';
import { netLayer, netView, type Kind } from '../netmap.ts';
import { app, setMapBig } from '../store.ts';
import { esc, lineChip } from '../ui.ts';
import { DAY_SCOPE, addMine, departuresFrom, isMine, isSpecialLine, lineProfile, linesAt, myLines, patternsOf, servedStations, setMine } from './model.ts';

export type AtlasSel = { kind: 'line'; id: string } | { kind: 'station'; id: string } | { kind: 'compare'; ids: string[] } | null;

/** Farben beim Vergleich: gut unterscheidbar, egal welches Verkehrsmittel – so viele Linien gehen höchstens */
const CMP = ['#e8590c', '#7048e8', '#0ca678', '#d6336c', '#1c7ed6', '#a07400'];

const norm = (x: string) =>
  x
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const same = (a: AtlasSel, b: AtlasSel) => JSON.stringify(a) === JSON.stringify(b);

const chipOf = (l: Line, color?: string) => lineChip(l.mode, l.id, color ?? l.color);

export const starBtn = (id: string, mode: 'full' | 'small' | 'named' = 'full') =>
  `<button class="star-btn ${isMine(id) ? 'on' : ''}${mode === 'small' ? ' small' : ''}" data-star="${esc(id)}" title="${isMine(id) ? 'gemerkt – nochmal tippen zum Entfernen' : 'für „Üben“ merken'}">${
    mode === 'small' ? (isMine(id) ? '⭐' : '☆') : `${isMine(id) ? '⭐' : '☆'} ${mode === 'named' ? esc(id) + ' ' : ''}${isMine(id) ? 'gemerkt' : 'merken'}`
  }</button>`;
/** kleine, antippbare Liniennummern (Umstiege zu Bim/Bus in der Stationsliste) */
const mini = (ls: Line[]) => ls.map((l) => `<button class="chip-btn mini" data-line="${esc(l.id)}">${chipOf(l)}</button>`).join('');

/** Linien-Steckbrief (auch in Kursen benutzt); `compare` = Knopf „Vergleichen“ */
export function lineHtml(l: Line, compare = true): string {
  const prof = lineProfile(l);
  const marks = new Set(prof.waypoints);
  const transfers = prof.transfers
    .map(
      (t) => `<span class="transfer">${t.lines.map((x) => `<button class="chip-btn" data-line="${esc(x.id)}">${chipOf(x)}</button>`).join('')}
        <button class="link" data-st="${t.station.id}">${esc(t.station.name)}</button></span>`,
    )
    .join('');
  const seen = new Set<string>();
  const stops = prof.main.filter((id) => !seen.has(app.net.station(id).name) && seen.add(app.net.station(id).name));
  return `<div class="learn-card atlas-card">
    <div class="learn-line">${chipOf(l)}<span>${prof.stopCount} Stationen</span>${starBtn(l.id)}</div>
    <p class="sentence">${esc(prof.sentence)}</p>
    ${prof.districts.length ? `<p><b>Bezirke:</b> ${prof.districts.map((d) => `${d.id}. ${esc(d.name)}`).join(' → ')}</p>` : ''}
    ${transfers ? `<p><b>Umstieg zu U-/S-Bahn:</b></p><div class="transfers">${transfers}</div>` : ''}
    ${prof.trams.length ? `<p><b>Unterwegs kreuzt du die Bim:</b></p><div class="chips">${mini(prof.trams)}</div>` : ''}
    <details class="all-stops"><summary>Alle ${stops.length} Stationen <small class="muted">mit Umstiegen zu Bim und Bus</small></summary>
      <ol class="stop-list">${stops
        .map((id) => {
          const loc = prof.local.get(id)!;
          return `<li class="${marks.has(id) ? 'in' : ''}"><button class="link" data-st="${id}">${esc(app.net.station(id).name)}</button>
            ${loc.trams.length || loc.buses.length ? `<span class="stop-transfers">${mini(loc.trams)}${mini(loc.buses)}</span>` : ''}</li>`;
        })
        .join('')}</ol></details>
    <div class="atlas-actions"><button class="btn btn-ghost" id="compare">⇄ Mit anderer Linie vergleichen</button></div></div>`;
}

/** „Von hier fährst du mit …“ (auch in Kursen benutzt) */
export function stationHtml(st: Station): string {
  const deps = departuresFrom(st, DAY_SCOPE()).filter((d) => !isSpecialLine(d.line));
  const ids = deps.map((d) => d.line.id);
  const allMine = ids.length > 0 && ids.every(isMine);
  const district = app.net.data.districts.find((d) => d.id === st.district);
  return `<div class="learn-card atlas-card">
    <h3>📍 ${esc(st.name)}</h3>${district ? `<small class="muted">${district.id}. ${esc(district.name)}</small>` : ''}
    ${
      deps.length
        ? `<p><b>Von hier fährst du mit …</b></p>
      <ul class="deps">${deps
        .map(
          (d) => `<li><button class="line-opt" data-line="${esc(d.line.id)}">${chipOf(d.line)}</button>
            <span>${d.dirs.map((x) => `→ <b>${esc(x.to)}</b>${x.via ? ` <small>über ${esc(x.via)}</small>` : ''}`).join('<br>')}</span>${starBtn(d.line.id, 'small')}</li>`,
        )
        .join('')}</ul>
      <div class="card-actions"><button class="btn btn-ghost" id="star-all" ${allMine ? 'disabled' : ''}>${allMine ? '⭐ Alle gemerkt' : `⭐ Alle ${ids.length} Linien merken`}</button></div>`
        : '<p class="muted">Hier fährt im regulären Netz tagsüber keine Linie.</p>'
    }
    <small class="muted">Linie antippen zeigt ihren Steckbrief · ☆ merkt sie für „Üben“.</small></div>`;
}


export function atlasView(panel: HTMLElement, onBack: () => void, opts: { query?: string; select?: AtlasSel } = {}) {
  const net = app.net;
  const layer = netLayer();
  let sel: AtlasSel = opts.select ?? null;
  const history: AtlasSel[] = [];
  let query = opts.query ?? '';
  let bim = true;
  let mineOnly = false;
  /** Linien, mit denen verglichen werden soll – die nächste gewählte Linie kommt dazu */
  let comparing: string[] | null = null;
  // nur Haltestellen, an denen im regulären Netz etwas fährt – erst beim Hineinzoomen sichtbar und antippbar
  const served = servedStations();
  const allStops = net.data.stations.filter((s) => served.has(s.id));
  const dayLinesAt = (st: Station) => linesAt(st, DAY_SCOPE());
  const line = (id: string) => net.lines.get(id)!;

  // -------------------------------------------------------------- Suche

  const findStations = (q: string): Station[] => {
    const n = norm(q);
    if (n.length < 2) return [];
    const byName = new Map<string, Station>();
    for (const s of net.data.stations) if (!byName.has(s.name) && served.has(s.id) && dayLinesAt(s).length) byName.set(s.name, s);
    const names = [...byName.keys()];
    const starts = names.filter((x) => norm(x).startsWith(n));
    const contains = names.filter((x) => !starts.includes(x) && norm(x).includes(n));
    return [...starts, ...contains].slice(0, 6).map((x) => byName.get(x)!);
  };
  const findLines = (q: string): Line[] => (q.trim() ? net.searchLines(q).filter((l) => l.mode !== 'N' && !isSpecialLine(l)).slice(0, 10) : []);

  function resultsHtml(): string {
    if (!query.trim()) return '';
    const ls = findLines(query);
    const sts = comparing ? [] : findStations(query);
    if (!ls.length && !sts.length) return '<p class="muted">Nichts gefunden.</p>';
    return `${ls.length ? `<div class="chips atlas-hits">${ls.map((l) => `<button class="line-opt" data-line="${esc(l.id)}">${chipOf(l)}</button>`).join('')}</div>` : ''}
      ${sts
        .map(
          (s) => `<button class="station-opt" data-st="${s.id}">📍 <b>${esc(s.name)}</b>
            <span class="chips">${dayLinesAt(s)
              .map((l) => chipOf(l))
              .join('')}</span></button>`,
        )
        .join('')}`;
  }

  // -------------------------------------------------------------- Navigation

  function go(next: AtlasSel) {
    // Vergleich angefangen: die nächste Linie kommt dazu
    if (comparing && next?.kind === 'line' && !comparing.includes(next.id)) {
      next = { kind: 'compare', ids: [...comparing, next.id].slice(0, CMP.length) };
      comparing = null;
    }
    if (sel && !same(sel, next)) history.push(sel);
    sel = next;
    query = '';
    draw(true);
    render();
  }
  function back() {
    comparing = null;
    sel = history.pop() ?? null;
    draw(true);
    render();
  }
  /** direkt zurück zur ganzen Netzkarte */
  function overview() {
    comparing = null;
    sel = null;
    history.length = 0;
    draw(true);
    render();
  }

  // -------------------------------------------------------------- Karte

  function draw(fit: boolean) {
    app.map.clearLearn();
    app.map.onTap(null);
    const common = {
      kinds: new Set<Kind>(bim || sel ? ['U', 'S', 'T', 'B'] : ['U', 'S', 'B']),
      allStops,
      onLine: (id: string) => go({ kind: 'line', id }),
      onStation: (id: string) => go({ kind: 'station', id }),
    };
    if (sel?.kind === 'line') {
      const prof = lineProfile(line(sel.id));
      const stops = [...new Set(patternsOf(prof.line).flat())].map((id) => net.station(id));
      const pts = layer.render(netView({ ...common, focus: new Set([sel.id]), marks: prof.waypoints.map((id) => net.station(id)), stops }));
      if (fit && pts.length) app.map.fitPoints(pts, 14);
    } else if (sel?.kind === 'compare') {
      const { ids } = sel;
      const stops = [...new Set(ids.flatMap((id) => patternsOf(line(id)).flat()))].map((id) => net.station(id));
      const colors = Object.fromEntries(ids.map((id, i) => [id, CMP[i]]));
      const pts = layer.render(netView({ ...common, focus: new Set(ids), colors, marks: meetings(ids).slice(0, 6).map((m) => m.station), stops }));
      if (fit && pts.length) app.map.fitPoints(pts, 14);
    } else if (sel?.kind === 'station') {
      const st = net.station(sel.id);
      layer.render(netView({ ...common, focus: new Set(dayLinesAt(st).map((l) => l.id)), marks: [st] }));
      if (fit) app.map.zoomTo(st.lat, st.lon, 14);
    } else {
      const mine = myLines();
      const pts = layer.render(netView({ ...common, focus: mineOnly ? new Set(mine) : new Set() }));
      if (fit) mineOnly && mine.length && pts.length ? app.map.fitPoints(pts, 14) : app.map.cityView();
    }
  }

  // -------------------------------------------------------------- Panel

  /** Treffpunkte: Stationen (nach Namen), an denen mindestens zwei der Linien halten – meiste Linien zuerst */
  function meetings(ids: string[]): { station: Station; lines: string[] }[] {
    const by = new Map<string, { station: Station; lines: string[] }>();
    for (const id of ids)
      for (const sid of lineProfile(line(id)).main) {
        const st = net.station(sid);
        const e = by.get(st.name) ?? by.set(st.name, { station: st, lines: [] }).get(st.name)!;
        if (!e.lines.includes(id)) e.lines.push(id);
      }
    return [...by.values()].filter((e) => e.lines.length >= 2).sort((a, b) => b.lines.length - a.lines.length);
  }

  function compareHtml(ids: string[]): string {
    const ls = ids.map(line);
    const ps = ls.map((l) => lineProfile(l));
    const col = (l: Line, i: number) => `<button class="chip-btn" data-line="${esc(l.id)}">${chipOf(l, CMP[i])}</button>`;
    const ends = (p: (typeof ps)[number]) => `${esc(net.station(p.main[0]).name)} ↔ ${esc(net.station(p.main[p.main.length - 1]).name)}`;
    // Kopf: Linien in ihren Vergleichsfarben, je mit ×, dazu ein kleines + für eine weitere Linie
    const head = `<div class="compare-head">${ls
      .map((l, i) => `<span class="cmp-item">${col(l, i)}<button class="cmp-x" data-cmp-rm="${esc(l.id)}" title="${esc(l.id)} aus dem Vergleich nehmen">×</button></span>`)
      .join('<span class="cmp-sep">⇄</span>')}${ids.length < CMP.length ? '<button class="cmp-add" id="cmp-add" title="weitere Linie vergleichen">+</button>' : ''}</div>`;
    const meet = meetings(ids);
    if (ids.length === 2) {
      const [pa, pb] = ps;
      // keine gemeinsame Station: wo kommen sie sich am nächsten?
      let near = '';
      if (!meet.length) {
        let best: [Station, Station, number] | null = null;
        for (const x of pa.main)
          for (const y of pb.main) {
            const d = distM(net.station(x), net.station(y));
            if (!best || d < best[2]) best = [net.station(x), net.station(y), d];
          }
        if (best) near = `<p>Keine gemeinsame Station – am nächsten kommen sie sich bei <b>${esc(best[0].name)}</b> und <b>${esc(best[1].name)}</b> (${Math.round(best[2] / 10) * 10} m).</p>`;
      }
      const rapid = (p: (typeof ps)[number]) => [...new Map(p.transfers.flatMap((t) => t.lines).map((x) => [x.id, x])).values()].map((x) => chipOf(x)).join(' ') || '–';
      return `<div class="learn-card atlas-card">${head}
        <table class="course-table compare-table">
          <tr><td>Strecke</td><td>${ends(pa)}</td><td>${ends(pb)}</td></tr>
          <tr><td>Stationen</td><td>${pa.stopCount}</td><td>${pb.stopCount}</td></tr>
          <tr><td>Bezirke</td><td>${pa.districts.map((d) => d.id).join(', ')}</td><td>${pb.districts.map((d) => d.id).join(', ')}</td></tr>
          <tr><td>U/S-Umstiege</td><td>${rapid(pa)}</td><td>${rapid(pb)}</td></tr>
        </table>
        ${meet.length ? `<p><b>Gemeinsame Stationen (${meet.length}):</b> ${meet.map((m) => `<button class="link" data-st="${m.station.id}">${esc(m.station.name)}</button>`).join(', ')}</p>` : near}
        <p class="sentence">${esc(pa.sentence)}</p><p class="sentence">${esc(pb.sentence)}</p>
        <div class="atlas-actions">${ids.map((id) => starBtn(id, 'named')).join(' ')}</div></div>`;
    }
    // ab 3 Linien: knapp – Strecke, Stationen, Bezirke und wo sich die Linien treffen
    return `<div class="learn-card atlas-card">${head}
      <table class="course-table compare-table compare-many">
        ${ls.map((l, i) => `<tr><td>${col(l, i)}</td><td>${ends(ps[i])}<br><small class="muted">${ps[i].stopCount} Stationen · Bezirke ${ps[i].districts.map((d) => d.id).join(', ')}</small></td></tr>`).join('')}
      </table>
      <p><b>Treffpunkte</b> <small class="muted">(mindestens zwei der Linien)</small></p>
      ${
        meet.length
          ? `<ul class="meetings">${meet
              .slice(0, 10)
              .map((m) => `<li><button class="link" data-st="${m.station.id}">${esc(m.station.name)}</button> ${m.lines.map((id) => chipOf(line(id), CMP[ids.indexOf(id)])).join('')}</li>`)
              .join('')}</ul>${meet.length > 10 ? `<small class="muted">… und ${meet.length - 10} weitere</small>` : ''}`
          : '<p class="muted">Keine gemeinsame Station.</p>'
      }
      <div class="atlas-actions">${ids.map((id) => starBtn(id, 'named')).join(' ')}</div></div>`;
  }

  function introHtml(): string {
    const mine = myLines().map(line);
    return `<div class="learn-card atlas-card">
      <p>Tippe eine <b>Linie</b> oder <b>Station</b> auf der Karte an – oder such oben. Hineinzoomen zeigt alle Haltestellen.</p>
      <p><b>⭐ Meine Linien</b> ${mine.length ? `<small class="muted">(${mine.length}) – das übst du unter 🏋 Üben</small>` : ''}</p>
      ${
        mine.length
          ? `<div class="chips">${mine.map((l) => `<button class="line-opt" data-line="${esc(l.id)}">${chipOf(l)}</button>`).join('')}</div>`
          : '<p class="muted">Noch keine – im Steckbrief einer Linie mit ☆ merken, oder an einer Station.</p>'
      }</div>`;
  }

  function render() {
    const body =
      sel?.kind === 'line'
        ? lineHtml(line(sel.id))
        : sel?.kind === 'station'
          ? stationHtml(net.station(sel.id))
          : sel?.kind === 'compare'
            ? compareHtml(sel.ids)
            : introHtml();
    panel.innerHTML = `<div class="learn atlas">
      <button class="link" id="back">← Lernen</button>
      <h2>🗺 Netzkarte</h2>
      ${comparing ? `<div class="compare-hint">⇄ Vergleichen: <b>${comparing.map(esc).join(', ')}</b> mit … <small>Linie suchen oder auf der Karte antippen</small> <button class="link" id="cancel-cmp">abbrechen</button></div>` : ''}
      <input class="line-input" id="atlas-search" placeholder="${comparing ? 'Weitere Linie, z.B. 66A' : 'Linie oder Station, z.B. 13A oder Praterstern'}" autocomplete="off" spellcheck="false">
      <div class="atlas-results" id="atlas-results">${resultsHtml()}</div>
      <div class="atlas-tools">
        <button class="toggle-chip ${bim ? 'on' : ''}" id="t-bim">🚋 Bim</button>
        <button class="toggle-chip ${mineOnly ? 'on' : ''}" id="t-mine" ${myLines().length ? '' : 'disabled'}>⭐ Meine Linien</button>
        <span class="atlas-nav">${history.length ? '<button class="link" id="prev">← zurück</button>' : ''}${sel ? '<button class="link" id="overview">✕ Übersicht</button>' : ''}</span>
      </div>
      ${body}
    </div>`;
    const input = panel.querySelector<HTMLInputElement>('#atlas-search')!;
    input.value = query;
    if (query || comparing) {
      input.focus();
      input.setSelectionRange(query.length, query.length);
    }
    input.addEventListener('input', () => {
      query = input.value;
      panel.querySelector('#atlas-results')!.innerHTML = resultsHtml();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const l = findLines(query)[0];
      const s = comparing ? undefined : findStations(query)[0];
      if (l) go({ kind: 'line', id: l.id });
      else if (s) go({ kind: 'station', id: s.id });
    });
    panel.querySelector('#back')!.addEventListener('click', () => {
      setMapBig(false);
      onBack();
    });
    panel.querySelector('#prev')?.addEventListener('click', back);
    panel.querySelector('#overview')?.addEventListener('click', overview);
    panel.querySelector('#cancel-cmp')?.addEventListener('click', () => {
      comparing = null;
      render();
    });
    panel.querySelector('#cmp-add')?.addEventListener('click', () => {
      comparing = sel?.kind === 'compare' ? [...sel.ids] : null;
      render();
    });
    panel.querySelectorAll<HTMLElement>('[data-cmp-rm]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (sel?.kind !== 'compare') return;
        const rest = sel.ids.filter((x) => x !== b.dataset.cmpRm);
        sel = rest.length >= 2 ? { kind: 'compare', ids: rest } : { kind: 'line', id: rest[0] };
        draw(true);
        render();
      }),
    );
    panel.querySelector('#compare')?.addEventListener('click', () => {
      comparing = sel?.kind === 'line' ? [sel.id] : null;
      render();
    });
    panel.querySelector('#t-bim')!.addEventListener('click', () => {
      bim = !bim;
      draw(false);
      render();
    });
    panel.querySelector('#t-mine')!.addEventListener('click', () => {
      mineOnly = !mineOnly;
      overview();
    });
    panel.querySelector('#star-all')?.addEventListener('click', () => {
      if (sel?.kind === 'station') addMine(departuresFrom(net.station(sel.id), DAY_SCOPE()).map((d) => d.line.id).filter((id) => !isSpecialLine(line(id))));
      render();
    });
    // Linien, Stationen und ⭐ überall im Panel antippbar
    panel.querySelector('.atlas')!.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const star = t.closest<HTMLElement>('[data-star]')?.dataset.star;
      if (star) {
        setMine(star, !isMine(star));
        render();
        return;
      }
      const id = t.closest<HTMLElement>('[data-line]')?.dataset.line;
      if (id) return go({ kind: 'line', id });
      const stId = t.closest<HTMLElement>('[data-st]')?.dataset.st;
      if (stId) go({ kind: 'station', id: stId });
    });
  }

  draw(true);
  render();
}
