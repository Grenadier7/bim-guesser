// Dunkelmodus: erzeugt client/src/dark.css aus client/src/style.css. Für jede Regel mit fester Farbe eine
// dunkle Entsprechung unter [data-theme='dark'] – helle Flächen werden dunkel (Farbton bleibt), dunkle Schrift hell,
// helle Rahmen dunkler. Die Grundfarben (--bg, --panel …) stehen von Hand am Anfang der erzeugten Datei.
// Nach Änderungen an style.css: npm run build:dark
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'client/src/style.css');
const OUT = path.join(ROOT, 'client/src/dark.css');

const BASE = `/* Erzeugt von scripts/build-dark-css.ts – nicht von Hand ändern (npm run build:dark) */

:root[data-theme='dark'] {
  --bg: #121418;
  --panel: #1c1f25;
  --ink: #e8eaee;
  --muted: #a3a9b5;
  --line: #2f343d;
  --accent: #ff3b47;
  --good: #3ccf7d;
  --warn: #f0a24a;
  --err: #ff6b6b;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 4px 16px rgb(0 0 0 / 0.35);
  color-scheme: dark;
}
[data-theme='dark'] .leaflet-container {
  background: #1a1d22;
}
[data-theme='dark'] .leaflet-bar a,
[data-theme='dark'] .leaflet-control-attribution {
  background: #23272e;
  color: #c9ced6;
  border-color: #2f343d;
}
[data-theme='dark'] .leaflet-tooltip {
  background: #23272e;
  color: #e8eaee;
  border-color: #2f343d;
}
[data-theme='dark'] input,
[data-theme='dark'] select,
[data-theme='dark'] textarea {
  background: #15181d;
  color: var(--ink);
  border-color: var(--line);
}
`;

// ---------------------------------------------------------------- Farben

type HSL = [number, number, number];

function parseHex(h: string): [number, number, number, number] | null {
  let x = h.slice(1);
  if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join('');
  if (x.length !== 6 && x.length !== 8) return null;
  const n = (i: number) => parseInt(x.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), x.length === 8 ? n(6) : 1];
}

function toHsl(r: number, g: number, b: number): HSL {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const fmt = ([h, s, l]: HSL, a = 1) =>
  `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%${a < 1 ? ` / ${Math.round(a * 100) / 100}` : ''})`;

type Role = 'bg' | 'text' | 'border';

/** statt var(--ink) als Fläche */
const INK_BG = '#3d4450';

/** null = Farbe bleibt */
function darken(hex: string, role: Role): string | null {
  const p = parseHex(hex);
  if (!p) return null;
  const [r, g, b, a] = p;
  const [h, s, l] = toHsl(r, g, b);
  if (role === 'bg') {
    if (l >= 0.97 && s < 0.2) return 'var(--panel)';
    if (l >= 0.8) return fmt([h, Math.min(s, 0.45), s < 0.1 ? 0.16 : 0.2], a);
    // mittlere Grautöne (Regler-Schienen …) umkehren, kräftige Farben (Knöpfe, Linienfarben) bleiben
    if (s < 0.12 && l > 0.55) return fmt([h, s, 1.05 - l], a);
    return null;
  }
  if (role === 'text') {
    if (l >= 0.9) return null; // weiße Schrift auf farbigen Knöpfen
    if (l < 0.55) return fmt([h, Math.min(s, 0.75), Math.max(0.72, 1 - l * 0.6)], a);
    return null;
  }
  // Rahmen
  if (l >= 0.7) return fmt([h, Math.min(s, 0.4), s < 0.1 ? 0.28 : 0.34], a);
  if (l < 0.3) return fmt([h, s, 0.6], a);
  return null;
}

function roleOf(prop: string): Role | null {
  if (prop === 'background' || prop === 'background-color' || prop === 'background-image') return 'bg';
  if (prop === 'color' || prop === 'fill' || prop === 'caret-color') return 'text';
  if (prop.startsWith('border') || prop === 'outline' || prop === 'outline-color' || prop === 'stroke') return 'border';
  return null;
}

// ---------------------------------------------------------------- CSS lesen

interface Rule {
  media: string | null;
  selector: string;
  decls: string;
}

function parse(css: string): Rule[] {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let i = 0;
  const block = (media: string | null) => {
    while (i < css.length) {
      const open = css.indexOf('{', i);
      const close = css.indexOf('}', i);
      if (close !== -1 && (open === -1 || close < open)) {
        i = close + 1;
        return; // Ende des umgebenden @media
      }
      if (open === -1) return void (i = css.length);
      const head = css.slice(i, open).trim();
      i = open + 1;
      if (head.startsWith('@media') || head.startsWith('@supports')) {
        block(head);
        continue;
      }
      if (head.startsWith('@')) {
        // @keyframes & Co. überspringen
        let depth = 1;
        while (i < css.length && depth) {
          if (css[i] === '{') depth++;
          else if (css[i] === '}') depth--;
          i++;
        }
        continue;
      }
      const end = css.indexOf('}', i);
      rules.push({ media, selector: head, decls: css.slice(i, end) });
      i = end + 1;
    }
  };
  block(null);
  return rules;
}

/** Selektorliste an Kommas der obersten Ebene trennen (nicht in :is(…), :not(…)) */
function splitSelectors(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of sel) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const scope = (sel: string) => {
  if (sel.startsWith(':root')) return `:root[data-theme='dark']${sel.slice(5)}`;
  if (/^html\b/.test(sel)) return `html[data-theme='dark']${sel.slice(4)}`;
  return `[data-theme='dark'] ${sel}`;
};

// ---------------------------------------------------------------- Erzeugen

const out: string[] = [BASE];
let count = 0;
for (const r of parse(readFileSync(SRC, 'utf8'))) {
  if (r.selector === ':root') continue;
  const decls: string[] = [];
  for (const d of r.decls.split(';')) {
    const m = /^\s*([a-z-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d);
    if (!m) continue;
    const role = roleOf(m[1]);
    // Flächen in Schriftfarbe (dunkle Knöpfe, Tooltips) würden im Dunkeln hell → eigenes Dunkelgrau, Schrift bleibt weiß
    const inkBg = role === 'bg' && m[2].includes('var(--ink)');
    if (!role || (!inkBg && !/#[0-9a-fA-F]{3,8}\b/.test(m[2]))) continue;
    let changed = inkBg;
    const value = m[2].replaceAll('var(--ink)', inkBg ? INK_BG : 'var(--ink)').replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => {
      const v = darken(hex, role);
      if (v) changed = true;
      return v ?? hex;
    });
    if (changed) decls.push(`  ${m[1]}: ${value};`);
  }
  if (!decls.length) continue;
  count++;
  const rule = `${splitSelectors(r.selector).map(scope).join(',\n')} {\n${decls.join('\n')}\n}`;
  out.push(r.media ? `${r.media} {\n${rule.replace(/^/gm, '  ')}\n}` : rule);
}
writeFileSync(OUT, `${out.join('\n\n')}\n`);
console.log(`dark.css: ${count} Regeln`);
