// Lernmodus: drei Einstiege statt Einstellungen – Lernpfad (Kurse der Reihe nach), Netzkarte (suchen, antippen,
// Steckbrief, „Von hier“, ⭐ merken) und Üben (meine Linien)
import { atlasView, type AtlasSel } from '../learn/atlas.ts';
import { icon } from '../icons.ts';
import { COURSES, courseProgress, courseView } from '../learn/courses/index.ts';
import { isSpecialLine, myLines, patternsOf, scopeOfLines, servedStations, shuffle } from '../learn/model.ts';
import { areaView } from '../learn/area.ts';
import { busQuizView } from '../learn/busquiz.ts';
import { studyView } from '../learn/study.ts';
import { netLayer, netView } from '../netmap.ts';
import { app, setMapBig, setMobileMap } from '../store.ts';
import { esc, h, lineChip } from '../ui.ts';
import type { Screen } from './screen.ts';

/** so viele Linien hat eine Zufalls-Übungsrunde: in 5–10 Minuten machbar, ohne zäh zu werden */
const RANDOM_COUNT = 5;

export function learnScreen(panel: HTMLElement, onBack: () => void): Screen {
  const net = app.net;
  net.mode = 'regular';
  app.map.clear();

  function openAtlas(query = '', select: AtlasSel = null) {
    setMobileMap(true);
    atlasView(panel, home, { query, select });
  }

  function home() {
    setMapBig(false);
    // Handy: Startseite ohne Karte
    setMobileMap(false);
    app.map.onTap(null);
    app.map.clearLearn();
    app.map.clearEndpoints();
    // Karte gleich antippbar: Linie oder Station öffnet die Netzkarte mit dieser Auswahl
    const served = servedStations();
    netLayer().render(
      netView({
        allStops: net.data.stations.filter((s) => served.has(s.id)),
        onLine: (id) => openAtlas('', { kind: 'line', id }),
        onStation: (id) => openAtlas('', { kind: 'station', id }),
      }),
    );
    app.map.cityView();

    const progress = courseProgress();
    const done = COURSES.filter((c) => progress[c.id]?.done).length;
    const mastered = COURSES.filter((c) => progress[c.id]?.mastered).length;
    const next = COURSES.find((c) => !progress[c.id]?.done) ?? null;
    const mine = myLines().map((id) => net.lines.get(id)!);
    const shown = mine.slice(0, 14);
    const el = h('div', { class: 'learn learn-hub' });
    el.innerHTML = `
      <button class="link" id="back">← Zurück</button>
      <h2>📚 Lernen</h2>
      <section class="hub-card">
        <div class="hub-head"><span class="hub-icon">${icon('cap', 22)}</span><div><b>Lernpfad</b>
          <small>Das Netz Schritt für Schritt verstehen – ${done} von ${COURSES.length} Kursen geschafft${mastered ? ` · ⭐ ${mastered} gemeistert` : ''}</small></div></div>
        <div class="path-dots">${COURSES.map((c) => `<i class="${progress[c.id]?.done ? 'on' : ''}${progress[c.id]?.mastered ? ' mastered' : ''}${c === next ? ' next' : ''}" title="${esc(c.title)}"></i>`).join('')}</div>
        ${
          next
            ? `<button class="btn btn-primary" data-course="${next.id}">Weiter mit: ${next.icon} ${esc(next.title)}</button>`
            : '<p class="good">🎉 Alle Kurse geschafft – zum Auffrischen einfach einen nochmal machen.</p>'
        }
        <details class="all-courses"><summary>Alle Kurse</summary>
          <div class="course-list">${COURSES.map((c, i) => {
            const p = progress[c.id];
            return `<button class="course-card" data-course="${c.id}"><span class="cc-icon">${c.icon}</span>
              <span class="cc-text"><b>${i + 1}. ${esc(c.title)}</b><small>${esc(c.short)}</small></span>
              ${
                p?.mastered
                  ? `<span class="cc-done mastered" title="gemeistert – Prüfung bestanden">⭐ ${Math.round((p.exam ?? 0) * 100)} %</span>`
                  : p?.done
                    ? `<span class="cc-done" title="Erklärungen fertig – Prüfung noch offen">✓${p.exam ? ` Prüfung ${Math.round(p.exam * 100)} %` : ''}</span>`
                    : ''
              }</button>`;
          }).join('')}</div></details>
      </section>
      <section class="hub-card">
        <div class="hub-head"><span class="hub-icon">${icon('map', 22)}</span><div><b>Netzkarte</b>
          <small>Linie oder Station antippen: Steckbrief und „Von hier fährst du mit …“</small></div></div>
        <input class="line-input" id="hub-search" placeholder="Linie oder Station, z.B. 13A oder Praterstern" autocomplete="off" spellcheck="false">
        <button class="btn btn-ghost" id="open-atlas">Netzkarte öffnen</button>
      </section>
      <section class="hub-card">
        <div class="hub-head"><span class="hub-icon">${icon('dumbbell', 22)}</span><div><b>Üben</b>
          <small>Deine gemerkten Linien: ansehen, aus dem Gedächtnis nachzeichnen, vergleichen</small></div></div>
        ${
          mine.length
            ? `<div class="chips">${shown.map((l) => lineChip(l.mode, l.id, l.color)).join('')}${mine.length > shown.length ? ` <small class="muted">+${mine.length - shown.length}</small>` : ''}</div>`
            : '<p class="muted">Noch keine Linien gemerkt – in der Netzkarte im Steckbrief mit ☆, oder an einer Station alle auf einmal.</p>'
        }
        <div class="hub-actions">
          <button class="btn btn-primary" id="practice" ${mine.length ? '' : 'disabled'}>Meine Linien üben${mine.length ? ` (${mine.length})` : ''}</button>
          <button class="btn btn-ghost" id="random">🎲 ${RANDOM_COUNT} zufällige Linien</button>
          <button class="btn btn-ghost" id="area">📍 Linien einer Gegend</button>
          <button class="btn btn-ghost" id="busquiz">🚌 Welcher Bus fährt hier?</button>
        </div>
        <small class="muted">Zufällig aus U-Bahn, S-Bahn und Bim · Gegend: alle Linien (auch Busse) rund um einen Ort oder in einem Bezirk · Bus: Station sehen, die Busse dort antippen.</small>
      </section>
      <p class="muted center">Wissen gegen andere testen? Dafür gibt's den <b>🧠 Quiz</b>-Modus auf der Startseite.</p>`;
    panel.innerHTML = '';
    panel.append(el);

    el.querySelector('#back')!.addEventListener('click', onBack);
    el.querySelectorAll<HTMLButtonElement>('[data-course]').forEach((b) =>
      b.addEventListener('click', () => {
        setMobileMap(true);
        courseView(panel, COURSES.find((x) => x.id === b.dataset.course)!, home);
      }),
    );
    el.querySelector('#random')!.addEventListener('click', () => {
      const pool = net.data.lines.filter((l) => (l.mode === 'U' || l.mode === 'S' || l.mode === 'T') && !isSpecialLine(l) && patternsOf(l).length);
      const ids = shuffle(pool.map((l) => l.id)).slice(0, RANDOM_COUNT);
      setMobileMap(true);
      studyView({ panel, scope: () => scopeOfLines(ids, 'Zufällige Linien'), back: home }).start();
    });
    el.querySelector('#area')!.addEventListener('click', () => {
      setMobileMap(true);
      areaView(panel, home);
    });
    el.querySelector('#busquiz')!.addEventListener('click', () => {
      setMobileMap(true);
      busQuizView(panel, home);
    });
    el.querySelector('#open-atlas')!.addEventListener('click', () => openAtlas());
    // Tippen in der Suche öffnet gleich die Netzkarte mit dem Suchbegriff
    el.querySelector<HTMLInputElement>('#hub-search')!.addEventListener('input', (e) => openAtlas((e.target as HTMLInputElement).value));
    el.querySelector('#practice')!.addEventListener('click', () => {
      setMobileMap(true);
      studyView({ panel, scope: () => scopeOfLines(myLines(), 'Meine Linien'), back: home }).start();
    });
  }

  home();
  return {
    destroy: () => {
      setMapBig(false);
      app.map.onTap(null);
      app.map.clear();
    },
  };
}
