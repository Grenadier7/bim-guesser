// Grafiken der Admin-Seite (SVG, ohne Bibliothek): Verlauf als Linie mit Fadenkreuz, Tageswerte als gestapelte
// Säulen, Ranglisten als waagrechte Balken. Farben aus der geprüften Palette (Plätze 1–3, auch bei Farbschwäche
// unterscheidbar), dünne Linien, leises Raster, Werte im Tooltip; ab zwei Reihen mit Legende (mit aktuellem Wert),
// darunter jeweils die Tabelle. Größe in SVG-Einheiten ≈ Bildschirmpixel, damit Schrift und Linien lesbar bleiben.
import { esc } from '../ui.ts';

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];

interface Size {
  w: number;
  h: number;
}
const NORMAL: Size = { w: 440, h: 190 };
const WIDE: Size = { w: 900, h: 220 };
const PAD = { l: 36, r: 12, t: 12, b: 26 };

/** „schöne“ Obergrenze für die y-Achse */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

function grid(max: number, z: Size): string {
  const ih = z.h - PAD.t - PAD.b;
  return [0, 0.5, 1]
    .map((f) => {
      const y = PAD.t + ih * (1 - f);
      // Mitte nur beschriften, wenn sie eine ganze Zahl ist (25 → kein „13“)
      const label = Number.isInteger(max * f) ? `<text x="${PAD.l - 6}" y="${y + 4}" class="ch-axis" text-anchor="end">${max * f}</text>` : '';
      return `<line x1="${PAD.l}" x2="${z.w - PAD.r}" y1="${y}" y2="${y}" class="ch-grid"/>${label}`;
    })
    .join('');
}

const legend = (items: { name: string; value?: number }[]) =>
  `<div class="ch-legend">${items.map((x, k) => `<span><i style="background:${SERIES[k]}"></i>${esc(x.name)}${x.value != null ? ` <b>${x.value}</b>` : ''}</span>`).join('')}</div>`;

export interface LinePoint {
  t: number;
  v: number;
}

export interface LineSeries {
  name: string;
  points: LinePoint[];
}

/** Verlauf einer oder mehrerer Größen über die Zeit; Legende mit dem aktuellen Wert, Tooltip mit allen Werten */
export function lineChart(id: string, title: string, series: LineSeries[], fmtT: (t: number) => string, wide = false, fmtTip: (t: number) => string = fmtT): string {
  const z = wide ? WIDE : NORMAL;
  const pts = series[0]?.points ?? [];
  if (!pts.length) return `<figure class="chart ${wide ? 'wide' : ''}"><figcaption>${esc(title)}</figcaption><p class="muted ch-empty">Noch keine Daten – die ersten Werte kommen nach ein paar Minuten.</p></figure>`;
  const max = niceMax(Math.max(1, ...series.flatMap((x) => x.points.map((p) => p.v))));
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const iw = z.w - PAD.l - PAD.r;
  const ih = z.h - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw);
  const y = (v: number) => PAD.t + ih * (1 - v / max);
  const paths = series
    .map((se, k) => `<path d="${se.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}" class="ch-line" style="stroke:${SERIES[k]}"/>`)
    .join('');
  const ticks = (wide ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1]).map((f) => t0 + (t1 - t0) * f);
  const last = (se: LineSeries) => se.points[se.points.length - 1].v;
  return `<figure class="chart ${wide ? 'wide' : ''}" data-chart="${esc(id)}"><figcaption>${esc(title)}${series.length === 1 ? ` <b>${last(series[0])}</b> <small class="muted">jetzt</small>` : ''}</figcaption>
    ${series.length > 1 ? legend(series.map((se) => ({ name: se.name, value: last(se) }))) : ''}
    <div class="ch-wrap"><svg viewBox="0 0 ${z.w} ${z.h}" role="img" aria-label="${esc(title)}">
      ${grid(max, z)}
      ${ticks.map((t, i) => `<text x="${x(t)}" y="${z.h - 7}" class="ch-axis" text-anchor="${i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}">${esc(fmtT(t))}</text>`).join('')}
      ${paths}
      <line class="ch-cross" y1="${PAD.t}" y2="${z.h - PAD.b}" hidden/>${series.map((_, k) => `<circle class="ch-dot" r="4" style="fill:${SERIES[k]}" hidden/>`).join('')}
      <rect class="ch-hit" x="${PAD.l}" y="${PAD.t}" width="${iw}" height="${ih}"/>
    </svg><div class="ch-tip" hidden></div></div>
    <details class="ch-table"><summary>Als Tabelle</summary><table><tr><th>Zeit</th>${series.map((se) => `<th>${esc(se.name)}</th>`).join('')}</tr>${pts
      .map((p, i) => `<tr><td>${esc(fmtTip(p.t))}</td>${series.map((se) => `<td>${se.points[i]?.v ?? ''}</td>`).join('')}</tr>`)
      .slice(-48)
      .reverse()
      .join('')}</table></details>
    <script type="application/json" class="ch-data">${JSON.stringify({ kind: 'line', names: series.map((se) => se.name), pts: pts.map((p, i) => [x(p.t), fmtTip(p.t), series.map((se) => [y(se.points[i]?.v ?? 0), se.points[i]?.v ?? 0])]) })}</script></figure>`;
}

