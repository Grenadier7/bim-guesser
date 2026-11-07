import type { Guesses, LatLon, RoundPublic, Station, TipKind, TipResult } from '../../../shared/types.ts';
import { icon } from '../icons.ts';
import { RESTRICTIONS, TIPS, XTREME_LEVELS, baseLimitSec, restrictionAllowsLine, fmtDuration, fmtTimeLeft, locatePoints, restrictionLabel, scoringUnit, tipShare } from '../../../shared/rules.ts';
import { api } from '../api.ts';
import { RouteBuilder } from '../builder.ts';
import { distM, fmtDist } from '../net.ts';
import { netLayer, netView, smoothPath } from '../netmap.ts';
import { app, routeState, currentRound, isHost, serverNow, setMapBig } from '../store.ts';
import { ask, esc, h, lineChip, modeChip, toast } from '../ui.ts';
import { hostBar } from './host.ts';
import { UNDERGROUND, blockedDistricts, ruleSummary, type RuleRound } from '../../../shared/challengeRules.ts';
import { MODE_ICON, isNightSlot } from '../../../shared/rules.ts';
import type { Mode } from '../../../shared/types.ts';
import { nearestWater } from '../../../shared/water.ts';
import { bridgesNow, loadBridges, loadWater, waterNow } from '../challenges.ts';
import { FUTURE_LINES } from '../../../shared/challenges.ts';
import type { Screen } from './screen.ts';

type View = 'locate' | 'route' | 'waiting';

