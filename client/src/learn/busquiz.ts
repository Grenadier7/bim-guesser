// Lernen → Üben → „Welcher Bus fährt hier?“ (Punkt 6): Busse von der Station aus lernen.
//
// Eine Station erscheint auf der Karte (mit U-Bahn, S-Bahn und Bim zur Orientierung). Aus ein paar Bussen tippt man
// die an, die dort halten – die anderen Vorschläge fahren ganz in der Nähe, man muss also wirklich wissen, wo welcher
// Bus abbiegt. Danach: welche Busse es sind, wohin sie fahren, und bei falschen, wo die nächste Haltestelle wäre.
// Falsch beantwortete Stationen kommen am Ende der Runde nochmal.
import type { Line, Station } from '../../../shared/types.ts';
import { distM } from '../../../shared/geo.ts';
import { netLayer, netView } from '../netmap.ts';
import { app } from '../store.ts';
import { esc, h, lineChip, toast } from '../ui.ts';
import { addMine, compareColors, departuresFrom, isSpecialLine, linesAt, patternsOf, servedStations, shuffle, type Scope } from './model.ts';

const QUESTIONS = 10;
/** Vorschläge: alle richtigen + Busse von Haltestellen in diesem Umkreis */
const NEAR_M = 1500;
const MIN_OPTIONS = 6;
const MAX_OPTIONS = 9;

const BUS_SCOPE = (): Scope => ({ label: '', stations: [], stationSet: new Set(), lines: [], area: null, modes: new Set(['B']) });
const busNo = (id: string) => parseInt(id, 10) || 999;

interface Question {
  st: Station;
  buses: Line[];
  options: Line[];
}

interface Answer {
  q: Question;
  hit: Line[];
  miss: Line[];
  wrong: Line[];
}

