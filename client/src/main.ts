import './style.css';
import { fmtDuration } from '../../shared/rules.ts';
import { api } from './api.ts';
import { account, startPolling } from './account.ts';
import { accountButton, announceMedals, openAccount, renderInvites, takeResetLink } from './accountui.ts';
import { isMine, setMine } from './learn/model.ts';
import { GameMap } from './map.ts';
import { NetIndex } from './net.ts';
import { resetNetLayer } from './netmap.ts';
import { openLegalFromHash } from './legal.ts';
import { applyGameConfig } from '../../shared/config.ts';
import { finalScreen } from './screens/final.ts';
import { homeScreen } from './screens/home.ts';
import { hostActions, hostBar } from './screens/host.ts';
import { learnScreen } from './screens/learn.ts';
import { lobbyScreen } from './screens/lobby.ts';
import { quizFinalScreen, quizLobbyScreen, quizQuestionScreen, quizRevealScreen } from './screens/quiz/index.ts';
import { revealScreen } from './screens/reveal.ts';
import { roundScreen } from './screens/round.ts';
import { loadingHtml, type Screen } from './screens/screen.ts';
import { trainingScreen } from './screens/training.ts';
import { adminScreen } from './screens/admin.ts';
import { tutorialScreen } from './screens/tutorial.ts';
import { ChatWidget } from './chat.ts';
import { hideIdle, idleCheck } from './idle.ts';
import { app, currentRound, inviteLink, isHost, me, openTimer, restoreSession, serverNow, setMapBig, setMobileMap } from './store.ts';
import { esc, toast } from './ui.ts';

const panel = document.getElementById('panel')!;
const topinfo = document.getElementById('topinfo')!;
// Account-Knopf rechts in der Kopfzeile, Einladungen von Freunden als Banner darunter
const acctSlot = document.createElement('div');
acctSlot.className = 'acct-slot';
document.querySelector('.topbar')!.append(acctSlot);
const inviteHost = document.createElement('div');
inviteHost.className = 'invite-host';
document.body.append(inviteHost);
// Hinweis der Spielleitung für alle (Admin-Seite) – wegklickbar, bis sich der Text ändert
const notice = document.createElement('div');
notice.className = 'notice-bar';
notice.hidden = true;
document.body.prepend(notice);

function renderNotice() {
  const text = app.config?.announcement.text ?? '';
  let closed = '';
  try {
    closed = localStorage.getItem('oeffi-notice-closed') ?? '';
  } catch {
    /* ohne Speicher immer zeigen */
  }
  notice.hidden = !text || closed === text;
  if (notice.hidden) return;
  notice.innerHTML = `<span>📢 ${esc(text)}</span><button class="icon-btn" aria-label="Hinweis schließen">✕</button>`;
  notice.querySelector('button')!.addEventListener('click', () => {
    try {
      localStorage.setItem('oeffi-notice-closed', text);
    } catch {
      /* egal */
    }
    notice.hidden = true;
  });
}

