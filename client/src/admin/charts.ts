// Grafiken der Admin-Seite (SVG, ohne Bibliothek): Verlauf als Linie mit Fadenkreuz, Tageswerte als gestapelte
// Säulen. Farben aus der geprüften Palette (Plätze 1–3, auch bei Farbschwäche unterscheidbar), dünne Linien, leises
// Raster, Werte im Tooltip; ab zwei Reihen mit Legende, darunter jeweils die Tabelle.
import { esc } from '../ui.ts';

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];

const W = 640;
const H = 180;
const PAD = { l: 34, r: 10, t: 10, b: 24 };

/** „schöne“ Obergrenze und Rasterlinien für die y-Achse */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

function grid(max: number): string {
  const ih = H - PAD.t - PAD.b;
  return [0, 0.5, 1]
    .map((f) => {
      const y = PAD.t + ih * (1 - f);
      return `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" class="ch-grid"/><text x="${PAD.l - 6}" y="${y + 4}" class="ch-axis" text-anchor="end">${Math.round(max * f)}</text>`;
    })
    .join('');
}

export interface LinePoint {
  t: number;
  v: number;
}

/** Verlauf einer Größe (eine Reihe → keine Legende, der Titel benennt sie) */
export function lineChart(id: string, title: string, points: LinePoint[], fmtT: (t: number) => string): string {
  if (!points.length) return `<figure class="chart"><figcaption>${esc(title)}</figcaption><p class="muted">Noch keine Daten – die ersten Werte kommen nach ein paar Minuten.</p></figure>`;
  const max = niceMax(Math.max(...points.map((p) => p.v)));
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t || t0 + 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw);
  const y = (v: number) => PAD.t + ih * (1 - v / max);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const ticks = [0, 0.5, 1].map((f) => t0 + (t1 - t0) * f);
  const last = points[points.length - 1];
  return `<figure class="chart" data-chart="${esc(id)}"><figcaption>${esc(title)} <b>${last.v}</b> <small class="muted">jetzt</small></figcaption>
    <div class="ch-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
      ${grid(max)}
      ${ticks.map((t, i) => `<text x="${x(t)}" y="${H - 6}" class="ch-axis" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${esc(fmtT(t))}</text>`).join('')}
      <path d="${path}" class="ch-line" style="stroke:${SERIES[0]}"/>
      <line class="ch-cross" y1="${PAD.t}" y2="${H - PAD.b}" hidden/><circle class="ch-dot" r="4" style="fill:${SERIES[0]}" hidden/>
      <rect class="ch-hit" x="${PAD.l}" y="${PAD.t}" width="${iw}" height="${ih}"/>
    </svg><div class="ch-tip" hidden></div></div>
    <details class="ch-table"><summary>Als Tabelle</summary><table>${points
      .slice(-48)
      .reverse()
      .map((p) => `<tr><td>${esc(fmtT(p.t))}</td><td>${p.v}</td></tr>`)
      .join('')}</table></details>
    <script type="application/json" class="ch-data">${JSON.stringify({ kind: 'line', pts: points.map((p) => [x(p.t), y(p.v), fmtT(p.t), p.v]) })}</script></figure>`;
}

export interface BarDay {
  label: string;
  values: number[];
}