export interface BarDay {
  label: string;
  values: number[];
}

/** gestapelte Säulen je Tag (Reihen in fester Farb-Reihenfolge); Legende mit Summe je Reihe */
export function barChart(id: string, title: string, series: string[], days: BarDay[], wide = false): string {
  const z = wide ? WIDE : NORMAL;
  const total = (d: BarDay) => d.values.reduce((a, b) => a + b, 0);
  const max = niceMax(Math.max(1, ...days.map(total)));
  const iw = z.w - PAD.l - PAD.r;
  const ih = z.h - PAD.t - PAD.b;
  const bw = iw / Math.max(1, days.length);
  const gap = Math.min(6, bw * 0.25);
  const sums = series.map((_, k) => days.reduce((a, d) => a + d.values[k], 0));
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
  // Tagesbeschriftung: bei vielen Tagen nur einzelne
  const step = Math.max(1, Math.ceil(days.length / (wide ? 12 : 6)));
  const labels = days
    .map((d, i) => (i % step === 0 || i === days.length - 1 ? `<text x="${PAD.l + i * bw + bw / 2}" y="${z.h - 7}" class="ch-axis" text-anchor="middle">${esc(d.label)}</text>` : ''))
    .join('');
  return `<figure class="chart ${wide ? 'wide' : ''}" data-chart="${esc(id)}"><figcaption>${esc(title)}${series.length === 1 ? ` <b>${sums[0]}</b> <small class="muted">gesamt</small>` : ''}</figcaption>
    ${series.length > 1 ? legend(series.map((s, k) => ({ name: s, value: sums[k] }))) : ''}
    <div class="ch-wrap"><svg viewBox="0 0 ${z.w} ${z.h}" role="img" aria-label="${esc(title)}">${grid(max, z)}${labels}${bars}</svg><div class="ch-tip" hidden></div></div>
    <details class="ch-table"><summary>Als Tabelle</summary><table><tr><th>Tag</th>${series.map((s) => `<th>${esc(s)}</th>`).join('')}</tr>${days
      .slice()
      .reverse()
      .map((d) => `<tr><td>${esc(d.label)}</td>${d.values.map((v) => `<td>${v}</td>`).join('')}</tr>`)
      .join('')}</table></details>
    <script type="application/json" class="ch-data">${JSON.stringify({ kind: 'bar', series, days, top: PAD.t })}</script></figure>`;
}

