// Routen-Eingabe: Linie wählen -> Einstieg (auto, ggf. Fußweg) -> Ausstieg -> nächste Linie …
import type { Line, Restriction, Station, UserLeg } from '../../shared/types.ts';
import { restrictionAllowsLine, restrictionLabel, restrictionMaxLegs } from '../../shared/rules.ts';
import { distM, fmtDist, type NetIndex } from './net.ts';
import { esc, h, lineChip } from './ui.ts';

export interface DraftLeg {
  line: Line;
  from: string;
  to: string;
}

const WALK_WARN_M = 1200;

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
      segs.push({ path: this.net.legPath(l.line, l.from, l.to), color: l.line.color, walk: false });
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

  private render() {
    this.el.innerHTML = '';
    const list = h('ol', { class: 'legs' });
    let pos = this.start;
    this.legs.forEach((l, i) => {
      const from = this.net.station(l.from);
      const to = this.net.station(l.to);
      const walk =
        from.id !== pos.id ? `<div class="walk">🚶 ${this.opts.hideDistances ? '' : `${fmtDist(distM(pos, from))} `}zu Fuß nach ${esc(from.name)}</div>` : '';
      const stops = this.net.stopsBetween(l.line, l.from, l.to);
      const last = i === this.legs.length - 1;
      const typed = !!this.opts.typed;
      const fromName = this.opts.hideStart && from.id === this.start.id ? 'Start' : from.name;
      const li = h(
        'li',
        { class: 'leg' },
        `${walk}<div class="leg-main">${lineChip(l.line.mode, l.line.id, l.line.color)}
          <span class="leg-text">${esc(fromName)} →${last && !typed ? '' : ` <b>${esc(to.name)}</b>`}${typed ? '<small></small>' : `<small>${stops} Station${stops === 1 ? '' : 'en'}</small>`}</span>
          ${last ? '<button class="icon-btn" data-act="remove" title="Teilstrecke entfernen">✕</button>' : ''}</div>`,
      );
      if (last && !typed) {
        // Ziel der letzten Teilstrecke direkt änderbar (z.B. Kagran -> Kagraner Platz)
        const sel = this.alightSelect(l.line, l.from, l.to);
        sel.classList.add('leg-alight');
        sel.title = 'Ausstieg ändern';
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          const [from, to] = parseAlight(sel.value, l.from);
          l.from = from;
          l.to = to;
          this.resetForm();
        });
        li.querySelector('.leg-text small')!.before(sel);
      }
      li.querySelector('[data-act=remove]')?.addEventListener('click', () => {
        this.legs.pop();
        this.resetForm();
      });
      list.append(li);
      pos = to;
    });
    if (this.legs.length) this.el.append(list);

    const arrived = pos.id === this.dest.id;
    const full = this.legs.length >= restrictionMaxLegs(this.restriction);
    if (!arrived && !full) this.el.append(this.renderForm());
    if (!arrived && full)
      this.el.append(h('div', { class: 'warn' }, `${esc(restrictionLabel(this.restriction!, this.banned))}: keine weitere Linie möglich.`));

    if (this.legs.length) {
      const hideD = !!this.opts.hideDistances;
      const endWalk = arrived || hideD ? '' : `<div class="walk">🚶 ${fmtDist(distM(pos, this.dest))} zu Fuß zum Ziel</div>`;
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
    if (boardDist > WALK_WARN_M) form.append(h('div', { class: 'warn' }, `${esc(line.id)} hält nicht in der Nähe – ${fmtDist(boardDist)} Fußweg.`));

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
  private alightSelect(line: Line, board: string, selected: string | null): HTMLSelectElement {
    const sel = h('select', { class: 'alight-select' });
    const { up, down } = this.net.lineThrough(line, board);
    // Gegenrichtung mit anderem Einstieg: Wert "einstieg>ausstieg"
    const opt = (s: Station, alt?: Station) =>
      `<option value="${alt ? `${alt.id}>` : ''}${s.id}">${esc(s.name)}${s.id === this.dest.id ? ' 🏁' : ''}</option>`;
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