/** Besucherzahl: zufällige Kennung dieses Browsers (kein Bezug zur Person), jede Minute, solange die Seite sichtbar ist */
function startVisitorPing() {
  let id = '';
  try {
    id = localStorage.getItem('oeffi-visitor') ?? '';
    if (!/^[a-z0-9]{12,40}$/.test(id)) localStorage.setItem('oeffi-visitor', (id = crypto.randomUUID().replace(/-/g, '')));
  } catch {
    id = crypto.randomUUID().replace(/-/g, '');
  }
  const ping = () => {
    if (document.visibilityState !== 'visible') return;
    void fetch('/api/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: id }), credentials: 'same-origin' }).catch(() => {});
  };
  ping();
  setInterval(ping, 60_000);
  document.addEventListener('visibilitychange', ping);
}

/** Lobby mit eigenem Netzplan: dessen Netz laden (Karte, Routen-Baukasten), sonst das Standard-Netz */
let netLoading: string | null = null;
function ensurePlanNet() {
  const s = app.state;
  const want = app.session && s?.mode === 'route' && s.settings.network.startsWith('plan:') ? s.settings.network.slice(5) : 'regular';
  if (want === app.netPlan || want === netLoading) return;
  netLoading = want;
  api
    .network(want)
    .then((data) => {
      if (netLoading !== want) return;
      app.net = new NetIndex(data);
      app.netPlan = want;
      resetNetLayer();
      // Bildschirm mit dem neuen Netz neu aufbauen
      screen?.destroy?.();
      screenKey = '';
      render();
    })
    .catch((e) => toast((e as Error).message))
    .finally(() => {
      if (netLoading === want) netLoading = null;
    });
}

function renderAccount() {
  acctSlot.innerHTML = accountButton();
  acctSlot.querySelector('#acct-btn')!.addEventListener('click', () => openAccount());
  renderInvites(inviteHost);
  announceMedals();
}
const pauseOverlay = document.createElement('div');
pauseOverlay.className = 'pause-overlay';
pauseOverlay.hidden = true;
document.querySelector('.layout')!.append(pauseOverlay);

// Handy: Karte vergrößern/verkleinern
const mapToggle = document.createElement('button');
mapToggle.className = 'map-toggle';
mapToggle.title = 'Karte größer/kleiner';
mapToggle.textContent = '⤢';
mapToggle.addEventListener('click', () => setMapBig(!document.body.classList.contains('map-big')));
document.querySelector('.layout')!.append(mapToggle);

let screen: Screen | null = null;
let screenKey = '';

/** Welcher Bildschirm gehört zum aktuellen Zustand? */
function keyFor(): string {
  const s = app.state;
  if (!app.session || !s) return app.view;
  if (s.mode === 'quiz') {
    if (s.phase === 'lobby') return 'qlobby';
    if (s.phase === 'finished') return 'qfinal';
    return `q:${s.current}:${s.status}`;
  }
  if (s.phase === 'lobby') return 'lobby';
  if (s.phase === 'finished') return 'final';
  const r = currentRound();
  if (!r || r.status === 'preparing') return `prep:${s.currentRound}`;
  if (r.status === 'open') return `open:${r.index}`;
  return `reveal:${r.index}`;
}

function mount(key: string): Screen {
  // Startseite: großer Auswahlbildschirm ohne Karte
  document.body.classList.toggle('panel-full', key === 'home' || key === 'admin');
  // Handy: Karte nur, wo sie gebraucht wird – Bildschirme können das selbst ändern
  setMobileMap(!['home', 'lobby', 'final', 'qlobby', 'qfinal'].includes(key));
  setTimeout(() => app.map.invalidate(), 50);
  const back = () => {
    app.view = 'home';
    render();
  };
  if (key === 'home') return homeScreen(panel);
  if (key === 'learn') return learnScreen(panel, back);
  if (key === 'training') return trainingScreen(panel, back);
  if (key === 'tutorial') return tutorialScreen(panel, back);
  if (key === 'admin') return adminScreen(panel, back);
  if (key === 'lobby') return lobbyScreen(panel);
  if (key === 'final') return finalScreen(panel);
  if (key === 'qlobby') return quizLobbyScreen(panel);
  if (key === 'qfinal') return quizFinalScreen(panel);
  if (key.startsWith('q:')) return key.endsWith(':open') ? quizQuestionScreen(panel) : quizRevealScreen(panel);
  if (key.startsWith('open:')) return roundScreen(panel);
  if (key.startsWith('reveal:')) return revealScreen(panel);
  app.map.clear();
  const s = app.state;
  const n = (s?.mode === 'route' ? s.currentRound : 0) + 1;
  panel.innerHTML = loadingHtml(`Runde ${n} wird vorbereitet …`);
  panel.prepend(hostBar());
  return {};
}

/** Chat-Fenster an die Sitzung anpassen (gesetzt in init) */
let chatSync = () => {};

function render() {
  ensurePlanNet();
  chatSync();
  renderInvites(inviteHost);
  const key = keyFor();
  if (key !== screenKey) {
    screen?.destroy?.();
    screenKey = key;
    screen = mount(key);
  } else {
    screen?.update?.();
  }
  renderTop();
  renderPause();
}

/** Pausierte Runde/Frage: alles abdecken, Host kann fortsetzen */
function renderPause() {
  const paused = !!app.session && !!openTimer()?.pausedAt;
  pauseOverlay.hidden = !paused;
  if (!paused) return;
  pauseOverlay.innerHTML = `<div class="pause-box"><div class="pause-icon">⏸</div><h2>Pausiert</h2>
    <p>${isHost() ? 'Du hast die Zeit angehalten.' : 'Der Host hat die Zeit angehalten.'}</p>
    ${isHost() ? '<button class="btn btn-primary" id="resume">▶ Fortsetzen</button>' : ''}</div>`;
  pauseOverlay.querySelector('#resume')?.addEventListener('click', () => hostActions.resume());
}

function renderTop() {
  const s = app.state;
  if (!s || !app.session) {
    topinfo.innerHTML = '';
    return;
  }
  const parts = [`<button class="code-badge" id="code-badge" title="Einladungslink kopieren">${s.mode === 'quiz' ? '🧠' : '🏁'} <b>${esc(s.id)}</b></button>`];
  if (s.phase !== 'lobby') {
    if (s.mode === 'quiz') parts.push(`<span>Frage <b>${Math.min(s.current + 1, s.total)}</b>/${s.total}</span>`);
    else parts.push(`<span>Runde <b>${Math.min(s.currentRound + 1, s.settings.rounds)}</b>/${s.settings.rounds}</span>`);
    if (openTimer()?.deadline) parts.push('<span class="timer" id="timer"></span>');
    parts.push(`<span class="score"><b>${(me()?.score ?? 0).toLocaleString('de-AT')}</b> Pkt.</span>`);
  }
  topinfo.innerHTML = parts.join('');
  topinfo.querySelector('#code-badge')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(s.id));
      toast('Einladungslink kopiert', 'info');
    } catch {
      toast(`Code: ${s.id}`, 'info');
    }
  });
  tick();
}

