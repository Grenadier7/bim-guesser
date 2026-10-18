// Lernmodus – geführte Kurse: Konzepte des Wiener Netzes Schritt für Schritt (Karte + Erklärung + kleine Fragen).
// Die Inhalte (Kreuzungen, Endstationen, Nachtlinien, Busnummern …) werden aus den Netzdaten berechnet.
// Jeder Kurs liegt in einer eigenen Datei; hier: Reihenfolge (Lernpfad), Fortschritt und die Ansicht.
//
// Die Karte ist immer dieselbe Netzkarte (netmap.ts); jeder Schritt blendet nur Linien und Abschnitte hervor
// oder aus. Farben wie dort: U-Bahn in Linienfarben, S-Bahn blau, Badner Bahn türkis, Bim dunkelrot, Busse schiefergrau.
import { netLayer, netView, NO_BANDS } from '../../netmap.ts';
import { app, setMapBig } from '../../store.ts';
import { esc, h, lineChip } from '../../ui.ts';
import { lineHtml, stationHtml } from '../atlas.ts';
import { DAY_SCOPE, addMine, departuresFrom, isMine, isSpecialLine, lineProfile, linesAt, patternsOf, setMine } from '../model.ts';
import { L, type Course, type Step } from './common.ts';
import { COURSES } from './list.ts';

export type { Course } from './common.ts';
export { COURSES };


// ---------------------------------------------------------------- Fortschritt

const PROGRESS_KEY = 'oeffi-courses-v1';
type Progress = Record<string, { done: boolean; best: number; total: number }>;
export function courseProgress(): Progress {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}') as Progress;
  } catch {
    return {};
  }
}
function saveProgress(id: string, score: number, total: number) {
  const p = courseProgress();
  p[id] = { done: true, best: Math.max(p[id]?.best ?? 0, score), total };
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* privater Modus */
  }
}

// ---------------------------------------------------------------- Ansicht

function drawStep(step: Step) {
  const layer = netLayer();
  const known = (id: string) => !!L(id);
  const focus = new Set((step.lines ?? []).filter(known));
  const context = new Set((step.context ?? []).filter((id) => known(id) && !focus.has(id)));
  const marks = step.marks ?? [];
  const view = netView({ focus, context, colors: step.colors, pieces: step.pieces, marks, bands: { ...NO_BANDS, ...step.bands }, allLabels: step.allLabels });
  if (step.quiz || (!focus.size && !context.size && !step.pieces?.length && !marks.length)) {
    // Fragen: leere Karte – die Netzkarte (Namen beim Drüberfahren) würde die Antwort verraten
    layer.clear();
    app.map.overview();
    return;
  }
  const pts = layer.render(view);
  const fit = step.fitMarks && marks.length ? marks.map((s) => [s.lat, s.lon] as [number, number]) : pts;
  if (fit.length) app.map.fitPoints(fit, 14);
}

