// Routen-Eingabe: Linie wählen -> Einstieg (auto, ggf. Fußweg) -> Ausstieg -> nächste Linie …
import type { Line, Restriction, Station, UserLeg } from '../../shared/types.ts';
import { restrictionAllowsLine, restrictionLabel, restrictionMaxLegs } from '../../shared/rules.ts';
import { distM, fmtDist, type NetIndex } from './net.ts';
import { smoothPath } from './netmap.ts';
import { esc, h, lineChip } from './ui.ts';

export interface DraftLeg {
  line: Line;
  from: string;
  to: string;
}

const WALK_WARN_M = 1200;
/**
 * Fußwege, abgestuft – deutlich, wenn es wohl ein Versehen ist, aber nicht nervig, wenn man absichtlich geht:
 * bis 250 m nur leise (Bahnsteig, Ecke weiter), bis 700 m ein Hinweis, darüber deutlich (aber nie blockierend).
 */
/** Start/Ziel ist eine Adresse (Punkt 13): keine Linien, ID „a:…“ */
const isAddress = (s: Station) => s.id.startsWith('a:');
const WALK_QUIET_M = 250;
const WALK_LOUD_M = 700;
/** Gehzeit wie in der Auswertung: Luftlinie × 1,3 bei 80 m/min */
const walkMinutes = (m: number) => Math.max(1, Math.round((m * 1.3) / 80));
const walkText = (m: number) => `${fmtDist(m)} zu Fuß (≈ ${walkMinutes(m)} min)`;

export interface BuilderOptions {
  /** X-treme: Ein-/Ausstieg selbst eintippen, keine Auswahllisten und keine Stationszahl */
  typed?: boolean;
  /** Name des Starts nicht verraten (X-treme "ohne Namen") */
  hideStart?: boolean;
  /** keine Fußweg-Entfernungen zeigen (X-treme "ohne Namen" / "ohne Karte") */
  hideDistances?: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Ausstiegs-Wert: "ausstieg" oder "einstieg>ausstieg" (Gegenrichtung hält woanders) */
function parseAlight(v: string, board: string): [string, string] {
  const i = v.indexOf('>');
  return i < 0 ? [board, v] : [v.slice(0, i), v.slice(i + 1)];
}

export class RouteBuilder {
  readonly el = h('div', { class: 'builder' });
  legs: DraftLeg[] = [];
  private net: NetIndex;
  private start: Station;
  private dest: Station;
  private onChange: () => void;
  private onSubmit: () => void;
  private restriction: Restriction | null;
  private banned: string[];
  private opts: BuilderOptions;
  // Formular-Zustand
  private pickedLine: Line | null = null;
  private board: string | null = null;

  constructor(
    net: NetIndex,
    start: Station,
    dest: Station,
    restriction: Restriction | null,
    onChange: () => void,
    onSubmit: () => void,
    banned: string[] = [],
    opts: BuilderOptions = {},
  ) {
    this.restriction = restriction;
    this.banned = banned;
    this.opts = opts;
    this.net = net;
    this.start = start;
    this.dest = dest;
    this.onChange = onChange;
    this.onSubmit = onSubmit;
    this.render();
  }

  get position(): Station {
    return this.legs.length ? this.net.station(this.legs[this.legs.length - 1].to) : this.start;
  }

  userLegs(): UserLeg[] {
    return this.legs.map((l) => ({ line: l.line.id, from: l.from, to: l.to }));
  }

  /** Für die Kartenvorschau */
  segments() {
    const segs: { path: [number, number][]; color: string; walk: boolean }[] = [];
    let pos = this.start;
    const ll = (s: Station): [number, number] => [s.lat, s.lon];
    for (const l of this.legs) {
      const from = this.net.station(l.from);
      if (from.id !== pos.id) segs.push({ path: [ll(pos), ll(from)], color: '#666', walk: true });
      segs.push({ path: smoothPath(l.line.id, l.from, l.to, this.net.legPath(l.line, l.from, l.to)), color: l.line.color, walk: false });
      pos = this.net.station(l.to);
    }
    if (this.legs.length && pos.id !== this.dest.id) segs.push({ path: [ll(pos), ll(this.dest)], color: '#666', walk: true });
    if (this.pickedLine && this.board && this.board !== pos.id)
      segs.push({ path: [ll(pos), ll(this.net.station(this.board))], color: '#666', walk: true });
    return segs;
  }

  transferPoints() {
    const ids = new Set<string>();
    for (const l of this.legs) ids.add(l.from).add(l.to);
    if (this.board) ids.add(this.board);
    ids.delete(this.start.id);
    ids.delete(this.dest.id);
    return [...ids].map((id) => this.net.station(id));
  }

