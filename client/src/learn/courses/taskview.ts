// Lernmodus – eine interaktive Aufgabe anzeigen: Karte vorbereiten (nichts verraten), Antwort einsammeln
// (Tippen, Zeichnen, Ordnen, Auswählen), bewerten und die Lösung auf der Karte zeigen.
import type { LatLon } from '../../../../shared/types.ts';
import { netLayer, netView } from '../../netmap.ts';
import { app, setMapBig } from '../../store.ts';
import { esc } from '../../ui.ts';
import { evaluateSketch, lineProfile } from '../model.ts';
import { L } from './common.ts';
import { areaHull, gradeMulti, gradeOrder, gradeSketch, gradeTapArea, gradeTapStation, type Grade, type Task, TASK_ICON } from './tasks.ts';

const NEUTRAL = '#3a3f47';
const MAX_SKETCH = 80;

/** Karte für die Frage: leere Stadtkarte bzw. nur die gezeigten Linien – ohne Namen und Nummern */
function prepareMap(task: Task) {
  app.map.clearLearn();
  app.map.onTap(null);
  const layer = netLayer();
  const show = task.kind === 'tapStation' || task.kind === 'order' ? task.show : task.kind === 'choice' ? task.show?.lines : undefined;
  const lines = (show ?? []).filter((id) => L(id));
  if (!lines.length) {
    layer.clear();
    app.map.overview();
  } else {
    const neutral = task.kind === 'choice' && task.show?.neutral;
    const pts = layer.render(
      netView({ focus: new Set(lines), only: new Set(lines), quiet: true, colors: neutral ? Object.fromEntries(lines.map((id) => [id, NEUTRAL])) : undefined }),
    );
    if (pts.length) app.map.fitPoints(pts, 13);
  }
  if (task.kind === 'draw') {
    app.map.showSketch([], [
      [task.from.lat, task.from.lon],
      [task.to.lat, task.to.lon],
    ]);
    app.map.fitPoints(
      [
        [task.from.lat, task.from.lon],
        [task.to.lat, task.to.lon],
      ],
      13,
    );
  }
  setMapBig(task.kind === 'tapStation' || task.kind === 'tapArea' || task.kind === 'draw');
}

/** Lösung auf der Karte: Linien normal, Ziel markiert, eigener Tipp daneben */
function revealMap(task: Task, tap: LatLon | null) {
  setMapBig(false);
  app.map.onTap(null);
  const layer = netLayer();
  const lineIds =
    task.kind === 'tapArea' ? task.lines : task.kind === 'draw' ? [task.line] : task.kind === 'choice' ? (task.show?.lines ?? []) : task.kind === 'tapStation' || task.kind === 'order' ? (task.show ?? []) : [];
  const colors = task.kind === 'tapArea' ? Object.fromEntries(task.lines.map((id) => [id, task.color])) : undefined;
  const marks = task.kind === 'tapStation' ? task.targets : task.kind === 'draw' ? [task.from, task.to] : [];
  const pts = layer.render(netView({ focus: new Set(lineIds.filter((id) => L(id))), colors, marks, allLabels: lineIds.length <= 12 }));
  if (task.kind === 'tapArea') app.map.showLearnArea({ rings: [areaHull(task)] }, false, true);
  if (tap) app.map.showTarget(tap[0], tap[1], 'dein Tipp');
  const fit: LatLon[] = [...pts, ...marks.map((s) => [s.lat, s.lon] as LatLon), ...(tap ? [tap] : [])];
  if (fit.length) app.map.fitPoints(fit, 14);
}

export interface TaskResult {
  ok: boolean;
  note: string;
}

/**
 * Aufgabe in `box` anzeigen; `done` wird nach dem Antworten mit dem Ergebnis gerufen (Lösung ist dann sichtbar).
 * Liefert eine Aufräum-Funktion (Karten-Tippen abmelden).
 */
