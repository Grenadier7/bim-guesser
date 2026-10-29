import type { Evaluation, RoundReveal } from '../../../shared/types.ts';
import { MODE_LABEL, RESTRICTIONS, TIPS, fmtTimeLeft, maxRoundPoints, restrictionLabel, routeCostOf, transferPenalty, transfersOf } from '../../../shared/rules.ts';
import { api } from '../api.ts';
import type { PlayerRoute } from '../map.ts';
import { netLayer, netView, smoothRoute } from '../netmap.ts';
import { app, routeState, currentRound, getReveal, isHost } from '../store.ts';
import { starMini } from '../learn/model.ts';
import { chain, esc, h, makeExpandable, routeDetails, toast, viaText } from '../ui.ts';
import { hostBar } from './host.ts';
import { loadingHtml, type Screen } from './screen.ts';

function fmt(n: number): string {
  return n.toLocaleString('de-AT');
}

/** Aufschlüsselung der Punkte einer Runde */
export function breakdown(ev: Evaluation): string {
  const sc = ev.score;
  const rows: string[] = [
    sc.route > 1000
      ? `<tr><td>Route <small>(inkl. +${fmt(sc.route - 1000)} – besser als die beste!)</small></td><td>${fmt(sc.route)}</td></tr>`
      : `<tr><td>Route</td><td>${fmt(sc.route)}</td></tr>`,
  ];
  if (sc.tipShare > 0)
    rows.push(
      `<tr><td>Tipps <small>(${ev.tips.map((t) => TIPS[t].label).join(', ')})</small></td><td>−${Math.round(sc.tipShare * 100)} %</td></tr>`,
    );
  if (sc.timeBonus) rows.push(`<tr><td>Zeitbonus</td><td>+${fmt(sc.timeBonus)}</td></tr>`);
  if (ev.locateDist) rows.push(`<tr><td>Wo liegt das?</td><td>+${fmt(sc.locate)}</td></tr>`);
  if (sc.multiplier !== 1) rows.push(`<tr><td>Schwierigkeit</td><td>×${sc.multiplier.toLocaleString('de-AT')}</td></tr>`);
  rows.push(`<tr class="sum"><td>Gesamt</td><td>${fmt(sc.total)}</td></tr>`);
  return `<table class="breakdown">${rows.join('')}</table>`;
}

/** so viele Verbindungen sind sofort sichtbar – der Rest hinter "weitere zeigen" */
const SHOWN_ROUTES = 3;