export function busQuizView(panel: HTMLElement, back: () => void) {
  const net = app.net;
  let district = 0;

  // ---------------------------------------------------------- Daten

  const buses = () => net.data.lines.filter((l) => l.mode === 'B' && !isSpecialLine(l) && patternsOf(l).length);
  /** Haltestellen jedes Busses (für „nächster Halt“) */
  const stopsOf = new Map<string, Station[]>();
  const stopsOfBus = (l: Line) => {
    if (!stopsOf.has(l.id)) stopsOf.set(l.id, [...new Set(patternsOf(l).flat())].map((id) => net.station(id)));
    return stopsOf.get(l.id)!;
  };
  const nearest = (l: Line, st: Station) => {
    let best: { s: Station; d: number } | null = null;
    for (const s of stopsOfBus(l)) {
      const d = distM(s, st);
      if (!best || d < best.d) best = { s, d };
    }
    return best!;
  };

  function pool(): Station[] {
    const served = servedStations();
    return net.data.stations.filter((s) => served.has(s.id) && (!district || s.district === district) && linesAt(s, BUS_SCOPE()).length);
  }

  function question(st: Station): Question {
    const here = linesAt(st, BUS_SCOPE());
    const ids = new Set(here.map((l) => l.id));
    // Ablenkung: Busse, die ganz in der Nähe halten – je näher, desto eher
    const near = buses()
      .filter((l) => !ids.has(l.id))
      .map((l) => ({ l, d: nearest(l, st).d }))
      .filter((x) => x.d <= NEAR_M)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.l);
    const n = Math.min(MAX_OPTIONS, Math.max(MIN_OPTIONS, here.length + 3));
    let extra = near.slice(0, Math.max(0, n - here.length));
    // zu wenig in der Nähe (Stadtrand): Busse mit ähnlicher Nummer
    if (here.length + extra.length < MIN_OPTIONS) {
      const tens = new Set(here.map((l) => Math.floor(busNo(l.id) / 10)));
      const more = shuffle(buses().filter((l) => !ids.has(l.id) && !extra.includes(l) && tens.has(Math.floor(busNo(l.id) / 10))));
      extra = [...extra, ...more].slice(0, MIN_OPTIONS - here.length);
    }
    const options = [...here, ...extra].sort((a, b) => busNo(a.id) - busNo(b.id) || a.id.localeCompare(b.id));
    return { st, buses: here, options };
  }

  // ---------------------------------------------------------- Ablauf

  let queue: Question[] = [];
  let answers: Answer[] = [];
  let retried = new Set<string>();

  function start() {
    const all = pool();
    if (!all.length) return toast('Hier fährt kein Bus – anderen Bezirk wählen.');
    // abwechslungsreich: Stationen mit mehreren Bussen etwas öfter, aber nicht nur Knoten
    const weighted = shuffle(all.flatMap((s) => (linesAt(s, BUS_SCOPE()).length >= 2 ? [s, s] : [s])));
    const picked: Station[] = [];
    for (const s of weighted) {
      if (picked.length >= QUESTIONS) break;
      // nicht zwei Mal dieselbe Station und nicht direkt nebeneinander
      if (picked.some((p) => p.id === s.id || p.name === s.name || distM(p, s) < 300)) continue;
      picked.push(s);
    }
    queue = picked.map(question);
    answers = [];
    retried = new Set();
    ask();
  }

  function drawQuestion(q: Question) {
    // Orientierung: U-Bahn, S-Bahn, Bim – Busse nicht (die sind ja gefragt)
    app.map.clearLearn();
    netLayer().render(netView({ kinds: new Set(['U', 'S', 'T']), marks: [q.st], quiet: false }));
    app.map.showTarget(q.st.lat, q.st.lon, null, true);
    app.map.zoomTo(q.st.lat, q.st.lon, 15);
  }

  function ask() {
    const q = queue[0];
    if (!q) return summary();
    drawQuestion(q);
    const others = q.st.lines
      .map((id) => net.lines.get(id))
      .filter((l): l is Line => !!l && l.mode !== 'B' && l.mode !== 'N' && !isSpecialLine(l));
    const districtName = net.data.districts.find((d) => d.id === q.st.district)?.name;
    const done = answers.length;
    const el = h(
      'div',
      { class: 'learn busquiz', 'data-station': q.st.id },
      `<button class="link" id="back">← Lernen</button>
       <div class="tut-step">🚌 Welcher Bus fährt hier? · ${done + 1} von ${done + queue.length}</div>
       <div class="learn-card"><h3>📍 ${esc(q.st.name)}</h3>
         <p class="muted">${q.st.district}. Bezirk${districtName ? ` (${esc(districtName)})` : ''}${others.length ? ` · hier auch: ${others.map((l) => lineChip(l.mode, l.id, l.color)).join(' ')}` : ''}</p>
         <p>Welche Busse halten hier? Tipp alle an, die du kennst${q.buses.length === 1 ? '' : ` – es sind <b>${q.buses.length}</b>`}.</p>
         <div class="bq-options">${q.options
           .map((l) => `<button class="bq-opt" data-bus="${esc(l.id)}" aria-pressed="false">${lineChip(l.mode, l.id, l.color)}</button>`)
           .join('')}</div></div>
       <div class="learn-actions"><button class="btn btn-primary" id="bq-check">Prüfen</button>
         <button class="btn btn-ghost" id="bq-skip">Weiß ich nicht</button></div>`,
    );
    panel.innerHTML = '';
    panel.append(el);
    el.querySelector('#back')!.addEventListener('click', leave);
    el.querySelectorAll<HTMLButtonElement>('.bq-opt').forEach((b) =>
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('on', on);
      }),
    );
    const check = (picked: Set<string>) => {
      const a: Answer = {
        q,
        hit: q.buses.filter((l) => picked.has(l.id)),
        miss: q.buses.filter((l) => !picked.has(l.id)),
        wrong: q.options.filter((l) => picked.has(l.id) && !q.buses.includes(l)),
      };
      queue.shift();
      answers.push(a);
      // Fehler: Station kommt am Ende nochmal (einmal)
      if ((a.miss.length || a.wrong.length) && !retried.has(q.st.id)) {
        retried.add(q.st.id);
        queue.push(question(q.st));
      }
      reveal(a);
    };
    el.querySelector('#bq-check')!.addEventListener('click', () => {
      const picked = new Set([...el.querySelectorAll<HTMLButtonElement>('.bq-opt.on')].map((b) => b.dataset.bus!));
      if (!picked.size) return toast('Tipp mindestens einen Bus an – oder „Weiß ich nicht“.', 'info');
      check(picked);
    });
    el.querySelector('#bq-skip')!.addEventListener('click', () => check(new Set()));
  }

  function reveal(a: Answer) {
    const { q } = a;
    const perfect = !a.miss.length && !a.wrong.length;
    const near = a.wrong.map((l) => ({ l, ...nearest(l, q.st) }));
    // Karte: die richtigen Busse je in eigener Farbe (sonst sind alle Busse gleich dunkelblau), falsche grau – mit
    // ihrer nächsten Haltestelle
    const colors = compareColors(q.buses);
    for (const l of a.wrong) colors[l.id] = '#9aa0a6';
    const chip = (l: Line) => lineChip(l.mode, l.id, colors[l.id] ?? l.color);
    app.map.clearLearn();
    netLayer().render(
      netView({ kinds: new Set(['U', 'S', 'T', 'B']), focus: new Set([...q.buses, ...a.wrong].map((l) => l.id)), colors, marks: [q.st, ...near.map((x) => x.s)], allLabels: true }),
    );
    app.map.showTarget(q.st.lat, q.st.lon, null);
    app.map.fitPoints([...q.buses, ...a.wrong].flatMap((l) => stopsOfBus(l).map((s) => [s.lat, s.lon] as [number, number])), 15);
    const deps = new Map(departuresFrom(q.st, BUS_SCOPE()).map((d) => [d.line.id, d.dirs]));
    const row = (l: Line, mark: string) =>
      `<li>${mark} ${chip(l)}<span>${(deps.get(l.id) ?? []).map((x) => `→ ${esc(x.to)}${x.via ? ` <small class="muted">über ${esc(x.via)}</small>` : ''}`).join('<br>') || '<small class="muted">Endstation</small>'}</span></li>`;
    const el = h(
      'div',
      { class: 'learn busquiz' },
      `<button class="link" id="back">← Lernen</button>
       <div class="learn-card"><h3>${perfect ? '🎉 Genau richtig!' : a.hit.length ? '👍 Fast' : '🤔 Nicht ganz'} – 📍 ${esc(q.st.name)}</h3>
         <ul class="deps">${[...a.hit.map((l) => row(l, '✅')), ...a.miss.map((l) => row(l, '➕'))].join('')}</ul>
         ${a.miss.length ? `<p class="muted">➕ = hättest du auch nehmen können.</p>` : ''}
         ${
           near.length
             ? `<p><b>Fährt hier nicht:</b></p><ul class="deps">${near
                 .map((x) => `<li>❌ ${chip(x.l)}<span>nächster Halt: <b>${esc(x.s.name)}</b> (${Math.round(x.d / 10) * 10} m)</span></li>`)
                 .join('')}</ul>`
             : ''
         }</div>
       <div class="learn-actions"><button class="btn btn-primary" id="bq-next">${queue.length ? 'Weiter →' : 'Auswertung →'}</button></div>`,
    );
    panel.innerHTML = '';
    panel.append(el);
    el.querySelector('#back')!.addEventListener('click', leave);
    el.querySelector('#bq-next')!.addEventListener('click', ask);
  }

  function summary() {
    // jede Station zählt mit dem ersten Versuch
    const first = new Map<string, Answer>();
    for (const a of answers) if (!first.has(a.q.st.id)) first.set(a.q.st.id, a);
    const list = [...first.values()];
    const perfect = list.filter((a) => !a.miss.length && !a.wrong.length).length;
    const missedHere = [...new Set(list.flatMap((a) => a.miss))];
    app.map.clearLearn();
    netLayer().render(netView({ focus: new Set(missedHere.map((l) => l.id)), marks: list.map((a) => a.q.st), allLabels: true }));
    app.map.fitPoints(list.map((a) => [a.q.st.lat, a.q.st.lon]), 14);
    const el = h(
      'div',
      { class: 'learn busquiz' },
      `<button class="link" id="back">← Lernen</button>
       <div class="learn-card"><h3>🚌 ${perfect} von ${list.length} Stationen auf Anhieb richtig</h3>
         ${
           missedHere.length
             ? `<p>Diese Busse hast du übersehen – auf der Karte hervorgehoben:</p><div class="chips">${missedHere.map((l) => lineChip(l.mode, l.id, l.color)).join('')}</div>`
             : '<p>Keinen Bus übersehen – stark!</p>'
         }
         <p class="muted">Tipp: Die Zehnerstelle der Busnummer verrät die Gegend (Kurs „Busnummern verraten die Gegend“).</p></div>
       <div class="learn-actions">
         <button class="btn btn-primary" id="bq-again">Neue Runde</button>
         ${missedHere.length ? `<button class="btn btn-ghost" id="bq-star">⭐ Übersehene merken</button>` : ''}
       </div>`,
    );
    panel.innerHTML = '';
    panel.append(el);
    el.querySelector('#back')!.addEventListener('click', leave);
    el.querySelector('#bq-again')!.addEventListener('click', setup);
    el.querySelector('#bq-star')?.addEventListener('click', () => {
      addMine(missedHere.map((l) => l.id));
      toast(`${missedHere.length} Busse gemerkt – zu finden unter „Meine Linien üben“`, 'info');
    });
  }

  function leave() {
    app.map.clearLearn();
    back();
  }

  // ---------------------------------------------------------- Start

  function setup() {
    app.map.clearLearn();
    netLayer().render(netView({ kinds: new Set(['B']), focus: new Set(), allLabels: false }));
    app.map.cityView();
    const el = h(
      'div',
      { class: 'learn busquiz' },
      `<button class="link" id="back">← Lernen</button>
       <h2>🚌 Welcher Bus fährt hier?</h2>
       <p>Busse lernt man am besten von der Haltestelle aus: Du siehst eine Station, tippst die Busse an, die dort halten,
          und siehst danach, wohin sie fahren. Die falschen Vorschläge halten ganz in der Nähe – Stationen mit Fehlern kommen am Ende nochmal.</p>
       <label class="field"><span>Wo?</span>
         <select id="bq-district" aria-label="Bezirk wählen"><option value="0">Ganz Wien</option>${net.data.districts
           .map((d) => `<option value="${d.id}" ${district === d.id ? 'selected' : ''}>${d.id}. ${esc(d.name)}</option>`)
           .join('')}</select></label>
       <div class="learn-actions"><button class="btn btn-primary btn-big" id="bq-start">${QUESTIONS} Stationen – los!</button></div>`,
    );
    panel.innerHTML = '';
    panel.append(el);
    el.querySelector('#back')!.addEventListener('click', leave);
    el.querySelector<HTMLSelectElement>('#bq-district')!.addEventListener('change', (e) => (district = Number((e.target as HTMLSelectElement).value)));
    el.querySelector('#bq-start')!.addEventListener('click', start);
  }

  setup();
}
