// Startseite: Routenjagd groß, darunter die weiteren Modi + Beitreten mit Code (führt automatisch in den richtigen Modus)
import type { GameMode } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { app, savePrefs, startSession } from '../store.ts';
import { esc, h, toast } from '../ui.ts';
import { setPanel, type Screen } from './screen.ts';
import { importProblems, takeSettingsLink } from '../settingsShare.ts';
import { offerTutorial } from '../progress.ts';
import { account } from '../account.ts';

const MODES = [
  {
    id: 'route',
    icon: '🏁',
    title: 'Routenjagd',
    text: 'Start und Ziel irgendwo in Wien – wer findet die schnellste Öffi-Verbindung?',
    tag: 'Mehrspieler · Lobby',
  },
  {
    id: 'training',
    icon: '🏋️',
    title: 'Training',
    text: 'Echte Strecken ohne Zeitdruck – mit Coach, der nach jedem Schritt sagt, ob du richtig unterwegs bist.',
    tag: 'Allein',
  },
  {
    id: 'learn',
    icon: '📚',
    title: 'Lernen',
    text: 'Kurse Schritt für Schritt, Netzkarte mit Linien-Steckbriefen, gemerkte Linien üben.',
    tag: 'Allein',
  },
  {
    id: 'quiz',
    icon: '🧠',
    title: 'Quiz',
    text: 'Stationen, Linien, Umstiege, Direktverbindungen – schnell antworten, Punkte sammeln.',
    tag: 'Mehrspieler · Lobby',
  },
] as const;

function tile(m: (typeof MODES)[number], cls: string): string {
  return `<button class="mode-tile mode-${m.id} ${cls}" data-mode="${m.id}">
    <span class="mt-icon">${m.icon}</span><span class="mt-title">${m.title}</span>
    <span class="mt-text">${m.text}</span><span class="mt-tag">${m.tag}</span></button>`;
}

