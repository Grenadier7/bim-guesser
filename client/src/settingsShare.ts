// Einstellungen teilen (Punkt 14): als Link (öffnet eine neue Lobby mit genau diesen Einstellungen) oder als JSON
// (kopieren / im selben Fenster wieder einfügen). Der Server prüft importierte Werte wie jede andere Änderung.
import type { GameMode } from '../../shared/types.ts';
import { esc, h, toast } from './ui.ts';

const PARAM = 'settings';

function encode(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(s: string): unknown {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

export function settingsLink(mode: GameMode, settings: object): string {
  return `${location.origin}${location.pathname}?${PARAM}=${encode({ mode, settings })}`;
}

/** Einstellungen aus dem Link (null = keiner/kaputt) – Parameter wird danach aus der Adresse entfernt */
export function takeSettingsLink(): { mode: GameMode; settings: Record<string, unknown> } | null {
  const raw = new URLSearchParams(location.search).get(PARAM);
  if (!raw) return null;
  history.replaceState(null, '', location.pathname);
  try {
    const v = decode(raw) as { mode?: unknown; settings?: unknown };
    if (!v || typeof v.settings !== 'object' || !v.settings) return null;
    return { mode: v.mode === 'quiz' ? 'quiz' : 'route', settings: v.settings as Record<string, unknown> };
  } catch {
    toast('Der Einstellungs-Link ist kaputt.');
    return null;
  }
}

/** Fenster: Link + JSON; mit `onImport` (nur Host) kann man JSON einfügen und übernehmen */
export function openSettingsDialog(mode: GameMode, settings: object, onImport: ((s: Record<string, unknown>) => Promise<void>) | null) {
  const json = JSON.stringify(settings, null, 2);
  const link = settingsLink(mode, settings);
  const box = h(
    'div',
    { class: 'idle-overlay settings-share', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'share-title' },
    `<div class="idle-box">
      <h2 id="share-title">⇅ Einstellungen teilen</h2>
      <p><b>Link</b> – wer ihn öffnet, bekommt sofort eine neue Lobby mit genau diesen Einstellungen:</p>
      <div class="share-row"><input class="share-link" readonly value="${esc(link)}" aria-label="Link"><button class="btn btn-ghost" data-copy="link">Kopieren</button></div>
      <p><b>JSON</b> – zum Aufheben oder Weitergeben${onImport ? '; zum Übernehmen hier einfügen' : ''}:</p>
      <textarea class="share-json" rows="8" spellcheck="false" aria-label="Einstellungen als JSON" ${onImport ? '' : 'readonly'}>${esc(json)}</textarea>
      <div class="learn-actions"><button class="btn btn-ghost" data-copy="json">JSON kopieren</button>${onImport ? '<button class="btn btn-primary" id="share-import">Übernehmen</button>' : ''}<button class="btn btn-ghost" id="share-close">Schließen</button></div>
    </div>`,
  );
  document.body.append(box);
  const close = () => box.remove();
  box.addEventListener('click', (e) => e.target === box && close());
  box.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  box.querySelector('#share-close')!.addEventListener('click', close);
  box.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      const text = b.dataset.copy === 'link' ? link : box.querySelector<HTMLTextAreaElement>('.share-json')!.value;
      try {
        await navigator.clipboard.writeText(text);
        toast(b.dataset.copy === 'link' ? 'Link kopiert' : 'JSON kopiert', 'info');
      } catch {
        toast('Kopieren ging nicht – bitte markieren und selbst kopieren.');
      }
    }),
  );
  box.querySelector('#share-import')?.addEventListener('click', async () => {
    let v: unknown;
    try {
      v = JSON.parse(box.querySelector<HTMLTextAreaElement>('.share-json')!.value);
    } catch {
      return toast('Das ist kein gültiges JSON.');
    }
    // auch ein ganzer Link-Inhalt { mode, settings } ist erlaubt
    const s = v && typeof v === 'object' && 'settings' in v ? (v as { settings: unknown }).settings : v;
    if (!s || typeof s !== 'object') return toast('Keine Einstellungen gefunden.');
    await onImport!(s as Record<string, unknown>);
    toast('Einstellungen übernommen', 'info');
    close();
  });
  box.querySelector<HTMLButtonElement>('[data-copy="link"]')!.focus();
}