export function roundScreen(panel: HTMLElement): Screen {
  // während des Ratens kein Netz – die Netzkarte aus der letzten Auflösung wäre eine Gratis-Hilfe
  netLayer().clear();
  const s = routeState();
  const round = currentRound()!;
  const idx = round.index;
  const auth = app.session!;
  const { playerId } = auth;
  app.net.mode = s.settings.network;
  const from = app.net.ensure(round.from!);
  const to = app.net.ensure(round.to!);
  const multi = s.players.length > 1;
  // X-treme: Haltestellen eintippen, keine Route auf der Karte, je nach Stufe ohne Namen / ohne Karte
  const xt = s.settings.xtreme ?? 'off';
  const xtreme = xt !== 'off';
  const showNames = xt !== 'noNames';
  const showMap = xt !== 'noMap';

  const guesses: Guesses = { from: null, to: null };
  let target: 'from' | 'to' = 'from';
  let view: View = round.submitted.includes(playerId) ? 'waiting' : s.settings.locate ? 'locate' : 'route';
  let tips: TipResult[] = [];
  let submitting = false;
  let submittedAt: number | null = null;
  // Der Builder ruft onChange schon im Konstruktor auf – daher erst deklarieren, dann zuweisen
  let builder: RouteBuilder | undefined;
  let alive = true;
  /** Zielnetz 2040: neue/geänderte Linien auf der Karte */
  let futureShown = false;
  // Tages-Challenges: Regeln, Ziele/Punkte, Wasser
  const rules: RuleRound | undefined = round.restriction
    ? {
        restriction: round.restriction,
        banned: round.bannedLines,
        required: round.required,
        entryLines: round.umland ? [...new Set(round.umland.options.flatMap((o) => o.lines))] : undefined,
        entryTown: round.umland?.town,
        districts: round.districts,
        bridges: round.bridges,
      }
    : undefined;
  if (round.bridges && !bridgesNow()) void loadBridges().then(() => alive && render());
  // Hubschrauber: H1–H3 als Linien dieser Runde (A ↔ B)
  app.net.setRoundLines((round.helis ?? []).map((x) => ({ id: x.id, mode: 'H' as const, color: '#c2185b', patterns: [[x.a.id, x.b.id], [x.b.id, x.a.id]], nets: ['cr', 'cr'] })));
  const targets = round.targets?.map((t) => app.net.ensure(t));
  const waypoints = round.waypoints?.map((t) => app.net.ensure(t));
  if (round.water && !waterNow()) void loadWater().then(() => alive && render());
  builder = new RouteBuilder(app.net, from, to, round.restriction, () => drawDraft(), () => submit(false), round.bannedLines, {
    typed: xtreme,
    hideStart: !showNames,
    // ohne Namen / ohne Karte: keine Entfernungen verraten
    hideDistances: !showNames || !showMap,
    rules,
    targets,
    waypoints,
    water: round.water ? (p) => (waterNow() ? nearestWater(waterNow()!, p, round.water) : { name: 'Wasser', dist: 0, lat: p.lat, lon: p.lon }) : undefined,
    umland: round.umland,
    idle: round.idle,
    scooter: s.settings.scooter,
  });
  const b = builder;

  // Grundgerüst
  const head = h('div', { class: 'round-head' });
  const strip = h('div', { class: 'player-strip' });
  let hostBox = hostBar();
  const body = h('div', { class: 'round-body' });
  panel.innerHTML = '';
  panel.append(hostBox, head, strip, body);
  const refreshHost = () => {
    const next = hostBar();
    hostBox.replaceWith(next);
    hostBox = next;
  };
  panel.scrollTop = 0;

  head.innerHTML = `
    ${
      xtreme
        ? `<div class="xtreme-banner">⚡ X-TREME <span>${esc(XTREME_LEVELS.find((x) => x.id === xt)!.label)}</span><small>${
            round.limitSec ? 'doppelte Zeit · ' : ''
          }Haltestellen selbst eintippen${showNames ? '' : ' · keine Namen'}${showMap ? '' : ' · leere Karte'}</small></div>`
        : ''
    }
    <div class="when">🕒 ${esc(round.when ?? '')}${s.settings.network === 'current' ? ' · aktuelles Netz' : ''}${s.settings.countWait ? ` · ${esc(scoringUnit(s.settings))}` : ''}</div>
    ${challengeHead()}
    ${
      round.restriction && !s.settings.challenge
        ? `<div class="restriction">${RESTRICTIONS[round.restriction].icon} <b>${esc(restrictionLabel(round.restriction, round.bannedLines))}</b> – ${
            round.restriction === 'banLines' ? 'finde eine andere Verbindung.' : RESTRICTIONS[round.restriction].hint
          }${round.limitSec && baseLimitSec(s.settings) && round.limitSec > baseLimitSec(s.settings)! ? ` <small>⏱ +${fmtDuration(round.limitSec - baseLimitSec(s.settings)!)} Extrazeit</small>` : ''}</div>`
        : ''
    }
    <div class="od"><div class="od-row"><span class="pin-dot a">A</span><b>${showNames ? esc(from.name) : 'Start <small>(nur auf der Karte)</small>'}</b>${round.umland ? ' <small>(Niederösterreich)</small>' : ''}</div>
    ${goalRows()}</div>`;
  // lange Regel (am Handy auf 3 Zeilen gekürzt): antippen zeigt alles
  const rule = head.querySelector<HTMLElement>('.challenge-rule');
  if (rule) {
    // passt der Text in 3 Zeilen, ändert das Kürzen nichts
    rule.classList.add('clamped');
    rule.title = 'Antippen für den ganzen Text';
    rule.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      rule.classList.toggle('open');
    });
  }
  // Zielnetz 2040: neue/geänderte Linien auf der Karte ein-/ausblenden
  head.querySelector<HTMLButtonElement>('#future-map')?.addEventListener('click', (e) => {
    futureShown = !futureShown;
    (e.currentTarget as HTMLButtonElement).textContent = futureShown ? 'Zielnetz ausblenden' : '🗺️ Zielnetz einblenden';
    render();
  });

  /** Ziel-Zeilen: B, „eines von 3 Zielen“, „alle 3 Punkte“ oder „nächstes Wasser“ */
  function goalRows(): string {
    if (targets) return `<div class="od-row"><span class="pin-dot b">🎯</span><span>Eines dieser Ziele: ${targets.map((t, i) => `<b>${i + 1}. ${esc(t.name)}</b>`).join(' · ')}</span></div>`;
    if (waypoints) return `<div class="od-row"><span class="pin-dot b">📍</span><span>Alle befahren, Reihenfolge egal: ${waypoints.map((t, i) => `<b>${i + 1}. ${esc(t.name)}</b>`).join(' · ')}</span></div>`;
    if (round.water === 'bath') return '<div class="od-row"><span class="pin-dot b">🩱</span><span><b>Zum nächsten Bad</b> – Strandbad, Freibad oder Hallenbad (blau auf der Karte). Gewertet wird bis dorthin, auch der Fußweg.</span></div>';
    if (round.water) return '<div class="od-row"><span class="pin-dot b">🏊</span><span><b>Zum nächsten Wasser</b> – Donau, Donaukanal, Wienfluss, Alte Donau, Liesing oder ein Bad (blau auf der Karte). Gewertet wird bis dorthin, auch der Fußweg.</span></div>';
    return `<div class="od-row"><span class="pin-dot b">B</span><b>${showNames ? esc(to.name) : 'Ziel <small>(nur auf der Karte)</small>'}</b></div>`;
  }

  /** Regel der Challenge (verständlich, mit Pflicht-Linien als Chips) */
  function challengeHead(): string {
    if (s.settings.task === 'future')
      return `<div class="challenge-rule">🔮 Zielnetz 2040 – neue und geänderte Linien: ${FUTURE_LINES.filter((id) => app.net.lines.has(id))
        .map((id) => {
          const l = app.net.lines.get(id)!;
          return lineChip(l.mode, l.id, l.color);
        })
        .join('')} <button class="link" id="future-map">${futureShown ? 'Zielnetz ausblenden' : '🗺️ Zielnetz einblenden'}</button></div>`;
    if (round.helis?.length)
      return `<div class="challenge-rule">🚁 Hubschrauber – wie eine Linie eintippen (Flug inkl. Einsteigen, danach weiter mit den Öffis): ${round.helis
        .map((x) => `${lineChip('H', x.id, '#c2185b')} ${esc(x.a.name)} ↔ ${esc(x.b.name)} · ${x.min} min`)
        .join(' · ')}</div>`;
    if (!rules || !s.settings.challenge) return '';
    const text = ruleSummary(rules);
    if (!text) return '';
    const chips = rules.required?.length
      ? ` <span class="chips">${rules.required.map((id) => {
          const l = app.net.lines.get(id);
          return l ? lineChip(l.mode, l.id, l.color) : esc(id);
        }).join('')}</span>`
      : '';
    const extra = round.limitSec && baseLimitSec(s.settings) && round.limitSec > baseLimitSec(s.settings)! ? ` <small>⏱ +${fmtDuration(round.limitSec - baseLimitSec(s.settings)!)} Extrazeit</small>` : '';
    return `<div class="challenge-rule">${esc(text)}${chips}${extra}</div>`;
  }

  // nach Neuladen: bereits genutzte Tipps holen
  if (s.settings.tips !== 'off')
    api
      .tips(auth, idx)
      .then((t) => {
        tips = t;
        if (view === 'route') render();
      })
      .catch(() => {});

  // -------------------------------------------------------------- Ansichten

  function render() {
    renderStrip();
    app.map.stopLocate();
    // Handy: zum Orten die Karte groß machen, danach wieder normal
    setMapBig(view === 'locate');
    if (view === 'locate') return renderLocate();
    if (s.settings.task === 'future' && showMap) showFuture();
    if (showMap && (targets || waypoints || round.water || round.umland || round.helis || round.bridges || s.settings.task === 'future' || (rules && blockedDistricts(rules).length) || round.restriction === 'sunny')) showChallengeMap(true);
    else if (showMap) app.map.showEndpoints(round.from!, round.to!, true, showNames);
    else app.map.clear();
    const transferTip = tips.find((t) => t.kind === 'transfers');
    // ohne Karte: auch keine Umstiegs-Punkte · ohne Namen: Punkte ohne Beschriftung
    app.map.showTransferHints(showMap && transferTip?.kind === 'transfers' ? transferTip.stops : []);
    if (view === 'route') renderRoute();
    else renderWaiting();
  }

  function renderStrip() {
    const st = routeState();
    const r = currentRound();
    if (!multi || !r) {
      strip.innerHTML = '';
      return;
    }
    strip.innerHTML = st.players
      .map((p) => {
        const done = r.submitted.includes(p.id);
        return `<span class="pchip ${done ? 'done' : ''} ${p.connected ? '' : 'offline'}">${done ? '✓' : '…'} ${esc(p.name)}</span>`;
      })
      .join('');
  }

  function renderLocate() {
    app.map.clear();
    app.map.overview();
    app.map.showGuesses(guesses);
    app.map.startLocate((ll: LatLon) => {
      guesses[target] = ll;
      if (target === 'from' && !guesses.to) target = 'to';
      renderLocate();
    });
    const step = (k: 'from' | 'to', st: Station, letter: string) =>
      `<button class="locate-step ${target === k ? 'on' : ''} ${guesses[k] ? 'set' : ''}" data-t="${k}">
        <span class="pin-dot ${letter === 'A' ? 'a' : 'b'}">${letter}</span><span>${esc(st.name)}</span><small>${guesses[k] ? '✓ gesetzt' : 'tippen'}</small></button>`;
    body.innerHTML = `
      <div class="locate">
        <h2>📍 Wo liegt das?</h2>
        <p>Tippe auf der Karte, wo du <b>${target === 'from' ? 'den Start' : 'das Ziel'}</b> vermutest. Bis 250 m daneben gibt's die vollen 75 Punkte je Station.</p>
        ${step('from', from, 'A')}${step('to', to, 'B')}
        <button class="btn btn-primary btn-big" id="confirm" ${guesses.from && guesses.to ? '' : 'disabled'}>Bestätigen</button>
        <button class="link" id="skip">Überspringen (0 Punkte)</button>
      </div>`;
    body.querySelectorAll<HTMLButtonElement>('[data-t]').forEach((b) =>
      b.addEventListener('click', () => {
        target = b.dataset.t as 'from' | 'to';
        renderLocate();
      }),
    );
    body.querySelector('#confirm')!.addEventListener('click', () => {
      view = 'route';
      render();
      flashGuesses();
    });
    body.querySelector('#skip')!.addEventListener('click', () => {
      guesses.from = null;
      guesses.to = null;
      view = 'route';
      render();
    });
  }

  /** Schätzungen kurz zeigen und dann ausblenden – sonst stören sie beim Route-Suchen */
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function flashGuesses() {
    if (!guesses.from && !guesses.to) return;
    app.map.showGuesses(guesses, { from: round.from!, to: round.to! });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => app.map.clearGuesses(), 4000);
  }

  function locateSummary(): string {
    if (!s.settings.locate) return '';
    const part = (g: LatLon | null, st: Station, letter: string) => {
      if (!g) return `${letter}: –`;
      const d = distM({ lat: g[0], lon: g[1] }, st);
      return `${letter}: ${fmtDist(d)} daneben <b>+${locatePoints(d)}</b>`;
    };
    const show = guesses.from || guesses.to ? ' <button class="link" data-act="flash">zeigen</button>' : '';
    return `<div class="locate-sum">📍 ${part(guesses.from, from, 'A')} · ${part(guesses.to, to, 'B')}${show}</div>`;
  }

  function renderRoute() {
    body.innerHTML = '';
    body.insertAdjacentHTML('beforeend', locateSummary());
    body.querySelector('[data-act=flash]')?.addEventListener('click', flashGuesses);
    if (s.settings.tips !== 'off') body.append(renderTips());
    body.append(b.el);
    // aufgeben: für diese Runde keine Route (die anderen spielen weiter)
    const give = h('button', { class: 'link give-up' }, '🏳️ Aufgeben');
    give.addEventListener('click', () => void giveUp());
    body.append(give);
    drawDraft();
  }

  /** Joker-Leiste offen/zu (über Neuzeichnen hinweg) */
  let tipsOpen: boolean | null = null;

  function renderTips(): HTMLElement {
    const box = h('div', { class: 'tips' });
    const used = new Set(tips.map((t) => t.kind));
    const btns = (Object.keys(TIPS) as TipKind[])
      .map(
        (k) =>
          `<button class="tip-btn" data-tip="${k}" ${used.has(k) ? 'disabled' : ''}>${icon('bulb', 15)} ${esc(TIPS[k].label)} <small>−${Math.round(tipShare(k, s.settings.tips) * 100)} %</small></button>`,
      )
      .join('');
    const results = tips
      .map((t) => {
        if (t.kind === 'modeChain')
          return `<div class="tip-result"><span>Schnellste Route:</span> ${t.modes.map(modeChip).join('<span class="sep">›</span>')}
                  <small>${t.transfers} Umstieg${t.transfers === 1 ? '' : 'e'} · ca. ${t.medianMin} min</small></div>`;
        if (t.kind === 'transfers') {
          if (!t.stops.length) return '<div class="tip-result"><span>Umstiege:</span> keine – Direktverbindung!</div>';
          // ohne Namen: nur die Linien (von … in …)
          const stop = (x: (typeof t.stops)[number]) =>
            showNames && x.name
              ? `⇄ ${esc(x.name)}`
              : x.from && x.to
                ? `<span class="tip-tr">${lineChip(x.from.mode, x.from.id, x.from.color)} ⇄ ${lineChip(x.to.mode, x.to.id, x.to.color)}</span>`
                : '⇄ ?';
          return `<div class="tip-result"><span>Umstiege:</span> ${t.stops.map(stop).join(showNames ? ', ' : ' ')}${showMap ? ' <small>(auf der Karte)</small>' : ''}</div>`;
        }
        // Linien antippen → direkt als nächste Teilstrecke wählen (Wunsch N-5)
        return `<div class="tip-result"><span>${t.kind === 'startLines' ? 'Am Start' : 'Am Ziel'}${showNames && t.station ? ` (${esc(t.station)})` : ''}:</span>
                <div class="chips">${t.lines
                  .map((l) => `<button class="chip-btn" data-tip-line="${esc(l.id)}" title="${esc(l.id)} als nächste Teilstrecke wählen">${lineChip(l.mode, l.id, l.color)}</button>`)
                  .join('')}</div></div>`;
      })
      .join('');
    // Joker ausklappbar: am Handy zu (eine Zeile statt vier großer Knöpfe), am Computer offen; Ergebnisse immer sichtbar
    const free = (Object.keys(TIPS) as TipKind[]).filter((k) => !used.has(k)).length;
    tipsOpen ??= matchMedia('(min-width: 900px)').matches;
    box.innerHTML = `${free ? `<details class="tips-drawer" ${tipsOpen ? 'open' : ''}><summary>${icon('bulb', 16)} Joker <small>(${free} übrig – kosten Punkte)</small></summary><div class="tip-btns">${btns}</div></details>` : ''}${results}`;
    box.querySelector('details')?.addEventListener('toggle', (e) => (tipsOpen = (e.target as HTMLDetailsElement).open));
    box.querySelectorAll<HTMLButtonElement>('[data-tip-line]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const line = app.net.lines.get(btn.dataset.tipLine!);
        if (!line) return;
        if (b.locked) return toast('Schon abgegeben.', 'info');
        if (!restrictionAllowsLine(round.restriction, round.bannedLines, line)) return toast(`${line.id} ist in dieser Runde nicht erlaubt.`, 'info');
        b.selectLine(line);
        b.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }),
    );
    box.querySelectorAll<HTMLButtonElement>('[data-tip]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          tips.push(await api.tip(auth, idx, b.dataset.tip as TipKind));
          render();
        } catch (e) {
          toast((e as Error).message);
          b.disabled = false;
        }
      }),
    );
    return box;
  }

  function renderWaiting() {
    const r = currentRound()!;
    const st = routeState();
    const elapsed = submittedAt && r.startedAt ? (submittedAt - r.startedAt) / 1000 : null;
    const open = st.players.filter((p) => !r.submitted.includes(p.id) && p.connected);
    body.innerHTML = `
      <div class="waiting">
        <div class="big-check">✓</div>
        <h2>Abgegeben${elapsed != null ? ` <small>⏱ ${fmtTimeLeft(elapsed, r.limitSec)}</small>` : ''}</h2>
        ${
          open.length
            ? `<p>Warte auf ${open.map((p) => `<b>${esc(p.name)}</b>`).join(', ')} …</p>
               ${isHost() ? '<button class="btn btn-ghost" id="force">Jetzt auflösen</button>' : ''}`
            : `<div class="loading"><div class="spinner"></div><p>Routen werden ausgewertet …</p></div>`
        }
      </div>`;
    body.querySelector('#force')?.addEventListener('click', async () => {
      try {
        await api.forceReveal(auth, idx);
      } catch (e) {
        toast((e as Error).message);
      }
    });
    drawDraft();
  }

  function drawDraft() {
    // X-treme: die eigene Route wird erst bei der Auflösung gezeigt
    if (builder && view !== 'locate' && !xtreme) app.map.showDraft(builder.segments(), builder.transferPoints());
    // „3 Punkte“: befahrene Punkte abhaken
    if (builder && (waypoints || round.restriction === 'visitDistricts') && view !== 'locate') showChallengeMap(false);
  }

  function showChallengeMap(fit: boolean) {
    const missing = new Set((builder?.missingWaypoints() ?? waypoints ?? []).map((w) => w.id));
    app.map.showChallenge({
      from: round.from!,
      to: targets || waypoints || round.water ? null : round.to,
      targets: round.targets,
      waypoints: round.waypoints?.map((w) => ({ s: w, done: !missing.has(w.id) })),
      // „Ab ins Bad“: nur die Bäder
      water: round.water && waterNow() ? (round.water === 'bath' ? { waters: [], baths: waterNow()!.baths } : waterNow()) : null,
      inner: rules && blockedDistricts(rules).length ? app.net.data.districts.filter((d) => blockedDistricts(rules).includes(d.id)) : undefined,
      // Bezirkstour: grüne Bezirke, abgehakt, sobald die Route hindurchführt
      visit:
        round.restriction === 'visitDistricts'
          ? app.net.data.districts.filter((d) => round.districts?.includes(d.id)).map((d) => ({ d, done: !(builder?.missingDistricts() ?? round.districts ?? []).includes(d.id) }))
          : undefined,
      underground: round.restriction === 'sunny' ? undergroundPaths() : undefined,
      // Umland: Wien umrahmt – man startet draußen
      outline: round.umland ? app.net.data.districts : undefined,
      helis: round.helis,
      bridges: round.bridges ? bridgeViews() : undefined,
      fit,
    });
  }

  /** Zielnetz 2040: das Netz wie in den Lernkarten – neue/geänderte Linien hervorgehoben (mit Nummern), neue Stationen markiert */
  function showFuture() {
    if (!futureShown) return void netLayer().clear();
    netLayer().render(netView({ focus: new Set(FUTURE_LINES.filter((id) => app.net.lines.has(id))), marks: app.net.data.stations.filter((x) => x.id.startsWith('z40-')), allLabels: true }));
  }

  /** Brückenkenner: je Brücke die Abschnitte (Farbe/Icon des Verkehrsmittels) und welche Linien darüber fahren */
  function bridgeViews() {
    return (bridgesNow()?.bridges ?? []).map((b) => {
      const byMode = new Map<Mode, Set<string>>();
      const segs = b.segs.flatMap(([x, y, modes]) => {
        const a = app.net.station(x);
        const c = app.net.station(y);
        if (!a || !c) return [];
        // tagsüber keine Nachtbusse
        const here = new Map<Mode, { line: string; from: string; to: string }>();
        for (const l of app.net.lines.values()) {
          if (!modes.includes(l.mode) || (l.mode === 'N' && !isNightSlot(s.settings.slot))) continue;
          for (const p of app.net.patterns(l))
            p.forEach((id, i) => {
              if ((id === x && p[i + 1] === y) || (id === y && p[i + 1] === x)) {
                byMode.set(l.mode, (byMode.get(l.mode) ?? new Set()).add(l.id));
                if (!here.has(l.mode)) here.set(l.mode, { line: l.id, from: id, to: p[i + 1] });
              }
            });
        }
        // Verlauf wie auf der Karte sonst (geglättet entlang der Linie)
        return [...here].map(([m, h]) => ({ mode: m, path: smoothPath(h.line, h.from, h.to, [[a.lat, a.lon], [c.lat, c.lon]]) as [number, number][] }));
      });
      const lines = [...byMode].map(([m, ids]) => `${MODE_ICON[m]} ${[...ids].sort((p, q) => p.localeCompare(q, 'de', { numeric: true })).join(', ')}`);
      return { name: b.name, river: b.river, lat: b.lat, lon: b.lon, modes: [...byMode.keys()], lines, segs };
    }).filter((b) => b.modes.length);
  }

  /** Sonnenschein: wo die Linien (grob) unter der Erde fahren – Abschnitte, die eine unterirdische Station berühren */
  function undergroundPaths(): { line: string; path: [number, number][] }[] {
    const out: { line: string; path: [number, number][] }[] = [];
    for (const [id, names] of Object.entries(UNDERGROUND)) {
      const l = app.net.lines.get(id);
      if (!l) continue;
      const seen = new Set<string>();
      for (const p of app.net.patterns(l))
        for (let i = 0; i + 1 < p.length; i++) {
          const a = app.net.station(p[i]);
          const b = app.net.station(p[i + 1]);
          if (id !== 'U3' && !names.includes(a.name) && !names.includes(b.name)) continue;
          const k = [a.id, b.id].sort().join();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ line: id, path: [[a.lat, a.lon], [b.lat, b.lon]] });
        }
    }
    return out;
  }

  // -------------------------------------------------------------- Abgabe

  /** für diese Runde aufgeben: keine Route, 0 Punkte – im Mehrspieler spielen die anderen weiter */
  async function giveUp() {
    if (submitting || view === 'waiting') return;
    if (!(await ask(multi ? 'Für diese Runde aufgeben? Du bekommst 0 Punkte, die anderen spielen weiter.' : 'Diese Runde aufgeben? Du bekommst 0 Punkte und siehst gleich die Lösung.', { title: 'Aufgeben', ok: 'Aufgeben', cancel: 'Weiter suchen', danger: true })))
      return;
    submitting = true;
    app.map.stopLocate();
    b.lock();
    submittedAt = serverNow();
    view = 'waiting';
    render();
    try {
      await api.submit(auth, idx, [], null, true);
    } catch (e) {
      toast((e as Error).message);
      if (currentRound()?.submitted.includes(playerId)) return;
      submitting = false;
      submittedAt = null;
      b.unlock();
      view = 'route';
      render();
    }
  }

  async function submit(auto: boolean) {
    if (submitting || view === 'waiting') return;
    const legs = b.userLegs();
    if (!legs.length && !auto && !s.settings.scooter) return toast('Gib mindestens eine Linie an.');
    // Challenge-Regel nicht erfüllt → nicht abgeben (bei Zeitablauf geht es trotzdem raus, zählt dann nicht)
    const why = b.submitProblem();
    if (why && !auto) return toast(why, 'info');
    submitting = true;
    app.map.stopLocate();
    b.lock();
    submittedAt = serverNow();
    view = 'waiting';
    render();
    try {
      await api.submit(auth, idx, legs, s.settings.locate ? guesses : null);
    } catch (e) {
      // Zeit abgelaufen: Auflösung kommt trotzdem über den Live-Kanal
      if (auto) return;
      toast((e as Error).message);
      // sonst (Netzfehler, Server kurz weg …): nicht auf „Abgegeben“ hängen bleiben – nochmal abgeben können (H-05)
      if (currentRound()?.submitted.includes(playerId)) return;
      submitting = false;
      submittedAt = null;
      b.unlock();
      view = 'route';
      render();
    }
  }

  render();

  return {
    update() {
      const r = currentRound();
      if (!r || r.index !== idx) return;
      if (view !== 'waiting' && r.submitted.includes(playerId)) {
        view = 'waiting';
        render();
        return;
      }
      renderStrip();
      refreshHost();
      if (view === 'waiting') renderWaiting();
    },
    tick() {
      const r: RoundPublic | null = currentRound();
      if (!r?.deadline || r.pausedAt || view === 'waiting') return;
      if (serverNow() >= r.deadline) {
        toast('Zeit abgelaufen – deine Route wird so abgegeben.', 'info');
        void submit(true);
      }
    },
    destroy() {
      alive = false;
      clearTimeout(flashTimer);
      app.map.stopLocate();
      setMapBig(false);
    },
  };
}
