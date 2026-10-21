// Lobby-Chat: ausklappbares Fenster unten rechts, solange man in einer Lobby (oder einem Spiel) ist.
// Zugeklappt nur ein kleiner 💬-Knopf mit Zähler für ungelesene Nachrichten.
import type { ChatMessage } from '../../shared/types.ts';
import { api } from './api.ts';
import { app } from './store.ts';
import { esc, h, toast } from './ui.ts';

const OPEN_KEY = 'oeffi-chat-open';

export class ChatWidget {
  readonly el = h('div', { class: 'chat', hidden: '' });
  private messages: ChatMessage[] = [];
  private unread = 0;
  private open = false;
  private code = '';
  private sending = false;

  constructor() {
    try {
      this.open = sessionStorage.getItem(OPEN_KEY) === '1';
    } catch {
      /* privater Modus */
    }
    document.body.append(this.el);
  }

  /** Ein-/Ausblenden je nach Sitzung; neue Lobby → leerer Verlauf */
  sync() {
    const code = app.session?.code ?? '';
    if (code !== this.code) {
      this.code = code;
      this.messages = [];
      this.unread = 0;
    }
    this.el.hidden = !code;
    if (code) this.render();
  }

  history(messages: ChatMessage[]) {
    this.messages = messages;
    this.render(true);
  }

  add(m: ChatMessage) {
    if (this.messages.some((x) => x.id === m.id)) return;
    this.messages = [...this.messages.slice(-49), m];
    if (!this.open && m.playerId !== app.session?.playerId) this.unread++;
    this.render(true);
  }

  private setOpen(open: boolean) {
    this.open = open;
    if (open) this.unread = 0;
    try {
      sessionStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* privater Modus */
    }
    this.render(true);
    if (open) this.el.querySelector<HTMLInputElement>('.chat-input')?.focus();
  }

  private render(scroll = false) {
    const me = app.session?.playerId;
    if (!this.open) {
      this.el.className = 'chat closed';
      this.el.innerHTML = `<button class="chat-toggle" aria-label="Chat öffnen${this.unread ? ` – ${this.unread} neue Nachrichten` : ''}">💬${
        this.unread ? `<span class="chat-badge">${this.unread > 9 ? '9+' : this.unread}</span>` : ''
      }</button>`;
      this.el.querySelector('.chat-toggle')!.addEventListener('click', () => this.setOpen(true));
      return;
    }
    // Eingabe beim Neuzeichnen behalten (neue Nachricht kommt, während man tippt)
    const draft = this.el.querySelector<HTMLInputElement>('.chat-input')?.value ?? '';
    const hadFocus = document.activeElement === this.el.querySelector('.chat-input');
    this.el.className = 'chat';
    this.el.innerHTML = `
      <div class="chat-head"><b>💬 Lobby-Chat</b><button class="chat-close" aria-label="Chat zuklappen">▾</button></div>
      <ol class="chat-list" aria-live="polite">${
        this.messages.length
          ? this.messages
              .map((m) =>
                m.playerId
                  ? `<li class="${m.playerId === me ? 'mine' : ''}"><b>${esc(m.name)}</b> ${esc(m.text)}</li>`
                  : `<li class="system">${esc(m.text)}</li>`,
              )
              .join('')
          : '<li class="system">Noch keine Nachrichten – sag Hallo!</li>'
      }</ol>
      <form class="chat-form"><input class="chat-input" maxlength="300" placeholder="Nachricht …" autocomplete="off" aria-label="Nachricht"><button class="btn btn-primary" aria-label="Senden">➤</button></form>`;
    const input = this.el.querySelector<HTMLInputElement>('.chat-input')!;
    input.value = draft;
    if (hadFocus) input.focus();
    this.el.querySelector('.chat-close')!.addEventListener('click', () => this.setOpen(false));
    this.el.querySelector('.chat-form')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || this.sending || !app.session) return;
      this.sending = true;
      try {
        this.add(await api.chat(app.session, text));
        const fresh = this.el.querySelector<HTMLInputElement>('.chat-input');
        if (fresh) fresh.value = '';
      } catch (err) {
        toast((err as Error).message);
      } finally {
        this.sending = false;
        this.el.querySelector<HTMLInputElement>('.chat-input')?.focus();
      }
    });
    if (scroll) {
      const list = this.el.querySelector('.chat-list')!;
      list.scrollTop = list.scrollHeight;
    }
  }
}