/** Rangliste als waagrechte Balken (eine Farbe, Wert am Balkenende), Beschriftung als HTML (z.B. Linien-Chips) */
export function rankChart(title: string, rows: { label: string; n: number }[], note = ''): string {
  if (!rows.length) return `<figure class="chart ch-rankfig"><figcaption>${esc(title)}</figcaption><p class="muted ch-empty">Noch keine Daten.</p></figure>`;
  const max = Math.max(...rows.map((r) => r.n));
  const sum = rows.reduce((a, r) => a + r.n, 0);
  return `<figure class="chart ch-rankfig"><figcaption>${esc(title)} ${note ? `<small class="muted">${esc(note)}</small>` : ''}</figcaption>
    <div class="ch-rank">${rows
      .map(
        (r) => `<div class="ch-rrow" title="${r.n}-mal gewählt · ${Math.round((r.n / sum) * 100)} %"><span class="ch-rlabel">${r.label}</span>
          <span class="ch-rbar"><i style="width:${Math.max(1, (r.n / max) * 100)}%;background:${SERIES[0]}"></i></span><b>${r.n}</b></div>`,
      )
      .join('')}</div></figure>`;
}

/** Tooltips: Linie → Fadenkreuz am nächsten Zeitpunkt mit allen Werten; Säulen → Werte des Tages */
export function bindCharts(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('figure.chart').forEach((fig) => {
    const data = fig.querySelector('.ch-data');
    const svg = fig.querySelector('svg');
    const tip = fig.querySelector<HTMLElement>('.ch-tip');
    if (!data || !svg || !tip) return;
    const vb = svg.viewBox.baseVal;
    const d = JSON.parse(data.textContent!) as { kind: 'line'; names: string[]; pts: [number, string, [number, number][]][] } | { kind: 'bar'; series: string[]; days: BarDay[]; top: number };
    const place = (px: number, py: number, html: string) => {
      tip.innerHTML = html;
      tip.hidden = false;
      const box = svg.getBoundingClientRect();
      const sx = box.width / vb.width;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(box.width - tw, Math.max(0, px * sx - tw / 2))}px`;
      tip.style.top = `${Math.max(0, py * (box.height / vb.height) - tip.offsetHeight - 10)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      svg.querySelector('.ch-cross')?.setAttribute('hidden', '');
      svg.querySelectorAll('.ch-dot').forEach((x) => x.setAttribute('hidden', ''));
    };
    svg.addEventListener('mouseleave', hide);
    if (d.kind === 'line') {
      const cross = svg.querySelector('.ch-cross')!;
      const dots = [...svg.querySelectorAll('.ch-dot')];
      svg.addEventListener('mousemove', (e) => {
        const box = svg.getBoundingClientRect();
        const mx = ((e.clientX - box.left) / box.width) * vb.width;
        let best = d.pts[0];
        for (const p of d.pts) if (Math.abs(p[0] - mx) < Math.abs(best[0] - mx)) best = p;
        cross.setAttribute('x1', String(best[0]));
        cross.setAttribute('x2', String(best[0]));
        cross.removeAttribute('hidden');
        best[2].forEach(([cy], k) => {
          dots[k].setAttribute('cx', String(best[0]));
          dots[k].setAttribute('cy', String(cy));
          dots[k].removeAttribute('hidden');
        });
        const vals = best[2].map(([, v], k) => (d.names.length > 1 ? `<span class="ch-sw" style="background:${SERIES[k]}"></span>${esc(d.names[k])}: <b>${v}</b>` : `<b>${v}</b>`)).join('<br>');
        place(best[0], Math.min(...best[2].map(([cy]) => cy)), `${vals}<br><small>${esc(best[1])}</small>`);
      });
    } else {
      svg.querySelectorAll<SVGGElement>('.ch-bar').forEach((g) =>
        g.addEventListener('mousemove', () => {
          const day = d.days[Number(g.dataset.i)];
          const hit = g.querySelector('.ch-hit')!;
          const x = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2;
          place(x, d.top + 40, `<b>${esc(day.label)}</b><br>${d.series.map((s, k) => `<span class="ch-sw" style="background:${SERIES[k]}"></span>${esc(s)}: <b>${day.values[k]}</b>`).join('<br>')}`);
        }),
      );
    }
  });
}
