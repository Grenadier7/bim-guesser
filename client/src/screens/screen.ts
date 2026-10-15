/** Ein Bildschirm im Seitenpanel. update() wird bei jedem neuen Spielzustand aufgerufen. */
export interface Screen {
  update?(): void;
  /** ~4× pro Sekunde, für Countdown & Zeitablauf */
  tick?(): void;
  destroy?(): void;
}

export function setPanel(panel: HTMLElement, ...children: (HTMLElement | string)[]) {
  panel.innerHTML = '';
  for (const c of children) typeof c === 'string' ? panel.insertAdjacentHTML('beforeend', c) : panel.append(c);
  panel.scrollTop = 0;
}

export function loadingHtml(text: string, sub = ''): string {
  return `<div class="loading"><div class="spinner"></div><p>${text}</p>${sub ? `<small>${sub}</small>` : ''}</div>`;
}
