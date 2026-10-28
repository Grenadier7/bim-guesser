// „Lobby behalten?“ – nach längerer Inaktivität fragt der Server die Hosts. 30 s Zeit, sonst übernimmt
// der nächste Spieler bzw. die Lobby wird gelöscht.
import { api } from './api.ts';
import { app, serverNow } from './store.ts';
import { h, toast } from './ui.ts';

let box: HTMLElement | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function hide() {
  clearInterval(timer);
  box?.remove();
  box = null;
}

/** Nachfrage anzeigen (wenn ich gefragt bin) bzw. schließen (leere Liste / jemand anders hat geantwortet) */
export function idleCheck(playerIds: string[], deadline: number) {
  if (!app.session || !playerIds.includes(app.session.playerId)) return hide();
  hide();
  box = h(
    'div',
    { class: 'idle-overlay', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'idle-title' },
    `<div class="idle-box"><h2 id="idle-title">💤 Lobby noch gebraucht?</h2>
      <p>In dieser Lobby ist seit einer Weile nichts passiert. Ohne Antwort wird sie gleich gelöscht.</p>
      <p class="idle-count"><b id="idle-left"></b></p>
      <div class="learn-actions"><button class="btn btn-primary" id="idle-keep">Lobby behalten</button><button class="btn btn-ghost" id="idle-close">Lobby löschen</button></div></div>`,
  );
  document.body.append(box);
  const left = box.querySelector<HTMLElement>('#idle-left')!;
  const tick = () => (left.textContent = `noch ${Math.max(0, Math.ceil((deadline - serverNow()) / 1000))} s`);
  tick();
  timer = setInterval(tick, 500);
  const answer = (keep: boolean) => async () => {
    hide();
    try {
      await api.idle(app.session!, keep);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  box.querySelector('#idle-keep')!.addEventListener('click', answer(true));
  box.querySelector('#idle-close')!.addEventListener('click', answer(false));
  box.querySelector<HTMLButtonElement>('#idle-keep')!.focus();
}

export const hideIdle = hide;
