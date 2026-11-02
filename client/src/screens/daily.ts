// 📅 Strecke des Tages: für alle dieselbe Strecke, einmal am Tag – Ergebnis teilen (wie bei Wordle) und
// Bestenliste für Tag und Woche (mit Account; auch nur unter Freunden).
import type { DailyBoard, DailyResult, DailyRound, UserLeg } from '../../../shared/types.ts';
import { MODE_ICON, scoreRoute } from '../../../shared/rules.ts';
import { XP, viennaDay } from '../../../shared/career.ts';
import { api } from '../api.ts';
import { account } from '../account.ts';
import { openAccount } from '../accountui.ts';
import { RouteBuilder } from '../builder.ts';
import { record } from '../career.ts';
import { starMini } from '../learn/model.ts';
import { addMistakes } from '../mistakes.ts';
import { netLayer, netView, smoothRoute } from '../netmap.ts';
import { loadJson, saveJson } from '../storage.ts';
import { app, setMapBig, setMobileMap } from '../store.ts';
import { chain, esc, h, makeExpandable, routeDetails, toast } from '../ui.ts';
import { loadingHtml, type Screen } from './screen.ts';

/** Gäste: Ergebnis von heute im Browser (mit Account kommt es vom Server) */
const LOCAL_KEY = 'oeffi-daily-v1';
type Local = Record<string, DailyResult & { legs?: UserLeg[] }>;

export function dailyPlayedLocally(day = viennaDay()): DailyResult | null {
  return loadJson<Local>(LOCAL_KEY, {})[day] ?? null;
}

function saveLocal(r: DailyResult, legs: UserLeg[]) {
  const all = loadJson<Local>(LOCAL_KEY, {});
  all[r.day] = { ...r, legs };
  // nur die letzten Tage behalten
  saveJson(LOCAL_KEY, Object.fromEntries(Object.entries(all).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14)));
}

/** Teilen-Text: Verkehrsmittel der eigenen Route und Punkte als Kästchen – ohne die Lösung zu verraten */
export function shareText(r: DailyResult): string {
  const modes = r.route ? r.route.legs.filter((l) => l.mode !== 'W').map((l) => MODE_ICON[l.mode]).join('›') : '❌';
  const full = Math.min(10, Math.round(Math.min(r.points, 1000) / 100));
  const bar = '🟩'.repeat(full) + '⬜'.repeat(10 - full) + (r.points > 1000 ? '🟪' : '');
  const time = r.durationMin != null ? `${Math.round(r.durationMin)} min (beste: ${Math.round(r.bestMin)})` : 'nicht angekommen';
  return `BimGuesser · Strecke des Tages #${r.number}\n${modes} ${time}\n${bar} ${r.points} Punkte\n${location.origin}/#daily`;
}