function tick() {
  const t = openTimer();
  const el = document.getElementById('timer');
  if (el && t?.deadline) {
    const now = t.pausedAt ?? serverNow();
    const left = Math.max(0, (t.deadline - now) / 1000);
    el.textContent = `⏱ ${fmtDuration(Math.ceil(left))}`;
    el.classList.toggle('urgent', left <= (app.state?.mode === 'quiz' ? 5 : 15) && !t.pausedAt);
    el.classList.toggle('paused', !!t.pausedAt);
  }
  screen?.tick?.();
}

async function init() {
  app.map = new GameMap(document.getElementById('map')!);
  app.onChange = render;
  const chat = new ChatWidget();
  app.onChat = (e) => (e.type === 'chat' ? chat.add(e.message) : chat.history(e.messages));
  app.onKicked = () => toast('Du wurdest vom Host aus der Lobby entfernt.');
  app.onIdle = idleCheck;
  app.onClosed = (reason) => {
    hideIdle();
    toast(reason, 'info');
  };
  chatSync = () => chat.sync();
  account.listeners.add(renderAccount);
  renderAccount();
  startPolling();
  takeResetLink();
  panel.innerHTML = loadingHtml('Wird geladen …');
  try {
    // erst die Spiel-Konfiguration (Uhrzeiten, Wertungen, Standard-Einstellungen …), dann das Netz
    const [config, network] = await Promise.all([api.config(), api.network()]);
    app.config = config;
    applyGameConfig(config);
    renderNotice();
    app.net = new NetIndex(network);
  } catch (e) {
    panel.innerHTML = `<div class="loading"><p class="err">Server nicht erreichbar: ${esc((e as Error).message)}</p></div>`;
    return;
  }
  // geteilter Einstellungs-Link → Startseite (legt die Lobby an) statt in die alte Lobby zurück
  if (new URLSearchParams(location.search).has('settings') || !(await restoreSession())) render();
  setInterval(tick, 250);
  startVisitorPing();
  // Link wie /#impressum oder /#datenschutz
  openLegalFromHash();
  // ☆ hinter Liniennummern (z.B. in der Routenjagd-Auflösung): Linie für „Lernen → Üben“ merken
  // ☆ für mehrere gleichwertige Linien („S1/S2/S3“): alle merken, in der Meldung „nur S1“ wählbar (Punkt 8)
  document.addEventListener('click', (e) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>('[data-star-group]');
    if (!g) return;
    e.stopPropagation();
    const ids = g.dataset.starGroup!.split('/');
    const refresh = () =>
      document.querySelectorAll<HTMLElement>(`[data-star-group="${CSS.escape(g.dataset.starGroup!)}"]`).forEach((x) => {
        const all = ids.every(isMine);
        x.textContent = all ? '⭐' : ids.some(isMine) ? '✬' : '☆';
        x.classList.toggle('on', all);
      });
    if (ids.every(isMine)) {
      for (const id of ids) setMine(id, false);
      refresh();
      return toast(`${ids.join(', ')} nicht mehr gemerkt`, 'info');
    }
    for (const id of ids) setMine(id, true);
    refresh();
    toast(`${ids.join(', ')} gemerkt – zum Üben unter 📚 Lernen`, 'info', {
      label: `nur ${ids[0]}`,
      run: () => {
        for (const id of ids.slice(1)) setMine(id, false);
        refresh();
      },
    });
  });
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-star-line]');
    if (!b) return;
    e.stopPropagation();
    const id = b.dataset.starLine!;
    const on = !isMine(id);
    setMine(id, on);
    document.querySelectorAll<HTMLElement>(`[data-star-line="${CSS.escape(id)}"]`).forEach((x) => {
      x.textContent = on ? '⭐' : '☆';
      x.classList.toggle('on', on);
    });
    toast(on ? `${id} gemerkt – zum Üben unter 📚 Lernen` : `${id} nicht mehr gemerkt`, 'info');
  });
  window.addEventListener('resize', () => app.map.invalidate());
}

init();
