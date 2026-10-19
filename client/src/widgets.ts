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
        `<button data-k="${key}" data-v="${esc(o.value)}" class="${o.value === current ? 'on' : ''}" ${o.title ? `title="${esc(o.title)}"` : ''} ${disabled ? 'disabled' : ''}>${o.label}</button>`,
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