  // -------------------------------------------------------------- Rendering

  /** Hinweis, nachdem eine frühere Teilstrecke geändert wurde (z.B. „ab hier neu wählen“) */
  private notice = '';

  private render() {
    this.el.innerHTML = '';
    const list = h('ol', { class: 'legs' });
    let pos = this.start;
    const hideD = !!this.opts.hideDistances;
    const typed = !!this.opts.typed;
    this.legs.forEach((l, i) => {
      const from = this.net.station(l.from);
      const to = this.net.station(l.to);
      // Fußweg vor dieser Teilstrecke: zwischendurch und über 250 m als eigener Block (wie eine Fahrt)
      if (from.id !== pos.id) {
        const d = distM(pos, from);
        const level = d > WALK_LOUD_M ? 'walk-loud' : d > WALK_QUIET_M ? 'walk-mid' : 'walk-quiet';
        if (i > 0 && d > WALK_QUIET_M && !hideD)
          list.append(
            h('li', { class: `leg walk-leg ${level}` }, `<div class="leg-main"><span class="walk-icon">🚶</span>
              <span class="leg-text">${esc(pos.name)} → <b>${esc(from.name)}</b><small>${walkText(d)}</small></span></div>`),
          );
        else list.append(h('li', { class: `leg-walk ${level}` }, `🚶 ${hideD ? '' : `${fmtDist(d)} `}zu Fuß nach ${esc(from.name)}`));
      }
      const stops = this.net.stopsBetween(l.line, l.from, l.to);
      const last = i === this.legs.length - 1;
      const fromName = this.opts.hideStart && from.id === this.start.id ? 'Start' : from.name;
      // Einbahn/Schleife: die Linie hält hier, aber nicht in diese Richtung → Einstieg woanders (Punkt 11)
      const oneWay = from.id !== pos.id && this.net.patterns(l.line).some((p) => p.includes(pos.id));
      const li = h(
        'li',
        { class: 'leg' },
        `<div class="leg-main">${lineChip(l.line.mode, l.line.id, l.line.color)}
          <span class="leg-text">${esc(fromName)} →${typed ? ` <b>${esc(to.name)}</b>` : ''}${typed ? '<small></small>' : `<small>${stops} Station${stops === 1 ? '' : 'en'}</small>`}</span>
          ${last ? '<button class="icon-btn" data-act="remove" title="Teilstrecke entfernen">✕</button>' : ''}</div>
          ${oneWay ? `<div class="one-way">↩ Die ${esc(l.line.id)} hält in diese Richtung nicht bei ${esc(pos.name)} (Einbahn/Schleife) – Einstieg ${esc(from.name)}.</div>` : ''}`,
      );
      if (!typed) {
        // Ausstieg jeder Teilstrecke änderbar (z.B. 71 bis St. Marx statt Rennweg) – folgende Strecken passen sich an
        const sel = this.alightSelect(l.line, l.from, l.to);
        sel.classList.add('leg-alight');
        sel.title = 'Ausstieg ändern';
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          const [nf, nt] = parseAlight(sel.value, l.from);
          l.from = nf;
          l.to = nt;
          this.reflow(i);
          this.resetForm();
        });
        li.querySelector('.leg-text small')!.before(sel);
      }
      li.querySelector('[data-act=remove]')?.addEventListener('click', () => {
        this.legs.pop();
        this.notice = '';
        this.resetForm();
      });
      list.append(li);
      pos = to;
    });
    if (this.legs.length) this.el.append(list);
    if (this.notice) this.el.append(h('div', { class: 'warn' }, esc(this.notice)));

    const arrived = pos.id === this.dest.id;
    const full = this.legs.length >= restrictionMaxLegs(this.restriction);
    if (!arrived && !full) this.el.append(this.renderForm());
    if (!arrived && full)
      this.el.append(h('div', { class: 'warn' }, `${esc(restrictionLabel(this.restriction!, this.banned))}: keine weitere Linie möglich.`));

