// Hell/Dunkel: folgt dem System oder fest gewählt (Knopf in der Kopfzeile). Setzt data-theme auf <html> –
// dark.css (erzeugt aus style.css) färbt danach um; die Karte tauscht die Kacheln (map.ts hört auf 'themechange').
export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'oeffi-theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export const isDark = () => document.documentElement.dataset.theme === 'dark';

export function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'auto' && !!media?.matches);
  if (isDark() === dark && document.documentElement.dataset.theme) return;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121418' : '#ffffff');
  window.dispatchEvent(new Event('themechange'));
}

const NEXT: Record<ThemePref, ThemePref> = { auto: 'dark', dark: 'light', light: 'auto' };
const LABEL: Record<ThemePref, [string, string]> = {
  auto: ['🌗', 'Darstellung: wie das System – antippen für dunkel'],
  dark: ['🌙', 'Darstellung: dunkel – antippen für hell'],
  light: ['☀️', 'Darstellung: hell – antippen für automatisch'],
};

/** Knopf für die Kopfzeile: automatisch → dunkel → hell → automatisch */
export function themeButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'theme-btn';
  const show = () => {
    const [icon, label] = LABEL[themePref()];
    b.textContent = icon;
    b.title = label;
    b.setAttribute('aria-label', label);
  };
  b.addEventListener('click', () => {
    try {
      localStorage.setItem(KEY, NEXT[themePref()]);
    } catch {
      /* ohne Speicher nur für diese Seite */
    }
    applyTheme();
    show();
  });
  show();
  return b;
}

media?.addEventListener('change', applyTheme);
