// Linien-Icons (SVG, 24×24, Strichstärke 2, Farbe = Textfarbe) statt Emojis an Bedienelementen – sehen auf allen
// Geräten gleich aus und passen zur Schrift. Formen nach Lucide (ISC-Lizenz, lucide.dev).
const PATHS = {
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** Icon als HTML; aria-hidden – die Beschriftung daneben sagt, was der Knopf tut */
export function icon(name: IconName, size = 18): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}
