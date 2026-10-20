// Bausteine für Einstellungs-Bildschirme (Routenjagd-Lobby, Quiz-Lobby): Segment-Auswahl, ⓘ-Erklärung, Schalter
import { esc } from './ui.ts';

export interface Opt {
  value: string;
  label: string;
  title?: string;
}

export function seg(key: string, opts: Opt[], current: string, disabled: boolean): string {
  return `<div class="seg seg-wide">${opts
    .map(
      (o) =>
        `<button data-k="${key}" data-v="${esc(o.value)}" class="${o.value === current ? 'on' : ''}" aria-pressed="${o.value === current}" ${o.title ? `title="${esc(o.title)}"` : ''} ${disabled ? 'disabled' : ''}>${o.label}</button>`,
    )
    .join('')}</div>`;
}

/** Kleines ⓘ – Erklärung erscheint beim Drüberfahren/Antippen in einem Fenster */
export function infoTip(html: string): string {
  return `<button type="button" class="info-tip" aria-label="Erklärung anzeigen">ⓘ<span class="tip-pop" role="tooltip">${html}</span></button>`;
}

/** Schalter mit ⓘ statt Erklärtext (optional eine kurze Zusatzzeile) */
export function toggleInfo(key: string, label: string, info: string, on: boolean, disabled: boolean, sub = ''): string {
  return `<label class="toggle ${disabled ? 'is-disabled' : ''}">
    <input type="checkbox" data-k="${key}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
    <span class="switch"></span><span class="tl"><b>${label} ${infoTip(info)}</b>${sub ? `<small>${sub}</small>` : ''}</span></label>`;
}

/**
 * Einstellungs-Änderungen nacheinander senden: Was während einer laufenden Anfrage geändert wird, wird gesammelt
 * und danach geschickt – früher ging es verloren (Befund M-10).
 */
export function patchQueue<P extends object>(sendNow: (patch: P) => Promise<void>): (patch: P) => Promise<void> {
  let running: Promise<void> | null = null;
  let queued: P | null = null;
  const run = async (patch: P) => {
    try {
      await sendNow(patch);
    } finally {
      const next = queued;
      queued = null;
      running = next ? run(next) : null;
    }
  };
  return (patch: P) => {
    if (running) {
      queued = { ...(queued ?? ({} as P)), ...patch };
      return running;
    }
    running = run(patch);
    return running;
  };
}

/**
 * Neu zeichnen bei Live-Updates – aber nicht, während jemand einen Regler zieht oder eine Auswahlliste offen hat
 * (sonst springt der Regler zurück / die Liste geht zu, Befund M-10). Das aufgeschobene Zeichnen folgt danach.
 */
export function deferWhileEditing(panel: HTMLElement, render: () => void): () => void {
  let dragging = false;
  let deferred = false;
  const editing = () => dragging || (document.activeElement instanceof HTMLSelectElement && panel.contains(document.activeElement));
  const flush = () => {
    if (deferred && !editing()) {
      deferred = false;
      render();
    }
  };
  panel.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).matches?.('input[type=range]')) dragging = true;
  });
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    setTimeout(flush, 0);
  });
  panel.addEventListener('focusout', () => setTimeout(flush, 0));
  panel.addEventListener('change', () => setTimeout(flush, 0));
  return () => {
    if (editing()) deferred = true;
    else render();
  };
}
