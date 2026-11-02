// Hell/Dunkel: startet hell; dunkel oder „wie das System“ per Knopf in der Kopfzeile. Setzt data-theme auf <html> –
// dark.css (erzeugt aus style.css) färbt danach um; die Karte tauscht die Kacheln (map.ts hört auf 'themechange').
export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'oeffi-theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'auto' || v === 'dark' ? v : 'light';
  } catch {
    return 'light';
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

const NEXT: Record<ThemePref, ThemePref> = { light: 'dark', dark: 'auto', auto: 'light' };
const LABEL: Record<ThemePref, [string, string]> = {
  light: ['☀️', 'Darstellung: hell – antippen für dunkel'],
  dark: ['🌙', 'Darstellung: dunkel – antippen für „wie das System“'],
  auto: ['🌗', 'Darstellung: wie das System – antippen für hell'],
};

/** Knopf für die Kopfzeile: hell → dunkel → wie das System → hell */
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