export function revealScreen(panel: HTMLElement): Screen {
  /** angetippte Route bleibt auf der Karte hervorgehoben */
  let pinned: string | null = null;
  const idx = currentRound()!.index;
  /** Zeitlimit der Runde – für „Zeit übrig“ */
  const limitSec = currentRound()!.limitSec;
  let reveal: RoundReveal | null = null;
  panel.innerHTML = loadingHtml('Lade Auflösung …');

  // Netzfehler: Meldung + Nochmal statt ewigem Spinner (Befund M-11)
  function load() {
    getReveal(idx)
      .then((r) => {
        reveal = r;
        render();
      })
      .catch((e) => {
        panel.innerHTML = `<div class="waiting"><p>Auflösung konnte nicht geladen werden: ${esc((e as Error).message)}</p>
          <button class="btn btn-primary" id="retry-reveal">Nochmal laden</button></div>`;
        panel.querySelector('#retry-reveal')!.addEventListener('click', () => {
          panel.innerHTML = loadingHtml('Lade Auflösung …');
          load();
        });
      });
  }
  load();

  /** Routen der Auflösung zeichnen (nach dem Anschauen einer ganzen Linie zurück) */
  let drawRoutes = () => {};
  let lineShown: string | null = null;

  /** Klick-Handler am gemeinsamen Panel – beim Verlassen der Auflösung wieder weg, sonst reagiert die nächste Runde
   *  (Routen-Baukasten, Tipps) auf Linien-Chips mit Routen der alten Auflösung */
  const listeners = new AbortController();
  let alive = true;

  /** Linie antippen → ganzer Verlauf auf der Karte; nochmal antippen oder „zurück“ → wieder die Routen */
  function showLine(label: string) {
    if (!alive) return;
    const ids = label.split('/').filter((id) => app.net.lines.has(id));
    if (!ids.length) return;
    if (lineShown === label) return drawRoutes();
    lineShown = label;
    app.map.showReveal([], []);
    const stops = [...new Set(ids.flatMap((id) => app.net.patterns(app.net.lines.get(id)!).flat()))].map((id) => app.net.station(id));
    const pts = netLayer().render(netView({ focus: new Set(ids), stops, allLabels: true, bothEnds: true }));
    if (pts.length) app.map.fitPoints(pts, 14);
    toast(`${ids.join(', ')}: ganzer Verlauf – nochmal antippen für die Routen`, 'info', { label: '← Routen', run: () => alive && drawRoutes() });
  }

  panel.addEventListener(
    'click',
    (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-chip-line]');
      // nur in der Detailansicht (Zeitplan/Fahrten) – in der zugeklappten Übersicht klappt ein Klick nur auf
      if (!chip || !chip.closest('.leg-detail') || (e.target as HTMLElement).closest('[data-star-line],[data-star-group]')) return;
      e.stopPropagation();
      showLine(chip.dataset.chipLine!);
    },
    { signal: listeners.signal },
  );

  function render() {
    if (!reveal) return;
    const s = routeState();
    const round = s.rounds[idx];
    const myId = app.session!.playerId;
    const multi = reveal.evaluations.length > 1;
    const mine = reveal.evaluations.find((e) => e.playerId === myId);
    const best = reveal.routes[0];

    const playerRoutes: PlayerRoute[] = reveal.evaluations
      .filter((e) => e.route)
      .map((e) => ({ key: `p:${e.playerId}`, name: e.playerId === myId ? 'Du' : e.playerName, route: e.route!, isMe: e.playerId === myId }));
    // Netzkarte blass als Hintergrund, darüber die Routen: kräftig die beste + eigene, die anderen blass
    drawRoutes = () => {
      lineShown = null;
      app.map.clearLearn();
      netLayer().render(netView({ dimAll: true, hubs: false, labels: false }));
      app.map.showReveal(reveal!.routes.map(smoothRoute), playerRoutes.map((p) => ({ ...p, route: smoothRoute(p.route) })), [best.key, ...(mine?.route ? [`p:${myId}`] : [])]);
    };
    netLayer().render(netView({ dimAll: true, hubs: false, labels: false }));
    app.map.showReveal(reveal.routes.map(smoothRoute), playerRoutes.map((p) => ({ ...p, route: smoothRoute(p.route) })), [best.key, ...(mine?.route ? [`p:${myId}`] : [])]);
    pinned = null;
    if (s.settings.locate) {
      app.map.showEndpoints(round.from!, round.to!, false);
      if (mine?.guesses) app.map.showGuesses(mine.guesses, { from: round.from!, to: round.to! });
    }

    const scroll = panel.scrollTop;
    panel.innerHTML = '';
    panel.append(hostBar(), h('h2', { class: 'reveal-title' }, `Auflösung · Runde ${idx + 1}/${s.settings.rounds}`));
    if (reveal.cancelled)
      panel.append(h('div', { class: 'cancelled' }, '✖ Runde vom Host abgebrochen – keine Punkte. Hier die Lösung zum Nachschauen:'));
    if (round.restriction)
      panel.append(h('div', { class: 'restriction' }, `${RESTRICTIONS[round.restriction].icon} ${esc(restrictionLabel(round.restriction, round.bannedLines))}`));
    const isBest = s.settings.goal === 'best';
    const penalty = transferPenalty(s.settings);
    if (mine) panel.append(myCard(mine, routeCostOf(best, s.settings), isBest, penalty));

    if (multi) {
      const table = h('div', { class: 'ranking' });
      table.innerHTML = `<h3>Runde <small>– antippen für Details</small></h3><ol>${reveal.evaluations
        .map(
          (e) => `<li data-key="p:${e.playerId}" class="expandable ${e.playerId === myId ? 'is-me' : ''}">
            <span class="pname">${esc(e.playerName)}</span>
            <span class="pchain">${e.route ? chain(e.route.legs) : `<small>${esc(e.error ?? '–')}</small>`}</span>
            <span class="pmin">${e.durationMin != null ? `${e.durationMin} min` : ''}${isBest && e.costMin != null && e.costMin !== e.durationMin ? ` <small>→ ${e.costMin}</small>` : ''}<small>${e.elapsedSec != null ? `⏱ ${fmtTimeLeft(e.elapsedSec, limitSec)}` : 'keine Abgabe'}</small></span>
            <b class="ppts">+${fmt(e.score.total)} <span class="chev">▾</span></b>
            <div class="rdetail">${e.route ? routeDetails(e.route, starMini) : ''}${breakdown(e)}</div></li>`,
        )
        .join('')}</ol>`;
      makeExpandable(table);
      hoverable(table);
      panel.append(table);
    }

    const list = h('ol', { class: 'route-list' });
    list.innerHTML = reveal.routes
      .slice(0, 5)
      .map(
        (r, i) => `<li data-key="${esc(r.key)}" class="expandable ${mine?.route?.key === r.key ? 'is-mine' : ''} ${i >= SHOWN_ROUTES ? 'more' : ''}">
          <div class="rrow"><span class="rank">${i + 1}</span>
          <div class="rmain"><div class="chainline">${chain(r.legs)}</div><small>${viaText(r)}</small></div>
          <div class="rtime"><b>${r.medianMin} min</b><small>${
            isBest && transfersOf(r) ? `${transfersOf(r)} Umstieg${transfersOf(r) > 1 ? 'e' : ''} → <b>${routeCostOf(r, s.settings)}</b> · ` : ''
          }${s.settings.countWait && r.medianMin !== r.rideMin ? `Fahrt ${r.rideMin}` : ''}${s.settings.avgWait ? '' : ` · ${r.samples}×`}</small></div>
          <span class="chev">▾</span></div>
          <div class="rdetail">${routeDetails(r, starMini)}</div>
        </li>`,
      )
      .join('');
    makeExpandable(list);
    hoverable(list);
    const sub = s.settings.avgWait
      ? `berechnet mit Ø-Wartezeit + Umsteigezeit${s.settings.countWait ? ', ab Abfragezeit' : ''}`
      : s.settings.countWait
        ? 'Tür-zu-Tür ab Abfragezeit, Median über 6 Abfahrtszeiten'
        : 'reine Reisezeit, Median der Stichprobe';
    panel.append(
      h('h3', {}, isBest ? `Beste Verbindungen <small>(Zeit + ${penalty} min je Umstieg · ${sub})</small>` : `Schnellste Verbindungen <small>(${sub})</small>`),
      list,
    );
    // nicht mit allen Varianten erschlagen: erst die besten, Rest auf Wunsch
    const extra = list.querySelectorAll('li.more').length;
    if (extra) {
      const more = h('button', { class: 'link more-routes' }, `▸ ${extra} weitere Verbindung${extra > 1 ? 'en' : ''} zeigen`);
      more.addEventListener('click', () => {
        list.classList.add('show-more');
        more.remove();
      });
      panel.append(more);
    }

    panel.insertAdjacentHTML(
      'beforeend',
      `<div class="legend">${(['U', 'S', 'T', 'B', 'W'] as const)
        .map((m) => `<span><i class="lg lg-${m}"></i>${MODE_LABEL[m]}</span>`)
        .join('')}<span><i class="lg lg-user"></i>gestrichelt = eure Routen</span><span class="lg-note">durchgezogen = beste Verbindungen der Auskunft</span></div>`,
    );

    const last = idx + 1 >= s.settings.rounds;
    if (isHost()) {
      const btn = h('button', { class: 'btn btn-primary btn-big' }, last ? 'Zum Endergebnis' : 'Nächste Runde');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = last ? '…' : 'Nächste Runde wird vorbereitet …';
        try {
          await api.next(app.session!);
        } catch (e) {
          toast((e as Error).message);
          btn.disabled = false;
        }
      });
      panel.append(btn);
    } else {
      panel.append(h('div', { class: 'waiting-host' }, 'Warte auf den Host …'));
    }
    panel.scrollTop = scroll;
  }

  function myCard(ev: Evaluation, best: number, isBest: boolean, penalty: number): HTMLElement {
    const word = isBest ? 'beste' : 'schnellste';
    let verdict: string;
    if (ev.timedOut) verdict = '<p class="err">Zeit abgelaufen – nicht abgegeben.</p>';
    else if (ev.error) verdict = `<p class="err">${esc(ev.error)}</p>`;
    else if (ev.matchedRank === 0) verdict = `<p class="good">Volltreffer – das ist die ${word} Verbindung!</p>`;
    else if (ev.matchedRank !== null) verdict = `<p>Das ist Verbindung <b>#${ev.matchedRank + 1}</b> der Stichprobe.</p>`;
    else if (ev.costMin !== null && ev.costMin < best) verdict = `<p class="good">${isBest ? 'Besser' : 'Schneller'} als alles, was die Auskunft gefunden hat – stark!</p>`;
    else verdict = `<p>Nicht unter den Top-Verbindungen – selbst nachgerechnet über ${ev.route?.samples ?? 0} Abfahrten.</p>`;
    const diff = ev.costMin !== null ? ev.costMin - best : null;
    const tr = ev.route ? transfersOf(ev.route) : 0;
    const max = maxRoundPoints(routeState().settings);
    const card = h(
      'div',
      { class: `result-card ${ev.score.total >= max * 0.65 ? 'great' : ev.score.total >= max * 0.3 ? 'ok' : 'meh'}` },
      `<div class="points">+${fmt(ev.score.total)}<small>/ ${fmt(max)}</small>${ev.elapsedSec != null ? `<small class="elapsed">⏱ ${fmtTimeLeft(ev.elapsedSec, limitSec)}</small>` : ''}</div>
       <div class="mine">
         ${ev.route ? `<div class="chainline">${chain(ev.route.legs)}<b>${ev.durationMin} min</b></div><details class="my-detail"><summary>Deine Route im Detail</summary>${routeDetails(ev.route, starMini)}</details>` : ''}
         ${isBest && ev.durationMin !== null && tr ? `<small>gewertet: ${ev.durationMin} min + ${tr} × ${penalty} min Umstieg = <b>${ev.costMin} min</b></small><br>` : ''}
         ${diff !== null ? `<small>${diff <= 0 ? `gleich gut oder besser als die ${word}` : `+${diff} min gegenüber der ${word}n`}</small>` : ''}
         ${verdict}
         ${ev.locateDist ? `<small>📍 A ${ev.locateDist.from != null ? `${fmt(ev.locateDist.from)} m` : '–'} · B ${ev.locateDist.to != null ? `${fmt(ev.locateDist.to)} m` : '–'} daneben</small>` : ''}
         ${breakdown(ev)}
       </div>`,
    );
    card.addEventListener('mouseenter', () => ev.route && app.map.highlight(ev.matchedRank != null ? ev.route.key : `p:${ev.playerId}`));
    card.addEventListener('mouseleave', () => app.map.highlight(pinned));
    return card;
  }

  function hoverable(el: HTMLElement) {
    el.addEventListener('mouseover', (e) => app.map.highlight((e.target as HTMLElement).closest<HTMLElement>('li[data-key]')?.dataset.key ?? pinned));
    el.addEventListener('mouseleave', () => app.map.highlight(pinned));
    // Antippen (auch am Handy): aufgeklappte Route bleibt auf der Karte hervorgehoben
    el.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-key]');
      if (!li || (e.target as HTMLElement).closest('.rdetail')) return;
      pinned = li.classList.contains('open') ? li.dataset.key! : null;
      app.map.highlight(pinned);
    });
  }

  let wasHost = isHost();
  return {
    destroy() {
      alive = false;
      listeners.abort();
      document.querySelector('.toast-action')?.closest('.toast')?.remove();
    },
    update() {
      // nur neu zeichnen, wenn sich die Host-Rolle ändert (sonst springt die Karte)
      if (isHost() !== wasHost) {
        wasHost = isHost();
        render();
      }
    },
  };
}
