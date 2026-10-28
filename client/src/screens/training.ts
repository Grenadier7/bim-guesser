// Trainingsmodus: echte Strecken ohne Zeit und Punkte, mit Coach, gestuften Hilfen,
// "Was fährt hier ab?", Erklärung am Ende, Wiederholung und Merkliste.
import type { Difficulty, GameSettings, Line, SlotId, TrainingResult, TrainingRound } from '../../../shared/types.ts';
import { DIFFICULTY_PRESETS, TIME_SLOTS } from '../../../shared/rules.ts';
import { DEFAULT_TRAINING } from '../../../shared/defaults.ts';
import { api } from '../api.ts';
import { RouteBuilder } from '../builder.ts';
import { netLayer, netView, smoothRoute } from '../netmap.ts';
import { departuresFrom, starMini, type Scope } from '../learn/model.ts';
import { app, setMapBig, setMobileMap } from '../store.ts';
import { HINTS, compass, explain, hintText, legFeedback, lineDirections, routeSentence, type CoachMsg, type HintId } from '../training/coach.ts';
import { chain, esc, h, lineChip, makeExpandable, routeDetails, toast } from '../ui.ts';
import { loadingHtml, type Screen } from './screen.ts';
import { loadMerged, saveJson } from '../storage.ts';

// ---------------------------------------------------------------- Speicher

interface TrainCfg {
  slot: SlotId;
  preset: Exclude<Difficulty, 'custom'>;
  /** 0 = ganz Wien, sonst Bezirk als Schwerpunkt */
  area: number;
  coach: boolean;
}

interface Note {
  from: string;
  to: string;
  text: string;
  min: number;
  date: string;
}

interface Memory {
  retry: { from: string; to: string; due: number }[];
  notes: Note[];
  rounds: number;
  solved: number;
}

const CFG_KEY = 'oeffi-training-config-v1';
const MEM_KEY = 'oeffi-training-memory-v1';
const RETRY_AFTER = 3;


const ALL_MODES = { modes: new Set(['U', 'S', 'T', 'B', 'N']) } as Scope;

// ---------------------------------------------------------------- Bildschirm