    if (this.legs.length) {
      const endWalk = arrived || hideD ? '' : `<div class="walk">🚶 ${walkText(distM(pos, this.dest))} zum Ziel</div>`;
      const far = !arrived && !hideD && distM(pos, this.dest) > WALK_WARN_M ? '<div class="warn">Ziemlich weiter Fußweg – sicher?</div>' : '';
      const foot = h('div', { class: 'submit-row' }, `${endWalk}${far}<button class="btn btn-primary" data-act="submit">Route abgeben</button>`);
      foot.querySelector('button')!.disabled = this.locked;
      foot.querySelector('button')!.addEventListener('click', () => this.onSubmit());
      this.el.append(foot);
    }
    this.onChange();
  }

  /** Nach Abgabe / Zeitablauf keine Änderungen mehr */
  locked = false;

  lock() {
    this.locked = true;
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach((e) => (e.disabled = true));
  }

  /** Abgabe ist fehlgeschlagen → weiter bearbeiten */
  unlock() {
    this.locked = false;
    this.render();
  }

  /**
   * Nach dem Ändern von Teilstrecke i: die nächste beginnt am neuen Ausstieg, wenn ihre Linie dort hält, sonst an der
   * nächstgelegenen Haltestelle (wie beim Neu-Hinzufügen). Kommt sie von dort nicht mehr in ihre Richtung zum alten
   * Ausstieg, fallen sie und alle späteren weg.
   */
  private reflow(i: number) {
    this.notice = '';
    const next = this.legs[i + 1];
    if (!next) return;
    const at = this.legs[i].to;
    const reach = (from: string) => this.net.patterns(next.line).some((p) => p.indexOf(from) >= 0 && p.indexOf(next.to, p.indexOf(from) + 1) > p.indexOf(from));
    const here = this.net.patterns(next.line).some((p) => p.includes(at));
    const board = here && reach(at) ? at : this.net.boardOptions(next.line, this.net.station(at), 1)[0]?.station.id;
    if (board && reach(board)) {
      next.from = board;
      return;
    }
    const dropped = this.legs.splice(i + 1);
    this.notice = `${dropped.map((l) => l.line.id).join(', ')} ${dropped.length > 1 ? 'passen' : 'passt'} ab dem neuen Ausstieg nicht mehr – bitte neu wählen.`;
  }

  private resetForm() {
    this.pickedLine = null;
    this.board = null;
    this.render();
  }

  private renderForm(): HTMLElement {
    const pos = this.position;
    const form = h('div', { class: 'leg-form' });
    const posName = this.opts.hideStart && pos.id === this.start.id ? 'dem Start' : pos.name;
    form.append(h('div', { class: 'form-title' }, this.legs.length ? `Weiter ab <b>${esc(posName)}</b>` : `Los geht's ab <b>${esc(posName)}</b>`));

    if (!this.pickedLine) {
      const input = h('input', { type: 'text', class: 'line-input', placeholder: 'Linie eingeben, z.B. U2, 5B, 43, S45 …', autocomplete: 'off', spellcheck: 'false' });
      const results = h('div', { class: 'line-results' });
      const update = () => {
        const found = this.net.searchLines(input.value, this.restriction, this.banned);
        results.innerHTML = found.map((l) => `<button class="line-opt" data-line="${esc(l.id)}">${lineChip(l.mode, l.id, l.color)}</button>`).join('');
        if (input.value.trim() && !found.length) {
          const q = input.value.trim().toLowerCase().replace(/\s+/g, '');
          const blocked = this.banned.find((id) => id.toLowerCase() === q);
          results.innerHTML = `<span class="muted">${blocked ? `⛔ ${esc(blocked)} ist in dieser Runde gesperrt` : `Keine Linie gefunden${this.restriction ? ' (Einschränkung beachten)' : ''}`}</span>`;
        }
      };
      input.addEventListener('input', update);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const first = this.net.searchLines(input.value, this.restriction, this.banned)[0];
        if (first) this.pickLine(first);
      });
      results.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')?.dataset.line;
        if (id) this.pickLine(this.net.lines.get(id)!);
      });
      form.append(input, results);
      queueMicrotask(() => input.focus());
      return form;
    }

    const line = this.pickedLine;
    const head = h('div', { class: 'picked' }, `${lineChip(line.mode, line.id, line.color)}<button class="link" data-act="change">andere Linie</button>`);
    head.querySelector('button')!.addEventListener('click', () => this.resetForm());
    form.append(head);
    if (this.opts.typed) return this.typedForm(form, line, pos);

    // Einstieg: hier, oder nächstgelegene Haltestellen der Linie (Fußweg)
    const opts = this.net.boardOptions(line, pos);
    const boardSel = h('select', { class: 'board-select' });
    boardSel.innerHTML = opts
      .map((o) => `<option value="${o.station.id}">${o.dist === 0 ? `${esc(o.station.name)} (hier)` : `${esc(o.station.name)} · 🚶 ${fmtDist(o.dist)}`}</option>`)
      .join('');
    boardSel.value = this.board!;
    boardSel.addEventListener('change', () => {
      this.board = boardSel.value;
      this.render();
    });
    const boardDist = opts.find((o) => o.station.id === this.board)?.dist ?? 0;
    const boardRow = h('label', { class: 'field' }, '<span>Einstieg</span>');
    boardRow.append(boardSel);
    form.append(boardRow);
    // Linie hält nicht hier: je nach Entfernung leise, Hinweis oder deutlich (Punkt 4)
    const boardName = this.net.station(this.board!).name;
    const servesHere = this.net.patterns(line).some((p) => p.includes(pos.id));
    // Start an einer Adresse: zu Fuß zur Haltestelle ist normal – deutlich nur, wenn es viel nähere Haltestellen gibt
    if (isAddress(pos) && !this.opts.hideDistances) {
      const nearest = this.nearestStop(pos);
      if (nearest && boardDist > Math.max(WALK_LOUD_M, nearest.dist + 500))
        form.append(
          h(
            'div',
            { class: 'walk-alert walk-loud', role: 'status' },
            `⚠️ <b>Die ${esc(line.id)} hält erst bei ${esc(boardName)}</b> – ${walkText(boardDist)}. Die nächste Haltestelle wäre ${esc(nearest.station.name)} (${walkText(nearest.dist)}).`,
          ),
        );
      else form.append(h('div', { class: 'walk-note' }, `🚶 ${walkText(boardDist)} zur Haltestelle ${esc(boardName)}`));
    } else if (boardDist > WALK_LOUD_M && !this.opts.hideDistances)
      form.append(
        h(
          'div',
          { class: 'walk-alert walk-loud', role: 'status' },
          `⚠️ <b>Die ${esc(line.id)} fährt nicht bei ${esc(pos.name)}.</b> Nächster Halt: ${esc(boardName)} – ${walkText(boardDist)}. Absicht? Sonst „andere Linie“.`,
        ),
      );
    else if (boardDist > WALK_QUIET_M && !this.opts.hideDistances)
      form.append(
        h(
          'div',
          { class: 'walk-alert walk-mid' },
          servesHere
            ? `↩ In diese Richtung hält die ${esc(line.id)} nicht hier – Einstieg ${esc(boardName)}, ${walkText(boardDist)}.`
            : `🚶 Die ${esc(line.id)} hält nicht hier – Einstieg ${esc(boardName)}, ${walkText(boardDist)}.`,
        ),
      );
    else if (boardDist > 0 && !this.opts.hideDistances) form.append(h('div', { class: 'walk-note' }, `🚶 ${fmtDist(boardDist)} zum Einstieg ${esc(boardName)}`));

    // Ausstieg nach Richtung gruppiert
    const alightSel = this.alightSelect(line, this.board!, null);
    alightSel.addEventListener('change', () => {
      if (!alightSel.value) return;
      const [from, to] = parseAlight(alightSel.value, this.board!);
      this.legs.push({ line, from, to });
      this.resetForm();
    });
    const alightRow = h('label', { class: 'field' }, '<span>Ausstieg</span>');
    alightRow.append(alightSel);
    form.append(alightRow);
    queueMicrotask(() => alightSel.focus());
    return form;
  }

  /**
   * Auswahl der Ausstiege: die Linie von Endstation zu Endstation (z.B. U1 Leopoldau oben … Oberlaa unten),
   * die Einstiegs-Station mittendrin markiert und nicht wählbar.
   */
  /** nächste Haltestelle mit Linien (für Adressen) */
  private nearestStop(p: Station): { station: Station; dist: number } | null {
    let best: { station: Station; dist: number } | null = null;
    for (const st of this.net.stations.values()) {
      if (!st.lines.length) continue;
      const d = distM(st, p);
      if (!best || d < best.dist) best = { station: st, dist: d };
    }
    return best;
  }

  private alightSelect(line: Line, board: string, selected: string | null): HTMLSelectElement {
    const sel = h('select', { class: 'alight-select' });
    const { up, down } = this.net.lineThrough(line, board);
    // Ziel ist eine Adresse: die Haltestelle der Linie, die ihr am nächsten liegt (bis 1,5 km), markieren
    const nearDest = isAddress(this.dest) ? (this.net.boardOptions(line, this.dest, 1).find((o) => o.dist <= 1500) ?? null) : null;
    // Gegenrichtung mit anderem Einstieg: Wert "einstieg>ausstieg"
    const opt = (s: Station, alt?: Station) =>
      `<option value="${alt ? `${alt.id}>` : ''}${s.id}">${esc(s.name)}${s.id === this.dest.id ? ' 🏁' : ''}${s.id === nearDest?.station.id ? ` 📍 ${fmtDist(nearDest.dist)} zum Ziel` : ''}${alt && alt.id !== board ? ` ↩ ab ${esc(alt.name)}` : ''}</option>`;
    const here = this.net.station(board);
    // Reihenfolge wie auf dem Linienplan: obere Stationen · "↑ Richtung …" · hier · "↓ Richtung …" · untere Stationen.
    // Die Überschriften sind leere <optgroup>s, damit sie fett direkt neben der aktuellen Station stehen.
    // Ohne Vorauswahl ist die aktuelle Station markiert → die Liste öffnet sich genau dort.
    sel.innerHTML =
      (up ? up.stations.map((s) => opt(s, up.board)).join('') + `<optgroup label="↑ ${esc(up.label)}"></optgroup>` : '') +
      `<option value="" disabled class="here" ${selected ? '' : 'selected'}>● ${esc(here.name)} – Ausstieg wählen …</option>` +
      (down ? `<optgroup label="↓ ${esc(down.label)}"></optgroup>` + down.stations.map((s) => opt(s, down.board)).join('') : '');
    if (selected) sel.value = selected;
    return sel;
  }

  /** X-treme: Ein- und Ausstieg als Text, Auto-Vervollständigung über ALLE Stationen (verrät nichts über die Linie) */
  private typedForm(form: HTMLElement, line: Line, pos: Station): HTMLElement {
    stationDatalist(this.net);
    const showPos = !(this.opts.hideStart && pos.id === this.start.id);
    const fields = h(
      'div',
      { class: 'typed-legs' },
      `<label class="field"><span>Einstieg</span><input class="typed-board" list="all-stations" autocomplete="off" placeholder="Station eintippen …" value="${showPos ? esc(pos.name) : ''}"></label>
       <label class="field"><span>Ausstieg</span><input class="typed-alight" list="all-stations" autocomplete="off" placeholder="Station eintippen …"></label>
       <div class="typed-err warn" hidden></div>
       <button class="btn btn-primary" data-act="add">Teilstrecke hinzufügen</button>`,
    );
    const board = fields.querySelector<HTMLInputElement>('.typed-board')!;
    const alight = fields.querySelector<HTMLInputElement>('.typed-alight')!;
    const err = fields.querySelector<HTMLElement>('.typed-err')!;
    const add = () => {
      // leer gelassener Einstieg = hier (auch wenn der Name versteckt ist)
      const from = board.value.trim() ? this.resolveName(board.value, line) : pos.id;
      const to = this.resolveName(alight.value, line);
      const bad = !from ? board.value : !to ? alight.value || '(leer)' : null;
      if (bad !== null) {
        err.hidden = false;
        err.textContent = `Station „${bad}“ gibt es nicht – bitte aus den Vorschlägen wählen.`;
        return;
      }
      this.legs.push({ line, from: from!, to: to! });
      this.resetForm();
    };
    fields.querySelector('[data-act=add]')!.addEventListener('click', add);
    alight.addEventListener('keydown', (e) => e.key === 'Enter' && add());
    form.append(fields);
    queueMicrotask(() => (showPos ? alight : board).focus());
    return form;
  }

  /** Stationsname → Station; bei gleichnamigen die, an der die Linie hält */
  private resolveName(name: string, line: Line): string | null {
    const n = norm(name);
    if (!n) return null;
    const cands = this.net.data.stations.filter((s) => norm(s.name) === n);
    if (!cands.length) return null;
    const served = new Set(this.net.patterns(line).flat());
    return (cands.find((s) => served.has(s.id)) ?? cands[0]).id;
  }

  /** Linie, die gerade gewählt aber noch nicht abgeschlossen ist (für den Trainings-Coach) */
  get draft(): { line: Line; board: string } | null {
    return this.pickedLine && this.board ? { line: this.pickedLine, board: this.board } : null;
  }

  /** Linie von außen wählen (z.B. aus "Was fährt hier ab?") */
  selectLine(line: Line) {
    if (this.locked || !restrictionAllowsLine(this.restriction, this.banned, line)) return;
    this.pickLine(line);
  }

  private pickLine(line: Line) {
    this.pickedLine = line;
    this.board = this.net.boardOptions(line, this.position, 1)[0].station.id;
    this.render();
  }
}

/** Eine gemeinsame Vorschlagsliste mit allen Stationsnamen (einmal pro Seite) */
function stationDatalist(net: NetIndex) {
  if (document.getElementById('all-stations')) return;
  const dl = document.createElement('datalist');
  dl.id = 'all-stations';
  const names = [...new Set(net.data.stations.map((s) => s.name))].sort((a, b) => a.localeCompare(b, 'de'));
  dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  document.body.append(dl);
}