export function mountTask(box: HTMLElement, task: Task, done: (r: TaskResult) => void): () => void {
  prepareMap(task);
  let answered: Grade | null = null;
  let tap: LatLon | null = null;
  const sketch: LatLon[] = [];
  const order: string[] = [];
  const picked = new Set<string>();
  const items = task.kind === 'order' ? [...task.items].sort(() => Math.random() - 0.5) : [];

  const finish = (g: Grade) => {
    answered = g;
    revealMap(task, task.kind === 'tapStation' || task.kind === 'tapArea' ? tap : null);
    if (task.kind === 'draw') app.map.showSketch([[task.from.lat, task.from.lon], ...sketch, [task.to.lat, task.to.lon]]);
    render();
    done({ ok: g.ok, note: g.note });
  };

  function body(): string {
    const a = answered;
    switch (task.kind) {
      case 'choice':
        return `<div class="quiz-options course-quiz">${task.options
          .map((o) => `<button data-o="${esc(o.id)}" class="${!a ? '' : o.id === task.correct ? 'right' : picked.has(o.id) ? 'wrong' : 'dim'}" ${a ? 'disabled' : ''}>${o.html}</button>`)
          .join('')}</div>`;
      case 'multi':
        return `<div class="quiz-options course-quiz multi">${task.options
          .map((o) => {
            const cls = !a ? (picked.has(o.id) ? 'on' : '') : task.correct.includes(o.id) ? 'right' : picked.has(o.id) ? 'wrong' : 'dim';
            return `<button data-m="${esc(o.id)}" class="${cls}" aria-pressed="${picked.has(o.id)}" ${a ? 'disabled' : ''}>${o.html}</button>`;
          })
          .join('')}</div>${a ? '' : `<button class="btn btn-primary" id="t-ok" ${picked.size ? '' : 'disabled'}>Antworten</button>`}`;
      case 'order':
        return `<ol class="order-picked">${order.map((id) => `<li>${esc(items.find((x) => x.id === id)!.label)}</li>`).join('')}</ol>
          ${
            a
              ? `<p class="muted">Richtig: ${task.items.map((x) => esc(x.label)).join(' → ')}</p>`
              : `<div class="quiz-options course-quiz">${items
                  .filter((x) => !order.includes(x.id))
                  .map((x) => `<button data-ord="${esc(x.id)}">${esc(x.label)}</button>`)
                  .join('')}</div>${order.length ? '<button class="link" id="t-undo">↶ letzte zurücknehmen</button>' : ''}`
          }`;
      case 'tapStation':
      case 'tapArea':
        return a
          ? ''
          : `<p class="hint">👆 ${tap ? 'Tipp gesetzt – du kannst ihn noch verschieben.' : 'Tippe auf die Karte.'}</p><button class="btn btn-primary" id="t-ok" ${tap ? '' : 'disabled'}>Antworten</button>`;
      case 'draw':
        return a
          ? ''
          : `<p class="hint">👆 Tippe den Verlauf von <b>A</b> nach <b>B</b> auf die Karte – ein Punkt bei jeder Kurve oder wichtigen Station (${sketch.length} Punkte).</p>
             <div class="learn-actions"><button class="btn btn-primary" id="t-ok" ${sketch.length >= 2 ? '' : 'disabled'}>Fertig</button>${sketch.length ? '<button class="btn btn-ghost" id="t-undo">↶ Rückgängig</button>' : ''}</div>`;
    }
  }

  function render() {
    const a = answered;
    box.innerHTML = `<h3>${TASK_ICON[task.kind]} ${esc(task.q)}</h3>${body()}${
      a ? `<p class="${a.ok ? 'good' : 'err'}">${a.ok ? '✔ Richtig' : '✖ Leider nicht'} – ${esc(a.note)}. ${esc(task.explain)}</p>` : ''
    }`;
    box.querySelectorAll<HTMLButtonElement>('[data-o]').forEach((b) =>
      b.addEventListener('click', () => {
        if (task.kind !== 'choice') return;
        picked.add(b.dataset.o!);
        finish({ ok: b.dataset.o === task.correct, note: b.dataset.o === task.correct ? 'genau' : 'falsch gewählt' });
      }),
    );
    box.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.m!;
        if (picked.has(id)) picked.delete(id);
        else picked.add(id);
        render();
      }),
    );
    box.querySelectorAll<HTMLButtonElement>('[data-ord]').forEach((b) =>
      b.addEventListener('click', () => {
        if (task.kind !== 'order') return;
        order.push(b.dataset.ord!);
        if (order.length === task.items.length) finish(gradeOrder(task, order));
        else render();
      }),
    );
    box.querySelector('#t-undo')?.addEventListener('click', () => {
      if (task.kind === 'order') order.pop();
      if (task.kind === 'draw') {
        sketch.pop();
        app.map.showSketch(sketch, ends());
      }
      render();
    });
    box.querySelector('#t-ok')?.addEventListener('click', () => {
      if (task.kind === 'multi') finish(gradeMulti(task, [...picked]));
      else if (task.kind === 'tapStation' && tap) finish(gradeTapStation(task, tap));
      else if (task.kind === 'tapArea' && tap) finish(gradeTapArea(task, tap));
      else if (task.kind === 'draw') {
        const r = evaluateSketch(lineProfile(app.net.lines.get(task.line)!), [[task.from.lat, task.from.lon], ...sketch, [task.to.lat, task.to.lon]]);
        finish(gradeSketch(r.coverage, r.precision));
      }
    });
  }

  const ends = (): [LatLon, LatLon] | undefined =>
    task.kind === 'draw'
      ? [
          [task.from.lat, task.from.lon],
          [task.to.lat, task.to.lon],
        ]
      : undefined;

  if (task.kind === 'tapStation' || task.kind === 'tapArea')
    app.map.onTap((p) => {
      if (answered) return;
      tap = p;
      app.map.clearLearn();
      app.map.showTarget(p[0], p[1], 'dein Tipp');
      render();
    });
  if (task.kind === 'draw')
    app.map.onTap((p) => {
      if (answered || sketch.length >= MAX_SKETCH) return;
      sketch.push(p);
      app.map.showSketch(sketch, ends());
      render();
    });

  render();
  return () => {
    app.map.onTap(null);
    setMapBig(false);
  };
}