/** gestapelte Säulen je Tag (Reihen in fester Farb-Reihenfolge) */
export function barChart(id: string, title: string, series: string[], days: BarDay[]): string {
  const total = (d: BarDay) => d.values.reduce((a, b) => a + b, 0);
  const max = niceMax(Math.max(1, ...days.map(total)));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / Math.max(1, days.length);
  const gap = Math.min(4, bw * 0.25);
  const sum = days.reduce((a, d) => a + total(d), 0);
  const bars = days
    .map((d, i) => {
      let y0 = PAD.t + ih;
      const x0 = PAD.l + i * bw + gap / 2;
      const w = Math.max(1, bw - gap);
      const rects = d.values
        .map((v, k) => {
          if (!v) return '';
          const hh = (v / max) * ih;
          y0 -= hh;
          // 2px Abstand zwischen gestapelten Teilen
          return `<rect x="${x0.toFixed(1)}" y="${(y0 + (k ? 1 : 0)).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, hh - (k ? 2 : 0)).toFixed(1)}" rx="2" style="fill:${SERIES[k]}"/>`;
        })
        .join('');
      return `<g class="ch-bar" data-i="${i}">${rects}<rect class="ch-hit" x="${PAD.l + i * bw}" y="${PAD.t}" width="${bw}" height="${ih}"/></g>`;
    })
    .join('');
  const ticks = days.length ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : [];
  return `<figure class="chart" data-chart="${esc(id)}"><figcaption>${esc(title)} <b>${sum}</b> <small class="muted">gesamt</small></figcaption>
    ${series.length > 1 ? `<div class="ch-legend">${series.map((s, k) => `<span><i style="background:${SERIES[k]}"></i>${esc(s)}</span>`).join('')}</div>` : ''}
    <div class="ch-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
      ${grid(max)}
      ${ticks.map((i, n) => `<text x="${PAD.l + i * bw + bw / 2}" y="${H - 6}" class="ch-axis" text-anchor="${n === 0 ? 'start' : n === 2 ? 'end' : 'middle'}">${esc(days[i].label)}</text>`).join('')}
      ${bars}
    </svg><div class="ch-tip" hidden></div></div>
    <details class="ch-table"><summary>Als Tabelle</summary><table><tr><th>Tag</th>${series.map((s) => `<th>${esc(s)}</th>`).join('')}</tr>${days
      .slice()
      .reverse()
      .map((d) => `<tr><td>${esc(d.label)}</td>${d.values.map((v) => `<td>${v}</td>`).join('')}</tr>`)
      .join('')}</table></details>
    <script type="application/json" class="ch-data">${JSON.stringify({ kind: 'bar', series, days })}</script></figure>`;
}

/** Tooltips: Linie → Fadenkreuz am nächsten Punkt; Säulen → Werte des Tages */
export function bindCharts(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('figure.chart').forEach((fig) => {
    const data = fig.querySelector('.ch-data');
    const svg = fig.querySelector('svg');
    const tip = fig.querySelector<HTMLElement>('.ch-tip');
    if (!data || !svg || !tip) return;
    const d = JSON.parse(data.textContent!) as { kind: 'line'; pts: [number, number, string, number][] } | { kind: 'bar'; series: string[]; days: BarDay[] };
    const place = (px: number, py: number, html: string) => {
      tip.innerHTML = html;
      tip.hidden = false;
      const box = svg.getBoundingClientRect();
      const sx = box.width / W;
      tip.style.left = `${Math.min(box.width - 150, Math.max(0, px * sx - 60))}px`;
      tip.style.top = `${Math.max(0, py * (box.height / H) - 52)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      svg.querySelector('.ch-cross')?.setAttribute('hidden', '');
      svg.querySelector('.ch-dot')?.setAttribute('hidden', '');
    };
    svg.addEventListener('mouseleave', hide);
    if (d.kind === 'line') {
      const cross = svg.querySelector('.ch-cross')!;
      const dot = svg.querySelector('.ch-dot')!;
      svg.addEventListener('mousemove', (e) => {
        const box = svg.getBoundingClientRect();
        const mx = ((e.clientX - box.left) / box.width) * W;
        let best = d.pts[0];
        for (const p of d.pts) if (Math.abs(p[0] - mx) < Math.abs(best[0] - mx)) best = p;
        cross.setAttribute('x1', String(best[0]));
        cross.setAttribute('x2', String(best[0]));
        cross.removeAttribute('hidden');
        dot.setAttribute('cx', String(best[0]));
        dot.setAttribute('cy', String(best[1]));
        dot.removeAttribute('hidden');
        place(best[0], best[1], `<b>${best[3]}</b><br><small>${esc(best[2])}</small>`);
      });
    } else {
      svg.querySelectorAll<SVGGElement>('.ch-bar').forEach((g) =>
        g.addEventListener('mousemove', () => {
          const i = Number(g.dataset.i);
          const day = d.days[i];
          const hit = g.querySelector('.ch-hit')!;
          const x = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2;
          place(x, PAD.t + 30, `<b>${esc(day.label)}</b><br>${d.series.map((s, k) => `<span class="ch-sw" style="background:${SERIES[k]}"></span>${esc(s)}: <b>${day.values[k]}</b>`).join('<br>')}`);
        }),
      );
    }
  });
}
