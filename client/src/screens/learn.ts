// Lernmodus: Bereich wählen → Lernen (Netzplan, Linie für Linie) oder Wissen testen
import type { Line, Mode } from '../../../shared/types.ts';
import { MODE_ICON, MODE_LABEL } from '../../../shared/rules.ts';
import {
  AREA_MODES,
  RADII,
  boxOf,
  computeScope,
  fmtKm,
  loadConfig,
  patternsOf,
  resetBoxes,
  saveConfig,
  type ScopeKind,
} from '../learn/model.ts';
import { studyView, type LearnCtx } from '../learn/study.ts';
import { app, setMapBig, setMobileMap } from '../store.ts';
import { esc, h, lineChip } from '../ui.ts';
import type { Screen } from './screen.ts';

export function learnScreen(panel: HTMLElement, onBack: () => void): Screen {
  const net = app.net;
  net.mode = 'regular';
  const cfg = loadConfig();
  let scope = computeScope(cfg);
  app.map.clear();

  const update = (fit = false) => {
    saveConfig(cfg);
    scope = computeScope(cfg);
    renderSetup(fit);
  };

  const drawLine = (l: Line, fit: boolean) => {
    const pats = patternsOf(l);
    const paths = pats.map((p) => p.map((id) => [net.station(id).lat, net.station(id).lon] as [number, number]));
    const terminals = new Set(pats.flatMap((p) => [p[0], p[p.length - 1]]));
    const stops = [...new Set(pats.flat())].map((id) => {
      const s = net.station(id);
      return { id, lat: s.lat, lon: s.lon, name: s.name, terminal: terminals.has(id) };
    });
    app.map.showNetworkLine(paths, l.color, stops, { labels: true, fit });
  };
  const ctx: LearnCtx = { panel, scope: () => scope, back: () => renderSetup(true) };
  let study = studyView(ctx);

  // -------------------------------------------------------------- Bereich wählen

  function renderSetup(fit: boolean) {
    setMapBig(false);
    // Handy: Karte nur, wenn man den Kreis setzen muss
    setMobileMap(cfg.kind === 'area' && cfg.areaType === 'circle');
    app.map.clearLearn();
    app.map.showLearnArea(scope.area, fit && cfg.kind !== 'lines');
    app.map.showStops(scope.stations);
    if (cfg.kind === 'lines' && scope.lines.length === 1) drawLine(scope.lines[0], fit);
    app.map.onTap(
      cfg.kind === 'area' && cfg.areaType === 'circle'
        ? (ll) => {
            cfg.circle = { lat: ll[0], lon: ll[1], radiusM: cfg.circle?.radiusM ?? 1500 };
            update(true);
          }
        : null,
    );

    const kindTab = (k: ScopeKind, label: string) => `<button data-kind="${k}" class="${cfg.kind === k ? 'on' : ''}">${label}</button>`;
    let body = '';
    if (cfg.kind === 'area') {
      body = `<div class="seg seg-wide">
          <button data-at="district" class="${cfg.areaType === 'district' ? 'on' : ''}">Bezirk</button>
          <button data-at="circle" class="${cfg.areaType === 'circle' ? 'on' : ''}">Kreis auf der Karte</button></div>
        ${
          cfg.areaType === 'district'
            ? `<select id="district">${net.data.districts.map((d) => `<option value="${d.id}" ${d.id === cfg.district ? 'selected' : ''}>${d.id}. ${esc(d.name)}</option>`).join('')}</select>`
            : `<small class="hint">👆 Tippe auf die Karte, um den Mittelpunkt zu setzen – z.B. beim Prater.</small>
               <div class="seg seg-wide">${RADII.map((r) => `<button data-r="${r}" class="${cfg.circle?.radiusM === r ? 'on' : ''}">${fmtKm(r)}</button>`).join('')}</div>`
        }`;
    } else if (cfg.kind === 'lines') {
      body = `<input class="line-input" id="line-search" placeholder="Linie hinzufügen, z.B. U1, 13A, D …" autocomplete="off" spellcheck="false">
        <div class="line-results" id="line-results"></div>
        <div class="quick">${(['U', 'S', 'T'] as Mode[]).map((m) => `<button data-all="${m}">+ alle ${MODE_LABEL[m]}</button>`).join('')}${cfg.lines.length ? '<button data-clear="1">Leeren</button>' : ''}</div>
        <div class="chips picked-lines">${scope.lines.map((l) => `<button class="line-opt" data-rm="${esc(l.id)}" title="entfernen">${lineChip(l.mode, l.id, l.color)}<span class="x">×</span></button>`).join('')}</div>`;
    }
    const modeChips =
      cfg.kind !== 'lines'
        ? `<div class="setting"><span>Verkehrsmittel</span><div class="quiz-modes">${AREA_MODES.map((m) => `<button data-mode="${m}" class="${cfg.modes.includes(m) ? 'on' : ''}">${MODE_ICON[m]} ${MODE_LABEL[m]}</button>`).join('')}</div></div>`
        : '';
    const learned = scope.lines.filter((l) => boxOf(`line:${l.id}`) >= 2).length;
    const el = h('div', { class: 'learn' });
    el.innerHTML = `
      <button class="link" id="back">← Zurück</button>
      <h2>📚 Lernen</h2>
      <div class="setting"><span>Was willst du lernen?</span>
        <div class="seg seg-wide">${kindTab('area', '🗺️ Gebiet')}${kindTab('lines', '🚇 Linien')}${kindTab('all', '🌍 Ganz Wien')}</div></div>
      <div class="learn-scope">${body}</div>
      ${modeChips}
      <div class="learn-card scope-card"><b>${esc(scope.label)}</b>
        <small>${scope.stations.length} Stationen · ${scope.lines.length} Linien</small>
        <div class="learn-progress"><div class="bar"><i style="width:${scope.lines.length ? Math.round((learned / scope.lines.length) * 100) : 0}%"></i></div>
          <small>${learned} von ${scope.lines.length} Linien gelernt</small></div>
        <button class="link" id="reset">Fortschritt für diesen Bereich zurücksetzen</button></div>
      <button class="btn btn-primary btn-big" id="study" ${scope.lines.length ? '' : 'disabled'}>📖 Lernen</button>
      <p class="muted center">Netzplan mit Steckbrief jeder Linie, dann Linie für Linie nachzeichnen.<br>
        Wissen testen? Dafür gibt's jetzt den <b>🧠 Quiz</b>-Modus auf der Startseite.</p>`;
    panel.innerHTML = '';
    panel.append(el);

    el.querySelector('#back')!.addEventListener('click', onBack);
    el.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) =>
      b.addEventListener('click', () => {
        cfg.kind = b.dataset.kind as ScopeKind;
        update(true);
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-at]').forEach((b) =>
      b.addEventListener('click', () => {
        cfg.areaType = b.dataset.at as typeof cfg.areaType;
        update(true);
      }),
    );
    el.querySelector<HTMLSelectElement>('#district')?.addEventListener('change', (e) => {
      cfg.district = Number((e.target as HTMLSelectElement).value);
      update(true);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((b) =>
      b.addEventListener('click', () => {
        const radiusM = Number(b.dataset.r);
        cfg.circle = cfg.circle ? { ...cfg.circle, radiusM } : { lat: 48.2185, lon: 16.3925, radiusM }; // Praterstern
        update(true);
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = b.dataset.mode as Mode;
        if (cfg.modes.includes(m)) {
          if (cfg.modes.length > 1) cfg.modes = cfg.modes.filter((x) => x !== m);
        } else cfg.modes = [...cfg.modes, m];
        update();
      }),
    );
    // Linien wählen
    const search = el.querySelector<HTMLInputElement>('#line-search');
    const results = el.querySelector<HTMLElement>('#line-results');
    const addLine = (id: string) => {
      if (!cfg.lines.includes(id)) cfg.lines = [...cfg.lines, id];
      update(true);
      panel.querySelector<HTMLInputElement>('#line-search')?.focus();
    };
    search?.addEventListener('input', () => {
      results!.innerHTML = net
        .searchLines(search.value)
        .filter((l) => !cfg.lines.includes(l.id))
        .map((l) => `<button class="line-opt" data-add="${esc(l.id)}">${lineChip(l.mode, l.id, l.color)}</button>`)
        .join('');
    });
    search?.addEventListener('keydown', (e) => {
      const first = net.searchLines(search.value).find((l) => !cfg.lines.includes(l.id));
      if (e.key === 'Enter' && first) addLine(first.id);
    });
    results?.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-add]')?.dataset.add;
      if (id) addLine(id);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-all]').forEach((b) =>
      b.addEventListener('click', () => {
        const ids = net.data.lines.filter((l) => l.mode === b.dataset.all && patternsOf(l).length).map((l) => l.id);
        cfg.lines = [...new Set([...cfg.lines, ...ids])];
        update(true);
      }),
    );
    el.querySelector('[data-clear]')?.addEventListener('click', () => {
      cfg.lines = [];
      update(true);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        cfg.lines = cfg.lines.filter((x) => x !== b.dataset.rm);
        update(true);
      }),
    );
    el.querySelector('#reset')!.addEventListener('click', () => {
      if (!confirm('Lernfortschritt für diesen Bereich zurücksetzen?')) return;
      resetBoxes(scope.lines.map((l) => `line:${l.id}`));
      renderSetup(false);
    });
    el.querySelector('#study')!.addEventListener('click', () => {
      setMobileMap(true);
      // jedes Mal frisch – sonst bleibt die Linie vom letzten Bereich (z.B. 18 statt 60) offen
      study = studyView(ctx);
      study.start('map');
    });
  }

  renderSetup(true);
  return {
    destroy: () => {
      setMapBig(false);
      app.map.onTap(null);
      app.map.clear();
    },
  };
}