export function homeScreen(panel: HTMLElement): Screen {
  app.map.clear();
  const urlCode = new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '';
  // Tutorial (Punkt 17): nur für Neue – unten als Karte, oben ein Hinweis darauf
  const tut = offerTutorial() && !urlCode;
  const el = h(
    'div',
    { class: 'home' },
    `<header class="hero"><span class="logo big">U</span><div><h1>BimGuesser Wien</h1><p>Wie gut kennst du die Wiener Öffis?</p></div></header>
     ${tut ? `<button class="tut-hint" data-mode="tutorial">🎓 Neu hier? <b>Tutorial spielen</b> – 2 Runden, 3 Minuten</button>` : ''}
     ${
       urlCode
         ? `<div class="invite-card"><div>📨 Du wurdest in die Lobby <b>${esc(urlCode)}</b> eingeladen.</div>
              <label class="field"><span>Dein Name</span><input id="inviteName" maxlength="40" placeholder="z.B. Alex" value="${esc(account.me?.name ?? app.prefs.name)}"></label>
              <button class="btn btn-primary btn-big" id="joinInvite">Jetzt beitreten</button></div>`
         : ''
     }
     ${tile(MODES[0], 'mode-hero')}
     <h3 class="more-modes">Weitere Spielmodi</h3>
     <div class="mode-grid mode-grid-3">${MODES.slice(1)
       .map((m) => tile(m, 'mode-small'))
       .join('')}</div>
     <div class="home-bottom">
       <label class="field"><span>Dein Name</span><input id="name" maxlength="40" placeholder="z.B. Alex" value="${esc(account.me?.name ?? app.prefs.name)}"></label>
       <div class="field join"><span>Mit Code beitreten</span>
         <div class="join-row"><input id="code" class="code-input" maxlength="5" placeholder="CODE" value="${esc(urlCode)}" autocomplete="off" spellcheck="false">
         <button class="btn btn-dark" id="join">Beitreten</button></div></div>
     </div>
     ${
       tut
         ? `<button class="tut-card" data-mode="tutorial"><span class="mt-icon">🎓</span><span><b>Tutorial: dein erstes Spiel</b>
              <small>Zwei geführte Runden (Praterstern → Stephansplatz, Reumannplatz → Rathaus) und wie es Punkte gibt.</small></span>
              <span class="btn btn-primary">Los</span></button>`
         : ''
     }`,
  );
  const nameIn = el.querySelector<HTMLInputElement>('#name')!;
  const codeIn = el.querySelector<HTMLInputElement>('#code')!;
  const name = () => {
    app.prefs.name = nameIn.value.trim();
    savePrefs();
    return app.prefs.name;
  };
  // Enter im Eingabefeld ist kein Knopf – deshalb zusätzlich ein Merker gegen doppelte Anfragen (Befund M-09)
  let pending = false;
  const busy = (b: boolean) => {
    pending = b;
    el.querySelectorAll('button').forEach((x) => ((x as HTMLButtonElement).disabled = b));
  };

  async function createLobby(mode: GameMode, settings?: Record<string, unknown>) {
    if (pending) return;
    busy(true);
    try {
      const res = await api.create(name(), mode, settings ?? (mode === 'quiz' ? app.prefs.quiz : app.prefs.settings));
      // geteilter Link mit Unsinn darin: sagen, was nicht übernommen wurde
      const problems = settings ? importProblems(settings, res.state.settings) : [];
      if (problems.length) toast(`Aus dem Link nicht übernommen: ${problems.slice(0, 3).join(' · ')}${problems.length > 3 ? ` … (+${problems.length - 3})` : ''}`);
      startSession({ code: res.state.id, playerId: res.playerId, token: res.token }, res.state);
    } catch (e) {
      toast((e as Error).message);
      busy(false);
    }
  }

  el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = b.dataset.mode!;
      if (m === 'route' || m === 'quiz') return void createLobby(m);
      name();
      app.view = m as 'learn' | 'training' | 'tutorial';
      app.onChange();
    }),
  );
  // Beitreten: der Server sagt, welcher Modus – der Router öffnet automatisch die richtige Lobby
  const join = async () => {
    const code = codeIn.value.trim().toUpperCase();
    if (code.length < 5) return toast('Bitte den 5-stelligen Lobby-Code eingeben.');
    if (pending) return;
    busy(true);
    try {
      const res = await api.join(code, name());
      startSession({ code: res.state.id, playerId: res.playerId, token: res.token }, res.state);
    } catch (e) {
      toast((e as Error).message);
      busy(false);
    }
  };
  el.querySelector('#join')!.addEventListener('click', join);
  // Einladung: Name oben eintragen, ein Klick zum Beitreten
  const inviteName = el.querySelector<HTMLInputElement>('#inviteName');
  inviteName?.addEventListener('input', () => (nameIn.value = inviteName.value));
  inviteName?.addEventListener('keydown', (e) => e.key === 'Enter' && join());
  el.querySelector('#joinInvite')?.addEventListener('click', join);
  codeIn.addEventListener('input', () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  codeIn.addEventListener('keydown', (e) => e.key === 'Enter' && join());
  setPanel(panel, el);
  if (urlCode) (inviteName ?? codeIn).focus();
  // geteilter Einstellungs-Link (Punkt 14): gleich eine Lobby mit diesen Einstellungen
  const shared = takeSettingsLink();
  if (shared) {
    toast('Neue Lobby mit den geteilten Einstellungen …', 'info');
    void createLobby(shared.mode, shared.settings);
  }
  // angemeldet: Name = Account-Name (automatisch ausgefüllt)
  const syncName = () => {
    if (account.me && document.activeElement !== nameIn) nameIn.value = app.prefs.name = account.me.name;
  };
  account.listeners.add(syncName);
  return { destroy: () => account.listeners.delete(syncName) };
}
