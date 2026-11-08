// Lernmodus – eine interaktive Aufgabe anzeigen: Karte vorbereiten (nichts verraten), Antwort einsammeln
// (Tippen, Zeichnen, Ordnen, Auswählen), bewerten und die Lösung auf der Karte zeigen.
import type { LatLon } from '../../../../shared/types.ts';
import { netLayer, netView } from '../../netmap.ts';
import { app, setMapBig } from '../../store.ts';
import { esc, lineChip } from '../../ui.ts';
import { evaluateSketch, lineProfile } from '../model.ts';
import { L } from './common.ts';
import { areaHull, gradeAssign, gradeMulti, gradeOrder, gradeSketch, gradeTapArea, gradeTapStation, type Grade, type Task, TASK_ICON } from './tasks.ts';

const NEUTRAL = '#3a3f47';
const MAX_SKETCH = 80;

/** Karte für die Frage: leere Stadtkarte bzw. nur die gezeigten Linien – ohne Namen und Nummern */
function prepareMap(task: Task) {
  app.map.clearLearn();
  app.map.onTap(null);
  const layer = netLayer();
  const show = task.kind === 'tapStation' || task.kind === 'order' ? task.show : task.kind === 'choice' ? task.show?.lines : undefined;
  const lines = (show ?? []).filter((id) => L(id));
  if (task.kind === 'assign') {
    // farbige Abschnitte mit Buchstaben, sonst nur blass das Netz dieser Art
    const only = new Set((task.show ?? []).filter((id) => L(id)));
    const pts = layer.render(netView({ focus: new Set(), only, quiet: true, pieces: task.slots.map((s) => ({ ...s.piece, color: s.color, label: s.key, labelFrac: s.piece.labelFrac ?? 0.6 })) }));
    if (pts.length) app.map.fitPoints(pts, 13, 0.06);
  } else if (!lines.length) {
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
    app.map.showLearnEnds(task.from, task.to);
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
    task.kind === 'tapArea'
      ? task.lines
      : task.kind === 'draw'
        ? [task.line]
        : task.kind === 'choice'
          ? (task.show?.lines ?? [])
          : task.kind === 'tapStation'
            ? (task.reveal ?? task.show ?? [])
            : task.kind === 'order'
              ? (task.show ?? [])
              : [];
  const colors = task.kind === 'tapArea' ? Object.fromEntries(task.lines.map((id) => [id, task.color])) : undefined;
  const marks = task.kind === 'tapStation' ? task.targets : task.kind === 'draw' ? [task.from, task.to] : [];
  if (task.kind === 'assign') {
    // Auflösung: dieselben Abschnitte, jetzt mit der richtigen Beschriftung
    const only = new Set((task.show ?? []).filter((id) => L(id)));
    const pts = layer.render(netView({ focus: new Set(), only, quiet: true, pieces: task.slots.map((s) => ({ ...s.piece, color: s.color, label: s.answer, labelFrac: s.piece.labelFrac ?? 0.6 })) }));
    if (pts.length) app.map.fitPoints(pts, 13, 0.06);
    return;
  }
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
  // Reihenfolge: die erste Station ist vorgegeben
  const order: string[] = task.kind === 'order' ? [task.items[0].id] : [];
  const picked = new Set<string>();
  const items = task.kind === 'order' ? [...task.items].sort(() => Math.random() - 0.5) : [];
  const orderLabel = (id: string) => (task.kind === 'order' ? task.items.find((x) => x.id === id)!.label : '');
  // Zuordnen: Buchstabe → gewählte Beschriftung; angetippte Beschriftung wartet auf ihren Abschnitt
  const assigned: Record<string, string> = {};
  let held: string | null = null;
  const labels = task.kind === 'assign' ? [...task.slots.map((s) => s.answer)].sort(() => Math.random() - 0.5) : [];
  const labelHtml = (x: string) => {
    const l = app.net.lines.get(x);
    return l ? lineChip(l.mode, l.id, l.color) : `<span class="line-chip assign-group">${esc(x)}</span>`;
  };

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
        return `<ol class="order-picked">${order.map((id, k) => `<li>${esc(orderLabel(id))}${k === 0 ? ' <small class="muted">(Start)</small>' : ''}</li>`).join('')}</ol>
          ${
            a
              ? `<p class="muted">Richtig: ${task.items.map((x) => esc(x.label)).join(' → ')}</p>`
              : `<div class="quiz-options course-quiz">${items
                  .filter((x) => !order.includes(x.id))
                  .map((x) => `<button data-ord="${esc(x.id)}">${esc(x.label)}</button>`)
                  .join('')}</div>${order.length > 1 ? '<button class="link" id="t-undo">↶ letzte zurücknehmen</button>' : ''}`
          }`;
      case 'assign': {
        const free = labels.filter((x) => !Object.values(assigned).includes(x));
        const done = Object.keys(assigned).length === task.slots.length;
        return `${
          a
            ? ''
            : `<p class="hint">👆 Ziehe jede Linie auf ihren Buchstaben – oder tippe erst die Linie, dann den Buchstaben.</p>
               <div class="assign-pool">${free.map((x) => `<button class="assign-label ${held === x ? 'held' : ''}" draggable="true" data-lab="${esc(x)}">${labelHtml(x)}</button>`).join('') || '<small class="muted">Alle verteilt.</small>'}</div>`
        }
          <div class="assign-slots">${task.slots
            .map((s) => {
              const got = assigned[s.key];
              const cls = !a ? '' : got === s.answer ? 'right' : 'wrong';
              return `<div class="assign-slot ${cls}" data-slot="${esc(s.key)}"><span class="assign-key" style="--c:${s.color}">${esc(s.key)}</span>
                <span class="assign-drop">${got ? `<button class="assign-label" data-back="${esc(s.key)}" ${a ? 'disabled' : ''}>${labelHtml(got)}</button>` : '<small class="muted">hierher ziehen</small>'}</span>
                ${a && got !== s.answer ? `<small class="assign-right">richtig: ${labelHtml(s.answer)}</small>` : ''}</div>`;
            })
            .join('')}</div>
          ${a ? '' : `<button class="btn btn-primary" id="t-ok" ${done ? '' : 'disabled'}>Antworten</button>`}`;
      }
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
      if (task.kind === 'order' && order.length > 1) order.pop();
      if (task.kind === 'draw') {
        sketch.pop();
        app.map.showSketch(sketch, ends());
      }
      render();
    });
    if (task.kind === 'assign' && !answered) {
      const place = (lab: string, key: string) => {
        for (const k of Object.keys(assigned)) if (assigned[k] === lab) delete assigned[k];
        assigned[key] = lab;
        held = null;
        render();
      };
      box.querySelectorAll<HTMLElement>('[data-lab]').forEach((b) => {
        b.addEventListener('click', () => {
          held = held === b.dataset.lab ? null : b.dataset.lab!;
          render();
        });
        b.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', b.dataset.lab!));
      });
      box.querySelectorAll<HTMLElement>('[data-back]').forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          delete assigned[b.dataset.back!];
          render();
        }),
      );
      box.querySelectorAll<HTMLElement>('[data-slot]').forEach((slot) => {
        slot.addEventListener('click', () => held && place(held, slot.dataset.slot!));
        slot.addEventListener('dragover', (e) => {
          e.preventDefault();
          slot.classList.add('over');
        });
        slot.addEventListener('dragleave', () => slot.classList.remove('over'));
        slot.addEventListener('drop', (e) => {
          e.preventDefault();
          const lab = e.dataTransfer?.getData('text/plain');
          if (lab) place(lab, slot.dataset.slot!);
        });
      });
    }
    box.querySelector('#t-ok')?.addEventListener('click', () => {
      if (task.kind === 'assign') finish(gradeAssign(task, assigned));
      else if (task.kind === 'multi') finish(gradeMulti(task, [...picked]));
      else if (task.kind === 'tapStation' && tap) finish(gradeTapStation(task, tap));
      else if (task.kind === 'tapArea' && tap) finish(gradeTapArea(task, tap));
      else if (task.kind === 'draw') {
        // grob zeichnen reicht: 900 m neben einer Station zählt noch
        const r = evaluateSketch(lineProfile(app.net.lines.get(task.line)!), [[task.from.lat, task.from.lon], ...sketch, [task.to.lat, task.to.lon]], 900);
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
      // nur den alten Tipp weg – die eingezeichnete Linie bleibt stehen
      app.map.clearLearnMarks();
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
    // eigener Tipp, A/B und Zeichnung gehören zu dieser Aufgabe – im nächsten Schritt weg
    app.map.clearLearnMarks();
    app.map.showSketch([]);
    if (task.kind === 'tapArea') app.map.showLearnArea(null, false);
  };
}
