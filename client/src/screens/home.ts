// Startseite: vier Modi als große Kacheln + Beitreten mit Code (führt automatisch in den richtigen Modus)
import type { GameMode } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { app, savePrefs, startSession } from '../store.ts';
import { esc, h, toast } from '../ui.ts';
import { setPanel, type Screen } from './screen.ts';

const MODES = [
  {
    id: 'route',
    icon: '🏁',
    title: 'Routenjagd',
    text: 'Start und Ziel irgendwo in Wien – wer findet die schnellste Öffi-Verbindung?',
    tag: 'Mehrspieler · Lobby',
  },
  {
    id: 'quiz',
    icon: '🧠',
    title: 'Quiz',
    text: 'Stationen, Linien, Umstiege, Direktverbindungen – schnell antworten, Punkte sammeln.',
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
    text: 'Netzplan deines Grätzls, Steckbriefe der Linien, Linien aus dem Gedächtnis nachzeichnen.',
    tag: 'Allein',
  },
] as const;

export function homeScreen(panel: HTMLElement): Screen {
  app.map.clear();
  const urlCode = new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '';
  const el = h(
    'div',
    { class: 'home' },
    `<header class="hero"><span class="logo big">U</span><div><h1>Öffi-Guesser Wien</h1><p>Wie gut kennst du die Wiener Öffis?</p></div></header>
     <div class="mode-grid">${MODES.map(
       (m) => `<button class="mode-tile mode-${m.id}" data-mode="${m.id}">
         <span class="mt-icon">${m.icon}</span><span class="mt-title">${m.title}</span>
         <span class="mt-text">${m.text}</span><span class="mt-tag">${m.tag}</span></button>`,
     ).join('')}</div>
     <div class="home-bottom">
       <label class="field"><span>Dein Name</span><input id="name" maxlength="20" placeholder="z.B. Alex" value="${esc(app.prefs.name)}"></label>
       <div class="field join"><span>Mit Code beitreten</span>
         <div class="join-row"><input id="code" class="code-input" maxlength="5" placeholder="CODE" value="${esc(urlCode)}" autocomplete="off" spellcheck="false">
         <button class="btn btn-dark" id="join">Beitreten</button></div></div>
     </div>`,
  );
  const nameIn = el.querySelector<HTMLInputElement>('#name')!;
  const codeIn = el.querySelector<HTMLInputElement>('#code')!;
  const name = () => {
    app.prefs.name = nameIn.value.trim();
    savePrefs();
    return app.prefs.name;
  };
  const busy = (b: boolean) => el.querySelectorAll('button').forEach((x) => ((x as HTMLButtonElement).disabled = b));

  async function createLobby(mode: GameMode) {
    busy(true);
    try {
      const res = await api.create(name(), mode, mode === 'quiz' ? app.prefs.quiz : app.prefs.settings);
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
      app.view = m as 'learn' | 'training';
      app.onChange();
    }),
  );
  // Beitreten: der Server sagt, welcher Modus – der Router öffnet automatisch die richtige Lobby
  const join = async () => {
    const code = codeIn.value.trim().toUpperCase();
    if (code.length < 5) return toast('Bitte den 5-stelligen Lobby-Code eingeben.');
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
  codeIn.addEventListener('input', () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  codeIn.addEventListener('keydown', (e) => e.key === 'Enter' && join());
  setPanel(panel, el);
  if (urlCode) codeIn.focus();
  return {};
}