export function trainingScreen(panel: HTMLElement, onBack: () => void): Screen {
  const net = app.net;
  const cfg = loadMerged<TrainCfg>(CFG_KEY, { ...DEFAULT_TRAINING });
  const mem = loadMerged<Memory>(MEM_KEY, { retry: [], notes: [], rounds: 0, solved: 0 });
  const persist = () => (saveJson(CFG_KEY, cfg), saveJson(MEM_KEY, mem));

  let round: TrainingRound | null = null;
  let isRetry = false;
  let builder: RouteBuilder | null = null;
  let coach: CoachMsg[] = [];
  let hintsUsed: HintId[] = [];
  let legCount = 0;
  let lastDraft = '';
  let prefetch: Promise<TrainingRound> | null = null;
  let sessionRounds = 0;
  /** "Schwerpunkt" gewählt (Bezirk evtl. noch offen) */
  let areaOn = cfg.area > 0;

  app.map.clear();
  net.mode = 'regular';

  function settings(): Partial<GameSettings> {
    const p = DIFFICULTY_PRESETS.find((x) => x.id === cfg.preset)!;
    let focus: GameSettings['focus'] = null;
    if (cfg.area) {
      const sts = net.data.stations.filter((s) => s.district === cfg.area);
      focus = {
        lat: sts.reduce((a, s) => a + s.lat, 0) / sts.length,
        lon: sts.reduce((a, s) => a + s.lon, 0) / sts.length,
        radiusM: 2500,
        share: 0.7,
      };
    }
    return { slot: cfg.slot, network: 'regular', difficulty: p.id, stations: p.stations, distance: p.distance, minTransfers: p.minTransfers, countWait: true, focus };
  }

  // -------------------------------------------------------------- Einstellungen

  function renderSetup() {
    const district = cfg.area ? net.data.districts.find((d) => d.id === cfg.area) : undefined;
    setMobileMap(!!district);
    setMapBig(false);
    app.map.clear();
    if (district) app.map.showLearnArea({ rings: district.rings }, true, true);
    else app.map.overview();
    const solvedPct = mem.rounds ? Math.round((mem.solved / mem.rounds) * 100) : 0;
    panel.innerHTML = `
      <div class="learn training">
        <button class="link" id="back">← Zurück</button>
        <h2>🏋️ Training</h2>
        <p>Echte Strecken – ohne Zeitdruck und ohne Punkte. So lernst du dabei:</p>
        <ul class="facts">
          <li><b>Coach:</b> nach jeder Teilstrecke sofort Rückmeldung – richtig, Umweg oder falsche Richtung?</li>
          <li><b>„Was fährt hier ab?“</b> zeigt dir an jeder Station die Linien mit ihren Richtungen.</li>
          <li><b>Hilfen in Stufen:</b> erst Richtung, dann Verkehrsmittel, erste Linie, Umstiege – Lösung zuletzt.</li>
          <li><b>Am Ende:</b> Vergleich mit der schnellsten Verbindung und <i>warum</i> sie schneller ist.</li>
          <li><b>Wiederholung:</b> was nicht geklappt hat, kommt ${RETRY_AFTER} Strecken später nochmal.</li>
        </ul>
        <div class="setting"><span>Uhrzeit</span><div class="seg seg-wide">${TIME_SLOTS.map((t) => `<button data-slot="${t.id}" class="${t.id === cfg.slot ? 'on' : ''}">${t.short}</button>`).join('')}</div></div>
        <div class="setting"><span>Schwierigkeit</span><div class="seg seg-wide">${DIFFICULTY_PRESETS.map((d) => `<button data-preset="${d.id}" class="${d.id === cfg.preset ? 'on' : ''}">${d.label}</button>`).join('')}</div></div>
        <div class="setting"><span>Gebiet</span>
          <div class="seg seg-wide"><button data-area="all" class="${areaOn ? '' : 'on'}">🗺️ Ganz Wien</button><button data-area="focus" class="${areaOn ? 'on' : ''}">🎯 Schwerpunkt</button></div>
          ${
            areaOn
              ? `<select id="area"><option value="0" ${cfg.area ? '' : 'selected'}>Bezirk wählen …</option>${net.data.districts.map((d) => `<option value="${d.id}" ${d.id === cfg.area ? 'selected' : ''}>${d.id}. ${esc(d.name)}</option>`).join('')}</select>
                 <small class="hint">${cfg.area ? 'Die meisten Starts und Ziele liegen im Umkreis von 2,5 km um den Bezirk – der Rest aus ganz Wien.' : 'Wähle einen Bezirk – er wird auf der Karte markiert.'}</small>`
              : '<small class="hint">Starts und Ziele aus ganz Wien.</small>'
          }</div>
        <label class="toggle"><input type="checkbox" id="coach" ${cfg.coach ? 'checked' : ''}><span class="switch"></span>
          <span class="tl"><b>Coach-Rückmeldungen</b><small>Nach jeder Teilstrecke Feedback. Aus = selbst knobeln, Erklärung erst am Ende.</small></span></label>
        <div class="learn-card scope-card"><b>Dein Training</b>
          <small>${mem.rounds} Strecken · ${solvedPct} % gut gelöst · ${mem.retry.length} zum Wiederholen · ${mem.notes.length} gemerkt</small>
          ${mem.notes.length ? '<button class="link" id="notes">📌 Merkliste ansehen</button>' : ''}</div>
        <button class="btn btn-primary btn-big" id="start">Training starten</button>
        <button class="link reset-settings" id="resetCfg">↺ Einstellungen zurücksetzen</button>
      </div>`;
    panel.querySelector('#back')!.addEventListener('click', onBack);
    panel.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((b) =>
      b.addEventListener('click', () => {
        cfg.slot = b.dataset.slot as SlotId;
        persist();
        renderSetup();
      }),
    );
    panel.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        cfg.preset = b.dataset.preset as TrainCfg['preset'];
        persist();
        renderSetup();
      }),
    );
    panel.querySelectorAll<HTMLButtonElement>('[data-area]').forEach((b) =>
      b.addEventListener('click', () => {
        areaOn = b.dataset.area === 'focus';
        if (!areaOn) cfg.area = 0;
        persist();
        renderSetup();
      }),
    );
    panel.querySelector<HTMLSelectElement>('#area')?.addEventListener('change', (e) => {
      cfg.area = Number((e.target as HTMLSelectElement).value);
      persist();
      renderSetup();
    });
    panel.querySelector<HTMLInputElement>('#coach')!.addEventListener('change', (e) => {
      cfg.coach = (e.target as HTMLInputElement).checked;
      persist();
    });
    panel.querySelector('#notes')?.addEventListener('click', renderNotes);
    panel.querySelector('#resetCfg')!.addEventListener('click', () => {
      Object.assign(cfg, DEFAULT_TRAINING);
      areaOn = cfg.area > 0;
      persist();
      renderSetup();
    });
    panel.querySelector('#start')!.addEventListener('click', () => {
      prefetch = null;
      sessionRounds = 0;
      void nextRound();
    });
  }

  // -------------------------------------------------------------- Runde

  /** Nächste Strecke: fällige Wiederholung oder neue (ggf. schon vorab geladen) */
  async function nextRound() {
    setMobileMap(true);
    setMapBig(false);
    for (const r of mem.retry) r.due--;
    const due = mem.retry.find((r) => r.due <= 0);
    panel.innerHTML = loadingHtml(due ? 'Wiederholung wird geladen …' : 'Strecke wird gesucht …', 'Die Wiener-Linien-Auskunft wird für mehrere Abfahrtszeiten abgefragt.');
    try {
      round = due ? await api.trainingRound(settings(), { from: due.from, to: due.to }) : await (prefetch ?? api.trainingRound(settings()));
      isRetry = !!due;
      if (due) due.due = RETRY_AFTER; // falls die Runde abgebrochen wird
    } catch (e) {
      toast((e as Error).message);
      prefetch = null;
      renderSetup();
      return;
    }
    prefetch = null;
    persist();
    startRound();
  }

  function startRound() {
    const r = round!;
    sessionRounds++;
    coach = [];
    hintsUsed = [];
    legCount = 0;
    lastDraft = '';
    const from = net.station(r.from.id);
    const to = net.station(r.to.id);
    app.map.clear();
    app.map.showEndpoints(r.from, r.to, true);
    // alten Builder vergessen, bevor der neue (der beim Erzeugen schon zeichnet) entsteht –
    // sonst landet die Route der letzten Strecke wieder auf der Karte
    builder = null;
    if (cfg.coach)
      coach.push({ kind: 'info', text: `Los geht's! ${to.name} liegt im ${compass(from, to)} von ${from.name}. Schau unter „Was fährt hier ab?“, welche Linien in diese Richtung fahren.` });
    builder = new RouteBuilder(net, from, to, null, onBuilderChange, () => void submit());
    renderRound();
  }

  /** Builder hat sich geändert: neue Teilstrecke → Feedback; neue Linie gewählt → Richtungen erklären */
  function onBuilderChange() {
    if (!builder || !round) return;
    const b = builder;
    app.map.showDraft(b.segments(), b.transferPoints());
    if (cfg.coach) {
      if (b.legs.length > legCount) {
        const i = b.legs.length - 1;
        const before = i === 0 ? net.station(round.from.id) : net.station(b.legs[i - 1].to);
        coach.unshift(...legFeedback(b.legs[i], i, before, net.station(round.to.id), round.routes).reverse());
      }
      const d = b.draft;
      const key = d ? `${d.line.id}@${d.board}` : '';
      if (d && key !== lastDraft) coach.unshift({ kind: 'info', text: lineDirections(d.line, net.station(d.board)) });
      lastDraft = key;
    }
    legCount = b.legs.length;
    renderAside();
  }

  let asideEl: HTMLElement | null = null;

  function renderRound() {
    const r = round!;
    panel.innerHTML = '';
    const head = h(
      'div',
      { class: 'round-head' },
      `<button class="link" id="stop">← Training beenden</button>
       <div class="when">🏋️ Strecke ${sessionRounds}${isRetry ? ' · <b class="retry">🔁 Wiederholung</b>' : ''} · ${esc(r.when)}</div>
       <div class="od"><div class="od-row"><span class="pin-dot a">A</span><b>${esc(r.from.name)}</b></div>
       <div class="od-row"><span class="pin-dot b">B</span><b>${esc(r.to.name)}</b></div></div>`,
    );
    head.querySelector('#stop')!.addEventListener('click', () => {
      builder = null;
      renderSetup();
    });
    asideEl = h('div', { class: 'train-aside' });
    panel.append(head, asideEl, builder!.el);
    renderAside();
  }

  /** Coach, "Was fährt hier ab?" und Hilfen – ändern sich mit jeder Eingabe */
  function renderAside() {
    if (!asideEl || !builder || !round) return;
    const b = builder;
    const pos = b.position;
    const deps = departuresFrom(pos, ALL_MODES);
    const nextHint = HINTS.find((x) => !hintsUsed.includes(x.id));
    const openDeps = asideEl.querySelector<HTMLDetailsElement>('details.deps-box')?.open ?? false;
    asideEl.innerHTML = `
      ${coach.length ? `<div class="coach">${coach.slice(0, 3).map((m) => `<p class="cm cm-${m.kind}">${esc(m.text)}</p>`).join('')}</div>` : ''}
      <details class="deps-box" ${openDeps ? 'open' : ''}><summary>🚏 Was fährt ab ${esc(pos.name)}? <small>${deps.length} Linien</small></summary>
        <ul class="deps">${deps
          .map(
            (d) => `<li><button class="line-opt" data-line="${esc(d.line.id)}" title="diese Linie nehmen">${lineChip(d.line.mode, d.line.id, d.line.color)}</button>
              <span>${d.dirs.map((x) => `→ ${esc(x.to)}${x.via ? ` <small>über ${esc(x.via)}</small>` : ''}`).join('<br>')}</span></li>`,
          )
          .join('')}</ul></details>
      <div class="hints">${hintsUsed.map((id) => `<p class="hint-used">${esc(hintText(id, pos, net.station(round!.to.id), round!.routes[0]))}</p>`).join('')}
        ${nextHint ? `<button class="tip-btn" id="hint">${nextHint.label}</button>` : ''}</div>`;
    asideEl.querySelectorAll<HTMLElement>('[data-line]').forEach((el) =>
      el.addEventListener('click', () => {
        const line = net.lines.get(el.dataset.line!) as Line;
        b.selectLine(line);
      }),
    );
    asideEl.querySelector('#hint')?.addEventListener('click', () => {
      if (nextHint) hintsUsed.push(nextHint.id);
      renderAside();
    });
  }

  // -------------------------------------------------------------- Auswertung

  async function submit() {
    if (!builder || !round) return;
    const legs = builder.userLegs();
    if (!legs.length) return toast('Gib mindestens eine Linie an.');
    builder.lock();
    panel.innerHTML = loadingHtml('Route wird ausgewertet …');
    let res: TrainingResult;
    try {
      res = await api.trainingEvaluate(round.id, legs);
    } catch (e) {
      toast((e as Error).message);
      renderSetup();
      return;
    }
    renderReview(res);
  }

  function renderReview(res: TrainingResult) {
    const r = round!;
    const best = r.routes[0];
    const delta = res.durationMin != null ? res.durationMin - best.medianMin : null;
    const solved = !res.error && delta != null && (res.matchedRank === 0 || delta <= 1) && hintsUsed.length < 3;
    // Lernstand
    mem.rounds++;
    if (solved) mem.solved++;
    mem.retry = mem.retry.filter((x) => !(x.from === r.from.id && x.to === r.to.id));
    if (!solved) mem.retry.push({ from: r.from.id, to: r.to.id, due: RETRY_AFTER });
    persist();

    // Netzkarte blass als Hintergrund unter den Routen
    netLayer().render(netView({ dimAll: true, hubs: false, labels: false }));
    app.map.showReveal(r.routes.map(smoothRoute), res.route ? [{ key: 'me', name: 'Du', route: smoothRoute(res.route), isMe: true }] : [], [r.routes[0].key, ...(res.route ? ['me'] : [])]);
    setMapBig(false);

    let verdict: string;
    if (res.error) verdict = `<p class="err">${esc(res.error)}</p>`;
    else if (res.matchedRank === 0 || (delta != null && delta <= 0)) verdict = '<p class="good">🎉 Perfekt – das ist die schnellste Verbindung!</p>';
    else if (delta != null && delta <= 3) verdict = `<p class="good">Sehr gut – nur ${delta} min langsamer als die schnellste.</p>`;
    else verdict = `<p class="err">${delta} min langsamer als die schnellste Verbindung.</p>`;

    const why = res.route && delta != null && delta > 1 ? explain(res.route, best) : [];
    const note = `${r.from.name} → ${r.to.name}: ${routeSentence(best)} (${best.medianMin} min)`;
    const alreadySaved = mem.notes.some((n) => n.from === r.from.id && n.to === r.to.id);

    panel.innerHTML = `
      <div class="learn training">
        <h2>Auswertung${isRetry ? ' <small class="retry">🔁 Wiederholung</small>' : ''}</h2>
        <div class="result-card ${solved ? 'great' : delta != null && delta <= 3 ? 'ok' : 'meh'}"><div class="mine">
          ${res.route ? `<div class="chainline">${chain(res.route.legs)}<b>${res.durationMin} min</b></div><details class="my-detail"><summary>Deine Route im Detail</summary>${routeDetails(res.route, starMini)}</details>` : ''}
          ${verdict}
          ${hintsUsed.length ? `<small>mit ${hintsUsed.length} Hilfe${hintsUsed.length > 1 ? 'n' : ''}</small>` : ''}
        </div></div>
        ${why.length ? `<h3>Warum ist die andere schneller?</h3><ul class="why">${why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <h3>So geht's am schnellsten</h3>
        <div class="learn-card"><p class="sentence">${esc(note)}</p>
          <button class="btn btn-ghost" id="save" ${alreadySaved ? 'disabled' : ''}>${alreadySaved ? '📌 gemerkt' : '📌 In die Merkliste'}</button></div>
        ${!solved ? `<p class="muted">🔁 Diese Strecke kommt in ${RETRY_AFTER} Strecken nochmal – dann ohne Hilfe probieren!</p>` : isRetry ? '<p class="good">✔ Wiederholung geschafft – die sitzt jetzt.</p>' : ''}
        <h3>Top-Verbindungen</h3>
        <ol class="route-list">${r.routes
          .slice(0, 4)
          .map((x, i) => `<li data-key="${esc(x.key)}" class="expandable"><div class="rrow"><span class="rank">${i + 1}</span><div class="rmain"><div class="chainline">${chain(x.legs)}</div></div><div class="rtime"><b>${x.medianMin} min</b></div><span class="chev">▾</span></div><div class="rdetail">${routeDetails(x, starMini)}</div></li>`)
          .join('')}</ol>
        <div class="learn-actions"><button class="btn btn-primary" id="next">Nächste Strecke →</button><button class="btn btn-ghost" id="setup">Einstellungen</button></div>
      </div>`;
    const list = panel.querySelector<HTMLElement>('.route-list')!;
    makeExpandable(list);
    list.addEventListener('mouseover', (e) => app.map.highlight((e.target as HTMLElement).closest<HTMLElement>('li[data-key]')?.dataset.key ?? null));
    list.addEventListener('mouseleave', () => app.map.highlight(null));
    panel.querySelector('#save')!.addEventListener('click', (e) => {
      mem.notes.unshift({ from: r.from.id, to: r.to.id, text: note, min: best.medianMin, date: new Date().toISOString().slice(0, 10) });
      persist();
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true;
      b.textContent = '📌 gemerkt';
    });
    panel.querySelector('#next')!.addEventListener('click', () => void nextRound());
    panel.querySelector('#setup')!.addEventListener('click', renderSetup);
    // nächste Strecke schon im Hintergrund laden
    if (!mem.retry.some((x) => x.due <= 1)) {
      prefetch = api.trainingRound(settings());
      prefetch.catch(() => (prefetch = null));
    }
  }

  // -------------------------------------------------------------- Merkliste

  function renderNotes() {
    panel.innerHTML = `
      <div class="learn training">
        <button class="link" id="back">← Zurück</button>
        <h2>📌 Merkliste</h2>
        <p class="muted">Deine gemerkten schnellsten Verbindungen.</p>
        <ul class="notes">${mem.notes
          .map((n, i) => `<li><span>${esc(n.text)}</span><button class="icon-btn" data-rm="${i}" title="entfernen">✕</button></li>`)
          .join('')}</ul>
      </div>`;
    panel.querySelector('#back')!.addEventListener('click', renderSetup);
    panel.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        mem.notes.splice(Number(b.dataset.rm), 1);
        persist();
        mem.notes.length ? renderNotes() : renderSetup();
      }),
    );
  }

  renderSetup();
  return {
    destroy: () => {
      setMapBig(false);
      app.map.clear();
    },
  };
}
