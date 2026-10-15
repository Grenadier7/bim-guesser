import type { Evaluation, RoundReveal } from '../../../shared/types.ts';
import { MODE_LABEL, RESTRICTIONS, TIPS, fmtDuration, maxRoundPoints, restrictionLabel, routeCostOf, transferPenalty, transfersOf } from '../../../shared/rules.ts';
import { api } from '../api.ts';
import type { PlayerRoute } from '../map.ts';
import { app, routeState, currentRound, getReveal, isHost } from '../store.ts';
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

export function revealScreen(panel: HTMLElement): Screen {
  const idx = currentRound()!.index;
  let reveal: RoundReveal | null = null;
  panel.innerHTML = loadingHtml('Lade Auflösung …');

  getReveal(idx)
    .then((r) => {
      reveal = r;
      render();
    })
    .catch((e) => toast((e as Error).message));

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
    app.map.showReveal(reveal.routes, playerRoutes);
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
      table.innerHTML = `<h3>Runde</h3><ol>${reveal.evaluations
        .map(
          (e) => `<li data-key="p:${e.playerId}" class="${e.playerId === myId ? 'is-me' : ''}">
            <span class="pname">${esc(e.playerName)}</span>
            <span class="pchain">${e.route ? chain(e.route.legs) : `<small>${esc(e.error ?? '–')}</small>`}</span>
            <span class="pmin">${e.durationMin != null ? `${e.durationMin} min` : ''}${isBest && e.costMin != null && e.costMin !== e.durationMin ? ` <small>→ ${e.costMin}</small>` : ''}<small>${e.elapsedSec != null ? `⏱ ${fmtDuration(e.elapsedSec)}` : 'keine Abgabe'}</small></span>
            <b class="ppts">+${fmt(e.score.total)}</b></li>`,
        )
        .join('')}</ol>`;
      hoverable(table);
      panel.append(table);
    }

    const list = h('ol', { class: 'route-list' });
    list.innerHTML = reveal.routes
      .slice(0, 5)
      .map(
        (r, i) => `<li data-key="${esc(r.key)}" class="expandable ${mine?.route?.key === r.key ? 'is-mine' : ''}">
          <div class="rrow"><span class="rank">${i + 1}</span>
          <div class="rmain"><div class="chainline">${chain(r.legs)}</div><small>${viaText(r)}</small></div>
          <div class="rtime"><b>${r.medianMin} min</b><small>${
            isBest && transfersOf(r) ? `${transfersOf(r)} Umstieg${transfersOf(r) > 1 ? 'e' : ''} → <b>${routeCostOf(r, s.settings)}</b> · ` : ''
          }${s.settings.countWait && r.medianMin !== r.rideMin ? `Fahrt ${r.rideMin} · ` : ''}${r.samples}×</small></div>
          <span class="chev">▾</span></div>
          <div class="rdetail">${routeDetails(r)}</div>
        </li>`,
      )
      .join('');
    hoverable(list);
    makeExpandable(list);
    const sub = s.settings.countWait ? 'Tür-zu-Tür ab Abfragezeit, Median über 6 Abfahrtszeiten' : 'reine Reisezeit, Median der Stichprobe';
    panel.append(
      h('h3', {}, isBest ? `Beste Verbindungen <small>(Zeit + ${penalty} min je Umstieg · ${sub})</small>` : `Schnellste Verbindungen <small>(${sub})</small>`),
      list,
    );

    panel.insertAdjacentHTML(
      'beforeend',
      `<div class="legend">${(['U', 'S', 'T', 'B', 'W'] as const)
        .map((m) => `<span><i class="lg lg-${m}"></i>${MODE_LABEL[m]}</span>`)
        .join('')}<span><i class="lg lg-user"></i>Spieler-Routen</span></div>`,
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
      `<div class="points">+${fmt(ev.score.total)}<small>/ ${fmt(max)}</small>${ev.elapsedSec != null ? `<small class="elapsed">⏱ ${fmtDuration(ev.elapsedSec)}</small>` : ''}</div>
       <div class="mine">
         ${ev.route ? `<div class="chainline">${chain(ev.route.legs)}<b>${ev.durationMin} min</b></div><details class="my-detail"><summary>Deine Route im Detail</summary>${routeDetails(ev.route)}</details>` : ''}
         ${isBest && ev.durationMin !== null && tr ? `<small>gewertet: ${ev.durationMin} min + ${tr} × ${penalty} min Umstieg = <b>${ev.costMin} min</b></small><br>` : ''}
         ${diff !== null ? `<small>${diff <= 0 ? `gleich gut oder besser als die ${word}` : `+${diff} min gegenüber der ${word}n`}</small>` : ''}
         ${verdict}
         ${ev.locateDist ? `<small>📍 A ${ev.locateDist.from != null ? `${fmt(ev.locateDist.from)} m` : '–'} · B ${ev.locateDist.to != null ? `${fmt(ev.locateDist.to)} m` : '–'} daneben</small>` : ''}
         ${breakdown(ev)}
       </div>`,
    );
    card.addEventListener('mouseenter', () => ev.route && app.map.highlight(ev.matchedRank != null ? ev.route.key : `p:${ev.playerId}`));
    card.addEventListener('mouseleave', () => app.map.highlight(null));
    return card;
  }

  function hoverable(el: HTMLElement) {
    el.addEventListener('mouseover', (e) => app.map.highlight((e.target as HTMLElement).closest<HTMLElement>('li[data-key]')?.dataset.key ?? null));
    el.addEventListener('mouseleave', () => app.map.highlight(null));
  }

  let wasHost = isHost();
  return {
    update() {
      // nur neu zeichnen, wenn sich die Host-Rolle ändert (sonst springt die Karte)
      if (isHost() !== wasHost) {
        wasHost = isHost();
        render();
      }
    },
  };
}
