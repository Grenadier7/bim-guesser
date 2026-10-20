import type { Guesses, LatLon, RoundPublic, Station, TipKind, TipResult } from '../../../shared/types.ts';
import { RESTRICTIONS, TIPS, XTREME_LEVELS, baseLimitSec, restrictionAllowsLine, fmtDuration, fmtTimeLeft, locatePoints, restrictionLabel, tipShare } from '../../../shared/rules.ts';
import { api } from '../api.ts';
import { RouteBuilder } from '../builder.ts';
import { distM, fmtDist } from '../net.ts';
import { netLayer } from '../netmap.ts';
import { app, routeState, currentRound, isHost, serverNow, setMapBig } from '../store.ts';
import { esc, h, lineChip, modeChip, toast } from '../ui.ts';
import { hostBar } from './host.ts';
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
  const from = app.net.station(round.from!.id);
  const to = app.net.station(round.to!.id);
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
  builder = new RouteBuilder(app.net, from, to, round.restriction, () => drawDraft(), () => submit(false), round.bannedLines, {
    typed: xtreme,
    hideStart: !showNames,
    // ohne Namen / ohne Karte: keine Entfernungen verraten
    hideDistances: !showNames || !showMap,
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
    <div class="when">🕒 ${esc(round.when ?? '')}${s.settings.network === 'current' ? ' · aktuelles Netz' : ''}${s.settings.countWait ? ' · inkl. Wartezeit' : ''}</div>
    ${
      round.restriction
        ? `<div class="restriction">${RESTRICTIONS[round.restriction].icon} <b>${esc(restrictionLabel(round.restriction, round.bannedLines))}</b> – ${
            round.restriction === 'banLines' ? 'finde eine andere Verbindung.' : RESTRICTIONS[round.restriction].hint
          }${round.limitSec && baseLimitSec(s.settings) && round.limitSec > baseLimitSec(s.settings)! ? ` <small>⏱ +${fmtDuration(round.limitSec - baseLimitSec(s.settings)!)} Extrazeit</small>` : ''}</div>`
        : ''
    }
    <div class="od"><div class="od-row"><span class="pin-dot a">A</span><b>${showNames ? esc(from.name) : 'Start <small>(nur auf der Karte)</small>'}</b></div>
    <div class="od-row"><span class="pin-dot b">B</span><b>${showNames ? esc(to.name) : 'Ziel <small>(nur auf der Karte)</small>'}</b></div></div>`;

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
    if (showMap) app.map.showEndpoints(round.from!, round.to!, true, showNames);
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
    drawDraft();
  }

  function renderTips(): HTMLElement {
    const box = h('div', { class: 'tips' });
    const used = new Set(tips.map((t) => t.kind));
    const btns = (Object.keys(TIPS) as TipKind[])
      .map(
        (k) =>
          `<button class="tip-btn" data-tip="${k}" ${used.has(k) ? 'disabled' : ''}>💡 ${esc(TIPS[k].label)} <small>−${Math.round(tipShare(k, s.settings.tips) * 100)} %</small></button>`,
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
    box.innerHTML = `<div class="tip-btns">${btns}</div>${results}`;
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
  }

  // -------------------------------------------------------------- Abgabe

  async function submit(auto: boolean) {
    if (submitting || view === 'waiting') return;
    const legs = b.userLegs();
    if (!legs.length && !auto) return toast('Gib mindestens eine Linie an.');
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
      clearTimeout(flashTimer);
      app.map.stopLocate();
      setMapBig(false);
    },
  };
}