/** Einen Kurs durchgehen: Schritt für Schritt, Fragen beantworten, am Ende Ergebnis */
export function courseView(panel: HTMLElement, course: Course, onBack: () => void) {
  setMapBig(false);
  // Fokusgebiet, Haltestellen-Punkte usw. aus dem Lernmodus weg
  app.map.clear();
  const steps = course.build();
  const answers = new Map<number, boolean>();
  const chosen = new Map<number, string>();
  let i = 0;

  function render() {
    const total = steps.length;
    const quizCount = steps.filter((s) => s.quiz).length;
    if (i >= total) return renderDone(quizCount);
    const st = steps[i];
    drawStep(st);
    const answered = answers.has(i);
    const el = h(
      'div',
      { class: 'learn course' },
      `<button class="link" id="cback">← Lernen</button>
       <div class="course-head"><span class="cc-icon">${course.icon}</span><h2>${esc(course.title)}</h2></div>
       <div class="learn-progress"><div class="bar"><i style="width:${Math.round((i / total) * 100)}%"></i></div><small>Schritt ${i + 1} von ${total}</small></div>
       <div class="learn-card course-step"><h3>${st.quiz ? '❓ ' : ''}${esc(st.quiz ? st.quiz.q : st.title)}</h3>${st.html}
         ${
           st.quiz
             ? `<div class="quiz-options course-quiz">${st.quiz.options
                 .map((o) => {
                   const cls = !answered ? '' : o.id === st.quiz!.correct ? 'right' : o.id === chosen.get(i) ? 'wrong' : 'dim';
                   return `<button data-o="${esc(o.id)}" class="${cls}" ${answered ? 'disabled' : ''}>${o.html}</button>`;
                 })
                 .join('')}</div>
               ${answered ? `<p class="${answers.get(i) ? 'good' : 'err'}">${answers.get(i) ? '✔ Richtig!' : '✖ Leider falsch.'} ${esc(st.quiz.explain)}</p>` : ''}`
             : ''
         }</div>
       <div class="learn-actions"><button class="btn btn-primary" id="next" ${st.quiz && !answered ? 'disabled' : ''}>${i + 1 === total ? 'Abschließen ✓' : 'Weiter →'}</button>
         <button class="btn btn-ghost" id="prev" ${i === 0 ? 'disabled' : ''}>← Zurück</button></div>`,
    );
    panel.innerHTML = '';
    panel.append(el);
    panel.scrollTop = 0;
    el.querySelector('#cback')!.addEventListener('click', onBack);
    el.querySelector('#prev')!.addEventListener('click', () => {
      i = Math.max(0, i - 1);
      render();
    });
    el.querySelector('#next')!.addEventListener('click', () => {
      i++;
      render();
    });
    el.querySelectorAll<HTMLButtonElement>('[data-o]').forEach((b) =>
      b.addEventListener('click', () => {
        chosen.set(i, b.dataset.o!);
        answers.set(i, b.dataset.o === st.quiz!.correct);
        render();
      }),
    );
    // Liniennummer im Text antippen → Steckbrief (nicht in den Antwortknöpfen einer Frage)
    el.querySelector('.course-step')!.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-o]')) return;
      const id = t.closest<HTMLElement>('.chip-link[data-line]')?.dataset.line;
      if (id) card({ kind: 'line', id });
    });
  }

  /** Steckbrief bzw. „Von hier“ mitten im Kurs – „← zurück zum Kurs“ führt zum selben Schritt */
  function card(sel: { kind: 'line' | 'station'; id: string }) {
    const layer = netLayer();
    app.map.clearLearn();
    const open = (next: { kind: 'line' | 'station'; id: string }) => card(next);
    if (sel.kind === 'line') {
      const l = app.net.lines.get(sel.id)!;
      const prof = lineProfile(l);
      const stops = [...new Set(patternsOf(l).flat())].map((id) => app.net.station(id));
      const pts = layer.render(
        netView({
          focus: new Set([l.id]),
          marks: prof.waypoints.map((id) => app.net.station(id)),
          stops,
          onStation: (id) => open({ kind: 'station', id }),
          onLine: (id) => open({ kind: 'line', id }),
        }),
      );
      if (pts.length) app.map.fitPoints(pts, 14);
    } else {
      const st = app.net.station(sel.id);
      layer.render(netView({ focus: new Set(linesAt(st, DAY_SCOPE()).map((l) => l.id)), marks: [st], onLine: (id) => open({ kind: 'line', id }) }));
      app.map.zoomTo(st.lat, st.lon, 14);
    }
    const body = sel.kind === 'line' ? lineHtml(app.net.lines.get(sel.id)!, false) : stationHtml(app.net.station(sel.id));
    panel.innerHTML = `<div class="learn course atlas">
      <button class="link" id="to-course">← zurück zum Kurs: ${esc(course.title)}</button>${body}</div>`;
    panel.scrollTop = 0;
    const root = panel.querySelector('.atlas')!;
    root.querySelector('#to-course')!.addEventListener('click', render);
    root.querySelector('#star-all')?.addEventListener('click', () => {
      addMine(departuresFrom(app.net.station(sel.id), DAY_SCOPE()).map((d) => d.line.id).filter((id) => !isSpecialLine(app.net.lines.get(id)!)));
      card(sel);
    });
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const star = t.closest<HTMLElement>('[data-star]')?.dataset.star;
      if (star) {
        setMine(star, !isMine(star));
        return card(sel);
      }
      const id = t.closest<HTMLElement>('[data-line]')?.dataset.line;
      if (id) return open({ kind: 'line', id });
      const stId = t.closest<HTMLElement>('[data-st]')?.dataset.st;
      if (stId) open({ kind: 'station', id: stId });
    });
  }

  /** Linien, um die es im Kurs ging (nicht die blassen Verbindungslinien) */
  const courseLines = [...new Set(steps.flatMap((s) => [...(s.lines ?? []), ...(s.pieces ?? []).map((p) => p.line)]))].filter((id) => {
    const l = L(id);
    return l && !isSpecialLine(l);
  });
  /** mehr als so viele Linien (z.B. alle Busse) sind zu viel für einmal Üben */
  const MAX_TO_PRACTICE = 25;

  /** Am Kursende: die Linien des Kurses in „Üben“ aufnehmen */
  function practiceHtml(): string {
    if (!courseLines.length || courseLines.length > MAX_TO_PRACTICE) return '';
    const missing = courseLines.filter((id) => !isMine(id));
    const chipsHtml = courseLines.map((id) => {
      const l = app.net.lines.get(id)!;
      return `<span class="${isMine(id) ? '' : 'dim-chip'}">${lineChip(l.mode, l.id, l.color)}</span>`;
    });
    return `<div class="learn-card"><h3>🏋 Weiterüben</h3>
      <p>In diesem Kurs ging es um ${courseLines.length} Linien:</p><div class="chips">${chipsHtml.join('')}</div>
      ${
        missing.length
          ? `<div class="card-actions"><button class="btn btn-primary" id="to-practice">⭐ ${missing.length === courseLines.length ? 'Alle' : `Die fehlenden ${missing.length}`} zum Üben merken</button></div>`
          : '<p class="good">⭐ Alle gemerkt – du findest sie unter Lernen → Üben.</p>'
      }</div>`;
  }

  function renderDone(quizCount: number) {
    const score = [...answers.values()].filter(Boolean).length;
    saveProgress(course.id, score, quizCount);
    netLayer().render(netView());
    app.map.overview();
    panel.innerHTML = '';
    const el = h(
      'div',
      { class: 'learn course' },
      `<div class="course-head"><span class="cc-icon">${course.icon}</span><h2>${esc(course.title)}</h2></div>
       <div class="learn-card"><h3>🎉 Kurs geschafft!</h3>
         ${quizCount ? `<p><b>${score} von ${quizCount}</b> Fragen richtig.</p>` : ''}
         <p class="muted">Die Fragen sind bei jedem Durchgang etwas anders – nochmal machen lohnt sich.</p></div>
       ${practiceHtml()}
       <div class="learn-actions"><button class="btn btn-primary" id="list">Zum Lernpfad</button><button class="btn btn-ghost" id="again">Nochmal</button></div>`,
    );
    panel.append(el);
    el.querySelector('#to-practice')?.addEventListener('click', () => {
      addMine(courseLines);
      renderDone(quizCount);
    });
    el.querySelector('#list')!.addEventListener('click', onBack);
    el.querySelector('#again')!.addEventListener('click', () => courseView(panel, course, onBack));
  }

  render();
}