export function dailyScreen(panel: HTMLElement, onBack: () => void): Screen {
  const net = app.net;
  let round: DailyRound | null = null;
  let builder: RouteBuilder | null = null;
  let boardScope: 'day' | 'week' = 'day';
  let boardFriends = false;
  let alive = true;

  async function load() {
    panel.innerHTML = loadingHtml('Strecke des Tages wird geladen …');
    try {
      round = await api.daily();
    } catch (e) {
      panel.innerHTML = `<div class="learn"><button class="link" id="back">← Zurück</button><p class="err">${esc((e as Error).message)}</p>
        <button class="btn btn-primary" id="retry">Nochmal laden</button></div>`;
      panel.querySelector('#back')!.addEventListener('click', onBack);
      panel.querySelector('#retry')!.addEventListener('click', () => void load());
      return;
    }
    if (!alive) return;
    const done = round.played ?? (account.me ? null : dailyPlayedLocally(round.day));
    if (done) showResult(done);
    else intro();
  }

  function intro() {
    const r = round!;
    setMobileMap(true);
    app.map.clear();
    app.map.showEndpoints(r.from, r.to, true);
    panel.innerHTML = `
      <div class="learn daily">
        <button class="link" id="back">← Zurück</button>
        <h2>📅 Strecke des Tages <small>#${r.number}</small></h2>
        <div class="od"><div class="od-row"><span class="pin-dot a">A</span><b>${esc(r.from.name)}</b></div>
          <div class="od-row"><span class="pin-dot b">B</span><b>${esc(r.to.name)}</b></div></div>
        <p class="muted">🕒 ${esc(r.when)} · inkl. Wartezeit · ohne Zeitlimit und ohne Hilfen. Für alle dieselbe Strecke – <b>ein Versuch</b> am Tag.</p>
        <p class="muted">Mit U-Bahn und den bekannten S-Bahnen kommst du sicher hin und holst Punkte – die volle Punktzahl gibt’s nur mit Insiderwissen.</p>
        ${account.me ? '' : '<p class="muted">Tipp: Mit Account kommst du in die Bestenliste.</p>'}
        <button class="btn btn-primary btn-big" id="go">Los geht’s</button>
      </div>`;
    panel.querySelector('#back')!.addEventListener('click', onBack);
    panel.querySelector('#go')!.addEventListener('click', play);
  }

  function play() {
    const r = round!;
    const from = net.station(r.from.id);
    const to = net.station(r.to.id);
    builder = null;
    builder = new RouteBuilder(
      net,
      from,
      to,
      null,
      () => builder && app.map.showDraft(builder.segments(), builder.transferPoints()),
      () => void submit(),
    );
    panel.innerHTML = '';
    const head = h(
      'div',
      { class: 'round-head' },
      `<button class="link" id="back">← Zurück</button>
       <div class="when">📅 Strecke des Tages #${r.number} · ${esc(r.when)}</div>
       <div class="od"><div class="od-row"><span class="pin-dot a">A</span><b>${esc(r.from.name)}</b></div>
       <div class="od-row"><span class="pin-dot b">B</span><b>${esc(r.to.name)}</b></div></div>`,
    );
    head.querySelector('#back')!.addEventListener('click', onBack);
    panel.append(head, builder.el);
  }

  async function submit() {
    if (!builder || !round) return;
    const legs = builder.userLegs();
    if (!legs.length) return toast('Gib mindestens eine Linie an.');
    builder.lock();
    panel.innerHTML = loadingHtml('Route wird ausgewertet …');
    let res: DailyResult;
    try {
      res = await api.dailySubmit(legs);
    } catch (e) {
      toast((e as Error).message);
      builder.unlock();
      panel.innerHTML = '';
      play();
      return;
    }
    if (!account.me) saveLocal(res, legs);
    record(`daily:${res.day}`, { activity: true, xp: XP.daily(res.points), count: { daily: 1 }, legs: res.error ? undefined : legs });
    // verpasste Linien der schnellsten Verbindung → Fehlerliste
    if (res.points < 900 && res.routes[0]) {
      const mine = new Set(legs.map((l) => l.line));
      addMistakes(res.routes[0].legs.flatMap((l) => (l.line && l.mode !== 'W' ? l.line.split('/') : [])).filter((id) => !mine.has(id) && net.lines.has(id)).slice(0, 4));
    }
    showResult(res);
  }

  function showResult(res: DailyResult) {
    setMobileMap(true);
    setMapBig(false);
    netLayer().render(netView({ dimAll: true, hubs: false, labels: false }));
    app.map.showReveal(res.routes.map(smoothRoute), res.route ? [{ key: 'me', name: 'Du', route: smoothRoute(res.route), isMe: true }] : [], [res.routes[0]?.key ?? '', ...(res.route ? ['me'] : [])]);
    const delta = res.durationMin != null ? Math.round(res.durationMin - res.bestMin) : null;
    const verdict = res.error
      ? `<p class="err">${esc(res.error)}</p>`
      : res.points >= 1000
        ? `<p class="good">🎉 ${res.points > 1000 ? 'Schneller als die beste Verbindung!' : 'Volltreffer – die schnellste Verbindung!'}</p>`
        : delta != null && delta <= 3
          ? `<p class="good">Knapp dran – nur ${delta} min langsamer als die schnellste.</p>`
          : `<p>${delta} min langsamer als die schnellste Verbindung.</p>`;
    panel.innerHTML = `
      <div class="learn daily">
        <button class="link" id="back">← Zurück</button>
        <h2>📅 Strecke des Tages <small>#${res.number}</small></h2>
        <div class="result-card ${res.points >= 900 ? 'great' : res.points >= 400 ? 'ok' : 'meh'}">
          <div class="points">${res.points.toLocaleString('de-AT')}<small>Punkte</small></div>
          <div class="mine">
            ${res.route ? `<div class="chainline">${chain(res.route.legs)}<b>${Math.round(res.durationMin ?? 0)} min</b></div>` : ''}
            ${verdict}
            ${res.railMin != null ? `<small class="muted">Zum Vergleich – nur mit bekannten Linien (U-Bahn, S-Bahn-Stammstrecke, S45, S80): ${Math.round(res.railMin)} min (${scoreRoute(res.railMin, res.bestMin)} Punkte)</small>` : ''}
            ${res.rank ? `<p>🏅 Platz <b>${res.rank}</b> von ${res.players} heute</p>` : ''}
          </div>
        </div>
        <div class="share-row"><button class="btn btn-primary" id="share">📤 Ergebnis teilen</button>
          <small class="muted">Nächste Strecke ab Mitternacht.</small></div>
        <pre class="share-preview">${esc(shareText(res))}</pre>
        <h3>Schnellste Verbindungen</h3>
        <ol class="route-list">${res.routes
          .map((x, i) => `<li data-key="${esc(x.key)}" class="expandable"><div class="rrow"><span class="rank">${i + 1}</span><div class="rmain"><div class="chainline">${chain(x.legs)}</div></div><div class="rtime"><b>${x.medianMin} min</b></div><span class="chev">▾</span></div><div class="rdetail">${routeDetails(x, starMini)}</div></li>`)
          .join('')}</ol>
        <h3>🏆 Bestenliste</h3>
        <div class="board-tabs">
          <div class="seg"><button data-scope="day" class="${boardScope === 'day' ? 'on' : ''}">Heute</button><button data-scope="week" class="${boardScope === 'week' ? 'on' : ''}">Diese Woche</button></div>
          ${account.me ? `<div class="seg"><button data-friends="0" class="${boardFriends ? '' : 'on'}">Alle</button><button data-friends="1" class="${boardFriends ? 'on' : ''}">👥 Freunde</button></div>` : ''}
        </div>
        <div id="board">${loadingHtml('')}</div>
        ${account.me ? '' : '<p class="muted">In die Bestenliste kommst du mit einem Account. <button class="link" id="signup">Anmelden oder registrieren</button></p>'}
      </div>`;
    makeExpandable(panel.querySelector<HTMLElement>('.route-list')!);
    panel.querySelector('#back')!.addEventListener('click', onBack);
    panel.querySelector('#signup')?.addEventListener('click', () => openAccount());
    panel.querySelector('#share')!.addEventListener('click', async () => {
      const text = shareText(res);
      try {
        if (navigator.share) await navigator.share({ text });
        else {
          await navigator.clipboard.writeText(text);
          toast('Ergebnis kopiert – einfach einfügen', 'info');
        }
      } catch {
        /* Teilen abgebrochen */
      }
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((b) =>
      b.addEventListener('click', () => {
        boardScope = b.dataset.scope as 'day' | 'week';
        showResult(res);
      }),
    );
    panel.querySelectorAll<HTMLButtonElement>('[data-friends]').forEach((b) =>
      b.addEventListener('click', () => {
        boardFriends = b.dataset.friends === '1';
        showResult(res);
      }),
    );
    void loadBoard();
  }

  async function loadBoard() {
    const el = panel.querySelector<HTMLElement>('#board');
    if (!el) return;
    let b: DailyBoard;
    try {
      b = await api.dailyBoard(boardScope, boardFriends);
    } catch (e) {
      el.innerHTML = `<p class="muted">${esc((e as Error).message)}</p>`;
      return;
    }
    const row = (r: DailyBoard['rows'][number]) =>
      `<li class="${r.me ? 'is-me' : ''}"><span>${['🥇', '🥈', '🥉'][r.rank - 1] ?? `${r.rank}.`}</span><b>${esc(r.name)}</b><span class="pts">${r.points.toLocaleString('de-AT')}${b.scope === 'week' ? ` <small>· ${r.days} ${r.days === 1 ? 'Tag' : 'Tage'}</small>` : ` <small>· ${r.minutes} min</small>`}</span></li>`;
    el.innerHTML = b.rows.length
      ? `<ol class="podium board">${b.rows.map(row).join('')}${b.mine ? `<li class="gap">…</li>${row(b.mine)}` : ''}</ol>`
      : `<p class="muted">${b.friends ? 'Noch niemand aus deinen Freunden hat gespielt.' : 'Noch keine Einträge.'}</p>`;
  }

  void load();
  return {
    destroy: () => {
      alive = false;
      setMapBig(false);
      app.map.clear();
    },
  };
}
