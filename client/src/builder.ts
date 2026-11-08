// Routen-Eingabe: Linie wählen -> Einstieg (auto, ggf. Fußweg) -> Ausstieg -> nächste Linie …
import type { Line, Restriction, Station, UmlandStart, UserLeg } from '../../shared/types.ts';
import { RESTRICTIONS, moveMinutes, restrictionAllowsLine, restrictionAllowsRoute, restrictionLabel, restrictionMaxLegs } from '../../shared/rules.ts';
import { legProblem, lineProblem, missingDistricts, problemBadge, routeProblem, stationProblem, type RuleRound } from '../../shared/challengeRules.ts';
import { clientRuleNet } from './challenges.ts';
import { distM, fmtDist, type NetIndex } from './net.ts';
import { smoothPath } from './netmap.ts';
import { esc, h, lineChip, toast } from './ui.ts';

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
/** E-Scooter-Challenge: Wege mit 30 km/h (immer nur ein Baukasten zugleich zu sehen) */
let scooterMode = false;
const walkText = (m: number) => (scooterMode ? `${fmtDist(m)} mit dem Scooter (≈ ${moveMinutes(m, true)} min)` : `${fmtDist(m)} zu Fuß (≈ ${walkMinutes(m)} min)`);
const walkIcon = () => (scooterMode ? '🛴' : '🚶');
/** Dauer eines Weges in Klammern – „(≈ 4 min)“, steht bei jedem angezeigten Fußweg */
const walkMin = (m: number) => `(≈ ${scooterMode ? moveMinutes(m, true) : walkMinutes(m)} min)`;
/** ab hier ist ein Weg „weit“ – mit dem Scooter fünfmal so weit */
const loud = () => WALK_LOUD_M * (scooterMode ? 5 : 1);
const quiet = () => WALK_QUIET_M * (scooterMode ? 5 : 1);

export interface BuilderOptions {
  /** X-treme: Ein-/Ausstieg selbst eintippen, keine Auswahllisten und keine Stationszahl */
  typed?: boolean;
  /** Name des Starts nicht verraten (X-treme "ohne Namen") */
  hideStart?: boolean;
  /** keine Fußweg-Entfernungen zeigen (X-treme "ohne Namen" / "ohne Karte") */
  hideDistances?: boolean;
  /** Tages-Challenges: Regeln – nicht Erlaubtes gar nicht erst anbieten (shared/challengeRules.ts) */
  rules?: RuleRound;
  /** „3 Ziele“: jedes zählt als Ziel */
  targets?: Station[];
  /** „3 Punkte“: alle befahren, Ende bei einem davon */
  waypoints?: Station[];
  /** „Ab ins Wasser“: nächstes Wasser zu einem Punkt */
  water?: (p: { lat: number; lon: number }) => { name: string; dist: number; lat: number; lon: number };
  /** Aus dem Umland: Start im Ort – die erste Fahrt ist einer seiner Züge (ab der ersten Station in Wien) */
  umland?: UmlandStart;
  /** Linien, die zu dieser Uhrzeit nicht fahren – nicht vorschlagen */
  idle?: string[];
  /** E-Scooter statt zu Fuß; ganz ohne Öffis abgeben geht auch */
  scooter?: boolean;
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
    scooterMode = !!opts.scooter;
    // Strg+Enter (Mac: ⌘+Enter): Route abgeben – auf der ganzen Seite, solange dieser Baukasten zu sehen ist (auch wenn
    // der Fokus nach dem letzten Ausstieg nirgends mehr steht)
    const onKey = (e: KeyboardEvent) => {
      // nicht (mehr) zu sehen, z.B. alte Runde: nichts tun
      if (!this.el.isConnected) return;
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      if ((this.legs.length || scooterMode) && !this.locked) this.onSubmit();
    };
    queueMicrotask(() => document.addEventListener('keydown', onKey, true));
    this.render();
  }

  /** Regeln als Netz-Ansicht (für shared/challengeRules.ts) */
  private get rn() {
    return clientRuleNet(this.net);
  }

  /** Teilstrecken als einfache Liste (für die Regeln) */
  private plain(legs = this.legs) {
    return legs.map((l) => ({ line: l.line.id, from: l.from, to: l.to }));
  }

  /** an diesen Stationen ist man am Ziel (normal: B; „3 Ziele“: jedes; „3 Punkte“: einer, wenn alle befahren sind) */
  private isGoal(id: string, legs = this.plain()): boolean {
    if (this.opts.water) return false;
    if (this.opts.targets) return this.opts.targets.some((t) => t.id === id);
    if (this.opts.waypoints) {
      const seen = new Set(legs.flatMap((l) => this.rn.traversed(l.line, l.from, l.to)));
      return this.opts.waypoints.every((w) => seen.has(w.id)) && this.opts.waypoints.some((w) => w.id === id);
    }
    // Bezirkstour: am Ziel erst, wenn die Route durch alle grünen Bezirke führt (sonst geht es von B aus weiter)
    if (this.opts.rules && missingDistricts(this.opts.rules, legs, this.rn).length) return false;
    return id === this.dest.id;
  }

  /** nächstes Ziel zu einem Punkt: Ziel, eines der 3 Ziele, ein noch fehlender Punkt oder das Wasser */
  private goalNear(p: Station): { name: string; dist: number; lat: number; lon: number } {
    if (this.opts.water) return this.opts.water(p);
    const list = this.opts.targets ?? (this.opts.waypoints ? this.missingWaypoints() : null) ?? [this.dest];
    const pool = list.length ? list : (this.opts.waypoints ?? [this.dest]);
    const best = pool.reduce((m, s) => (distM(s, p) < distM(m, p) ? s : m));
    return { name: best.name, dist: distM(best, p), lat: best.lat, lon: best.lon };
  }

  /**
   * Warum die Route (noch) nicht abgegeben werden kann – Tages-Challenges: Regel der ganzen Route (mind. 3
   * Verkehrsmittel, 2 Umstiege, Pflicht-Linie …) oder fehlende Punkte. null = abgeben geht.
   */
  submitProblem(): string | null {
    if (!this.legs.length) return null;
    const missing = this.missingWaypoints();
    if (missing.length) return `📍 Noch nicht befahren: ${missing.map((w) => w.name).join(', ')}.`;
    return this.opts.rules ? routeProblem(this.opts.rules, this.plain(), this.rn) : null;
  }

  /** Bezirkstour: Bezirke, durch die die Route noch nicht führt */
  missingDistricts(): number[] {
    return this.opts.rules ? missingDistricts(this.opts.rules, this.plain(), this.rn) : [];
  }

  /** „3 Punkte“: noch nicht befahren */
  missingWaypoints(legs = this.plain()): Station[] {
    if (!this.opts.waypoints) return [];
    const seen = new Set(legs.flatMap((l) => this.rn.traversed(l.line, l.from, l.to)));
    return this.opts.waypoints.filter((w) => !seen.has(w.id));
  }

  /** Umland: noch im Zug (erste Fahrt fehlt) */
  private get inTrain(): boolean {
    return !!this.opts.umland && !this.legs.length;
  }

  /** Warum diese Linie jetzt nicht geht (Challenge-Regeln, fährt gerade nicht) – null = ok */
  lineBlocked(lineId: string): string | null {
    if (this.opts.idle?.includes(lineId)) return `🌙 Die ${lineId} fährt um diese Uhrzeit nicht.`;
    return this.opts.rules ? lineProblem(this.opts.rules, this.before(), lineId, this.rn) : null;
  }

  get position(): Station {
    // Einfügemodus: die nächste Linie startet dort, wo der Fußweg beginnt
    if (this.swapAt != null) return this.net.station(this.legs[this.swapAt - 1].to);
    return this.legs.length ? this.net.station(this.legs[this.legs.length - 1].to) : this.start;
  }

  /** Teilstrecken vor der nächsten Linie (im Einfügemodus nur die vor dem Fußweg) – für die Regeln */
  private before() {
    return this.plain(this.swapAt != null ? this.legs.slice(0, this.swapAt) : this.legs);
  }

  /**
   * Neue Teilstrecke: normal ans Ende, im Einfügemodus an die Stelle des Fußwegs. Die Fahrt danach steigt dann am neuen
   * Ausstieg ein (oder fällt weg, wenn sie von dort nicht mehr passt). Dieselbe Linie direkt davor/danach → eine Fahrt.
   */
  private addLeg(leg: DraftLeg) {
    const i = this.swapAt;
    this.swapAt = null;
    if (i == null) {
      this.legs.push(leg);
      return;
    }
    const along = (from: string, to: string) => this.net.patterns(leg.line).some((p) => p.indexOf(from) >= 0 && p.indexOf(to, p.indexOf(from) + 1) > p.indexOf(from));
    const prev = this.legs[i - 1];
    const next = this.legs[i];
    if (prev.line.id === leg.line.id && prev.to === leg.from && along(prev.from, leg.to)) {
      prev.to = leg.to;
      this.reflow(i - 1);
    } else if (next && next.line.id === leg.line.id && along(leg.from, next.to)) {
      next.from = leg.from;
    } else {
      this.legs.splice(i, 0, leg);
      this.reflow(i);
    }
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
    if (this.legs.length && !this.isGoal(pos.id)) {
      const g = this.goalNear(pos);
      segs.push({ path: [ll(pos), [g.lat, g.lon]], color: '#666', walk: true });
    }
    const at = this.position;
    if (this.pickedLine && this.board && this.board !== at.id)
      segs.push({ path: [ll(at), ll(this.net.station(this.board))], color: '#666', walk: true });
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
  /** Fußweg vor Teilstrecke i wird gerade durch eine Linie ersetzt (Auswahl offen) */
  private swapAt: number | null = null;

  /**
   * Fußweg mitten in der Route: ein reines Werkzeug – antippen, dann kommt die nächste eingegebene Linie an diese
   * Stelle statt ans Ende (ohne Vorschläge, die würden die Lösung verraten). „Beenden“ verlässt den Modus.
   */
  private swapControls(i: number): string {
    if (this.opts.typed || this.locked) return '';
    if (this.swapAt !== i) return `<button class="walk-swap link" data-swap="${i}" title="Die nächste Linie hier statt am Ende einfügen">➕ Linie hier einfügen</button>`;
    return `<span class="walk-swap-on">⤵ Die nächste Linie kommt hierher <button class="link" data-swap-cancel>Beenden</button></span>`;
  }
  /** Linie per Tastatur gewählt → Fokus beim Ausstieg bzw. (hält woanders) beim Einstieg */
  private openPicker = false;
  /** Einstieg gerade geändert → Fokus bleibt dort */
  private focusBoard = false;

  private render() {
    this.el.innerHTML = '';
    const list = h('ol', { class: 'legs' });
    let pos = this.start;
    const hideD = !!this.opts.hideDistances;
    const typed = !!this.opts.typed;
    this.legs.forEach((l, i) => {
      const from = this.net.station(l.from);
      const to = this.net.station(l.to);
      // Umland: die erste Fahrt kommt aus dem Ort – kein Fußweg, sondern der Zug bis zur Stadtgrenze
      const train = i === 0 && this.opts.umland ? this.opts.umland.options.find((o) => o.entry === l.from && o.lines.includes(l.line.id)) : undefined;
      if (train) list.append(h('li', { class: 'leg-walk walk-quiet' }, `🚆 Im Zug aus ${esc(this.opts.umland!.town)} – ca. ${train.min} min bis ${esc(from.name)}`));
      // Fußweg vor dieser Teilstrecke: zwischendurch und über 250 m als eigener Block (wie eine Fahrt)
      else if (from.id !== pos.id) {
        const d = distM(pos, from);
        const level = d > loud() ? 'walk-loud' : d > quiet() ? 'walk-mid' : 'walk-quiet';
        // mitten in der Route: Fußweg durch eine Linie ersetzen
        const swap = i > 0 ? this.swapControls(i) : '';
        if (i > 0 && d > quiet() && !hideD)
          list.append(
            h('li', { class: `leg walk-leg ${level}${this.swapAt === i ? ' inserting' : ''}` }, `<div class="leg-main"><span class="walk-icon">${walkIcon()}</span>
              <span class="leg-text">${esc(pos.name)} → <b>${esc(from.name)}</b><small>${walkText(d)}</small></span></div>${swap}`),
          );
        else list.append(h('li', { class: `leg-walk ${level}${this.swapAt === i ? ' inserting' : ''}` }, `${walkIcon()} ${hideD ? '' : `${fmtDist(d)} `}${scooterMode ? 'mit dem Scooter' : 'zu Fuß'} nach ${esc(from.name)}${hideD ? '' : ` ${walkMin(d)}`} ${swap}`));
      }
      const stops = this.net.stopsBetween(l.line, l.from, l.to);
      const last = i === this.legs.length - 1;
      const fromName = this.opts.hideStart && from.id === this.start.id ? 'Start' : from.name;
      // Einbahn/Schleife: die Linie hält hier, aber nicht in diese Richtung → Einstieg woanders (Punkt 11)
      // nur wenn die Linie hier hält, das Ziel der Teilstrecke von hier aber in keiner Fahrtrichtung erreicht –
      // wer bewusst ein Stück geht (U6 bis Burggasse, zu Fuß zur Josefstädter Straße), bekommt keinen Hinweis
      const pats = this.net.patterns(l.line);
      const oneWay =
        !train &&
        from.id !== pos.id &&
        pats.some((p) => p.includes(pos.id)) &&
        !pats.some((p) => {
          const a = p.indexOf(pos.id);
          return a >= 0 && p.indexOf(l.to, a + 1) > a;
        });
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
        // Regeln nur mit den Teilstrecken davor prüfen (sonst sperrt z.B. der Fußbus die eigene Linie)
        const sel = this.alightSelect(l.line, l.from, l.to, this.plain(this.legs.slice(0, i)), !!train);
        sel.classList.add('leg-alight');
        sel.title = 'Ausstieg ändern';
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          const [nf, nt] = parseAlight(sel.value, l.from);
          l.from = nf;
          l.to = nt;
          this.swapAt = null;
          this.reflow(i);
          this.resetForm();
        });
        li.querySelector('.leg-text small')!.before(sel);
      }
      li.querySelector('[data-act=remove]')?.addEventListener('click', () => {
        this.legs.pop();
        this.swapAt = null;
        this.notice = '';
        this.resetForm();
      });
      list.append(li);
      pos = to;
    });
    if (this.legs.length) this.el.append(list);
    // Einfügemodus an/aus
    list.querySelectorAll<HTMLElement>('[data-swap]').forEach((b) =>
      b.addEventListener('click', () => {
        this.swapAt = Number(b.dataset.swap);
        this.notice = '';
        this.resetForm();
      }),
    );
    list.querySelectorAll<HTMLElement>('[data-swap-cancel]').forEach((b) =>
      b.addEventListener('click', () => {
        this.swapAt = null;
        this.resetForm();
      }),
    );
    if (this.notice) this.el.append(h('div', { class: 'warn' }, esc(this.notice)));

    const arrived = this.isGoal(pos.id);
    const full = this.legs.length >= restrictionMaxLegs(this.restriction);
    if (this.swapAt != null && !full) this.el.append(this.renderForm());
    else if (!arrived && !full) this.el.append(this.renderForm());
    if ((!arrived || this.swapAt != null) && full)
      this.el.append(h('div', { class: 'warn' }, `${esc(restrictionLabel(this.restriction!, this.banned))}: keine weitere Linie möglich.`));

    // E-Scooter: noch keine Linie – ganz mit dem Scooter abgeben geht auch
    if (!this.legs.length && scooterMode && !this.opts.hideDistances) {
      const goal = this.goalNear(pos);
      const foot = h('div', { class: 'submit-row' }, `<div class="walk">🛴 Nur mit dem Scooter: ${walkText(goal.dist)}</div><button class="btn btn-ghost" data-act="submit">Nur Scooter – abgeben</button>`);
      foot.querySelector('button')!.disabled = this.locked;
      foot.querySelector('button')!.addEventListener('click', () => this.onSubmit());
      this.el.append(foot);
    }
    if (this.legs.length) {
      const goal = this.goalNear(pos);
      const goalWord = this.opts.water ? `zum Wasser (${esc(goal.name)})` : this.opts.targets ? `zum nächsten Ziel (${esc(goal.name)})` : 'zum Ziel';
      const endWalk = arrived || hideD || (this.opts.waypoints && this.missingWaypoints().length) ? '' : `<div class="walk">${walkIcon()} ${walkText(goal.dist)} ${goalWord}</div>`;
      const far = !arrived && !hideD && !this.opts.water && !scooterMode && goal.dist > WALK_WARN_M ? '<div class="warn">Ziemlich weiter Fußweg – sicher?</div>' : '';
      // fehlende Punkte nennt die Regel-Zeile (submitProblem)
      const todo = '';
      // Regel für die ganze Route (mind. eine S-Bahn …) noch nicht erfüllt → vor dem Abgeben sagen
      const problem = this.submitProblem() ?? (!this.opts.rules && !restrictionAllowsRoute(this.restriction, this.legs.map((l) => l.line)) ? `${RESTRICTIONS[this.restriction!].icon} ${RESTRICTIONS[this.restriction!].hint}` : null);
      // Challenge-Regel nicht erfüllt: Abgeben geht erst, wenn sie erfüllt ist
      const rule = problem ? `<div class="warn rule-warn">${esc(problem)}${this.submitProblem() ? '<br><small>Abgeben geht erst, wenn das erfüllt ist.</small>' : ''}</div>` : '';
      const foot = h('div', { class: 'submit-row' }, `${endWalk}${far}${todo}${rule}<button class="btn btn-primary" data-act="submit">Route abgeben</button><small class="kbd-hint">Strg + Enter</small>`);
      foot.querySelector('button')!.disabled = this.locked || !!this.submitProblem();
      foot.querySelector('button')!.addEventListener('click', () => this.onSubmit());
      this.el.append(foot);
      // am Ziel: Fokus auf „Route abgeben“ (Enter gibt ab)
      if (arrived && !this.locked) queueMicrotask(() => foot.querySelector('button')!.focus());
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
    if (this.swapAt != null) {
      const to = this.net.station(this.legs[this.swapAt].from);
      const title = h('div', { class: 'form-title inserting' }, `Einfügen ab <b>${esc(posName)}</b> <small>statt zu Fuß nach ${esc(to.name)}</small> <button class="link" data-act="insert-off">Beenden</button>`);
      title.querySelector('button')!.addEventListener('click', () => {
        this.swapAt = null;
        this.resetForm();
      });
      form.append(title);
    } else form.append(h('div', { class: 'form-title' }, this.legs.length ? `Weiter ab <b>${esc(posName)}</b>` : `Los geht's ab <b>${esc(posName)}</b>`));

    if (!this.pickedLine) {
      const input = h('input', { type: 'text', class: 'line-input', placeholder: 'Linie eingeben, z.B. U2, 5B, 43, S45 …', autocomplete: 'off', spellcheck: 'false' });
      const results = h('div', { class: 'line-results', role: 'listbox', 'aria-label': 'Passende Linien' });
      // Tastatur: ← → (bzw. ↑ ↓) wählt unter den Vorschlägen (52 → 52A → 52B), Enter nimmt die gewählte
      let active = 0;
      let found: Line[] = [];
      const update = () => {
        // Umland: im Zug alle Linien zeigen – welcher Zug der richtige ist, gehört zur Aufgabe
        found = this.net.searchLines(input.value, this.restriction, this.banned).filter((l) => !this.lineBlocked(l.id) || (this.inTrain && !this.opts.idle?.includes(l.id)));
        active = Math.min(active, Math.max(0, found.length - 1));
        results.innerHTML = found
          .map((l, i) => `<button class="line-opt ${i === active && input.value.trim() ? 'active' : ''}" data-line="${esc(l.id)}" role="option" aria-selected="${i === active}" tabindex="-1">${lineChip(l.mode, l.id, l.color)}</button>`)
          .join('');
        if (input.value.trim() && !found.length) {
          const q = input.value.trim().toLowerCase().replace(/\s+/g, '');
          const blocked = this.banned.find((id) => id.toLowerCase() === q);
          // genau diese Linie gibt es, aber die Challenge verbietet sie gerade → sagen, warum
          const exact = this.net.data.lines.find((l) => l.id.toLowerCase() === q);
          const why = exact ? (this.lineBlocked(exact.id) ?? (!restrictionAllowsLine(this.restriction, this.banned, exact) ? `⛔ ${exact.id} ist in dieser Runde nicht erlaubt.` : null)) : null;
          results.innerHTML = `<span class="${why ? 'warn' : 'muted'}">${why ? esc(why) : blocked ? `⛔ ${esc(blocked)} ist in dieser Runde gesperrt` : `Keine Linie gefunden${this.restriction ? ' (Einschränkung beachten)' : ''}`}</span>`;
        }
      };
      input.addEventListener('input', () => {
        active = 0;
        update();
      });
      input.addEventListener('keydown', (e) => {
        const atEnd = input.selectionStart === input.value.length;
        const move = (d: number) => {
          e.preventDefault();
          active = (active + d + found.length) % found.length;
          update();
        };
        if (found.length > 1 && ((e.key === 'ArrowRight' && atEnd) || e.key === 'ArrowDown')) return move(1);
        if (found.length > 1 && ((e.key === 'ArrowLeft' && active > 0) || e.key === 'ArrowUp')) return move(-1);
        if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
        // sonst landet das Enter (keypress) beim gleich fokussierten Ausstiegsfeld und öffnet die Browser-Liste
        e.preventDefault();
        const pick = found[active] ?? this.net.searchLines(input.value, this.restriction, this.banned).filter((l) => !this.lineBlocked(l.id))[0];
        if (pick) {
          // mit der Tastatur gewählt → Ausstiegsliste gleich offen (Pfeiltasten + Enter)
          this.openPicker = true;
          this.pickLine(pick);
        }
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
    // Umland: man sitzt im Zug – die erste Fahrt beginnt an der Stadtgrenze
    const train = this.inTrain ? this.opts.umland!.options.find((o) => o.lines.includes(line.id)) : undefined;
    const opts = train ? [{ station: this.net.station(train.entry), dist: 0 }] : this.net.boardOptions(line, pos);
    const boardSel = h('select', { class: 'board-select' });
    const stProblem = (id: string) => (this.opts.rules ? stationProblem(this.opts.rules, line.id, id, this.rn) : null);
    boardSel.innerHTML = opts
      .map((o) => {
        const bad = stProblem(o.station.id);
        if (train) return `<option value="${o.station.id}">${esc(this.opts.umland!.town)} – im Zug (in Wien ab ${esc(o.station.name)})</option>`;
        return `<option value="${o.station.id}" ${bad ? 'disabled' : ''} title="${esc(bad ?? '')}">${o.dist === 0 ? `${esc(o.station.name)} (hier)` : `${esc(o.station.name)} · ${walkIcon()} ${fmtDist(o.dist)} ${walkMin(o.dist)}`}${bad ? ` – ${problemBadge(this.opts.rules!)}` : ''}</option>`;
      })
      .join('');
    // gesperrter Einstieg vorgewählt → den ersten erlaubten nehmen
    if (stProblem(this.board!)) this.board = opts.find((o) => !stProblem(o.station.id))?.station.id ?? this.board;
    boardSel.value = this.board!;
    boardSel.addEventListener('change', () => {
      this.board = boardSel.value;
      // Fokus bleibt beim Einstieg (Pfeiltasten wechseln dort weiter durch die Haltestellen)
      this.focusBoard = true;
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
      else form.append(h('div', { class: 'walk-note' }, `${walkIcon()} ${walkText(boardDist)} zur Haltestelle ${esc(boardName)}`));
    } else if (boardDist > loud() && !this.opts.hideDistances)
      form.append(
        h(
          'div',
          { class: 'walk-alert walk-loud', role: 'status' },
          `⚠️ <b>Die ${esc(line.id)} fährt nicht bei ${esc(pos.name)}.</b> Nächster Halt: ${esc(boardName)} – ${walkText(boardDist)}. Absicht? Sonst „andere Linie“.`,
        ),
      );
    else if (boardDist > quiet() && !this.opts.hideDistances)
      form.append(
        h(
          'div',
          { class: 'walk-alert walk-mid' },
          // hält die Linie hier, ist ein anderer Einstieg selbst gewählt – dann nur den Weg nennen
          servesHere
            ? `${walkIcon()} Einstieg ${esc(boardName)}, ${walkText(boardDist)}.`
            :`${walkIcon()} Die ${esc(line.id)} hält nicht hier – Einstieg ${esc(boardName)}, ${walkText(boardDist)}.`,
        ),
      );
    else if (boardDist > 0 && !this.opts.hideDistances) form.append(h('div', { class: 'walk-note' }, `${walkIcon()} ${fmtDist(boardDist)} zum Einstieg ${esc(boardName)} ${walkMin(boardDist)}`));

    // Ausstieg nach Richtung gruppiert
    const alightSel = this.alightSelect(line, this.board!, null, this.before(), !!train);
    const commit = () => {
      if (!alightSel.value) return;
      const [from, to] = parseAlight(alightSel.value, this.board!);
      this.addLeg({ line, from, to });
      this.resetForm();
    };
    alightSel.addEventListener('change', commit);
    keyboardList(alightSel, commit, () => this.resetForm(), { up: () => boardSel.focus() });
    // Einstieg per Tastatur: gleiche Liste; übernommen → weiter zum Ausstieg
    keyboardList(
      boardSel,
      () => {
        this.board = boardSel.value;
        this.render();
      },
      () => this.resetForm(),
      { down: () => alightSel.focus() },
    );
    const alightRow = h('label', { class: 'field' }, '<span>Ausstieg</span>');
    alightRow.append(alightSel);
    form.append(alightRow);
    // Entf: angefangene Linie verwerfen (fertige Teilstrecken bleiben)
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete') return;
      e.preventDefault();
      this.resetForm();
    });
    // per Tastatur gewählt: Fokus beim Ausstieg (Enter öffnet die Liste) – hält die Linie nicht hier, erst beim
    // Einstieg (Fußweg ansehen, ggf. andere Haltestelle wählen)
    const keyboard = this.openPicker;
    const stay = this.focusBoard;
    this.openPicker = this.focusBoard = false;
    const here = this.board === pos.id;
    queueMicrotask(() => (stay || (keyboard && !here) ? boardSel : alightSel).focus());
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

  /** `prev`: Teilstrecken davor (für die Regeln); `stayHere`: Umland – gleich an der Stadtgrenze aussteigen geht */
  private alightSelect(line: Line, board: string, selected: string | null, prev = this.plain(), stayHere = false): HTMLSelectElement {
    const sel = h('select', { class: 'alight-select' });
    const { up, down } = this.net.lineThrough(line, board);
    // Ziel ist eine Adresse: die Haltestelle der Linie, die ihr am nächsten liegt (bis 1,5 km), markieren
    const nearDest = isAddress(this.dest) ? (this.net.boardOptions(line, this.dest, 1).find((o) => o.dist <= 1500) ?? null) : null;
    // Gegenrichtung mit anderem Einstieg: Wert "einstieg>ausstieg"
    const rules = this.opts.rules;
    const opt = (s: Station, alt?: Station) => {
      const leg = { line: line.id, from: alt?.id ?? board, to: s.id };
      let bad = rules ? legProblem(rules, prev, leg, this.rn) : null;
      // am Ziel aussteigen geht nur, wenn die ganze Route die Regeln erfüllt (z.B. letzte Fahrt mit der Bim)
      const goal = this.isGoal(s.id, [...prev, leg]);
      if (!bad && rules && goal) bad = routeProblem(rules, [...prev, leg], this.rn);
      // Brückenkenner: wie viele Brücken diese Fahrt überquert
      const nb = rules?.restriction === 'minBridges' ? (this.rn.bridges?.(leg.line, leg.from, leg.to).length ?? 0) : 0;
      const flag = (nb ? ` 🌉${nb > 1 ? `×${nb}` : ''}` : '') + (goal || s.id === this.dest.id ? ' 🏁' : this.opts.targets?.some((t) => t.id === s.id) ? ' 🎯' : this.opts.waypoints?.some((t) => t.id === s.id) ? ' 📍' : '');
      const badge = bad ? ` – ${goal && rules && !legProblem(rules, prev, leg, this.rn) ? `noch nicht: ${bad.replace(/^\S+\s/, '').slice(0, 48)}` : problemBadge(rules!)}` : '';
      return `<option value="${alt ? `${alt.id}>` : ''}${s.id}" ${bad ? 'disabled' : ''} title="${esc(bad ?? '')}">${esc(s.name)}${flag}${s.id === nearDest?.station.id ? ` 📍 ${fmtDist(nearDest.dist)} zum Ziel ${walkMin(nearDest.dist)}` : ''}${alt && alt.id !== board ? ` ↩ ab ${esc(alt.name)}` : ''}${badge}</option>`;
    };
    const here = this.net.station(board);
    // Reihenfolge wie auf dem Linienplan: obere Stationen · "↑ Richtung …" · hier · "↓ Richtung …" · untere Stationen.
    // Die Überschriften sind leere <optgroup>s, damit sie fett direkt neben der aktuellen Station stehen.
    // Ohne Vorauswahl ist die aktuelle Station markiert → die Liste öffnet sich genau dort.
    sel.innerHTML =
      (up ? up.stations.map((s) => opt(s, up.board)).join('') + `<optgroup label="↑ ${esc(up.label)}"></optgroup>` : '') +
      (stayHere
        ? `<option value="${board}">● ${esc(here.name)} – gleich hier aussteigen (Stadtgrenze)</option>`
        : `<option value="" disabled class="here" ${selected ? '' : 'selected'}>● ${esc(here.name)} – Ausstieg wählen …</option>`) +
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
      this.addLeg({ line, from: from!, to: to! });
      this.resetForm();
    };
    fields.querySelector('[data-act=add]')!.addEventListener('click', add);
    alight.addEventListener('keydown', (e) => e.key === 'Enter' && !e.ctrlKey && !e.metaKey && add());
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
    const why = this.lineBlocked(line.id);
    if (why) return toast(why, 'info');
    // Einstieg nur dort möglich, wo es die Regel verbietet (z.B. U1 hier nur unter der Erde) → gleich sagen
    const rules = this.opts.rules;
    if (rules) {
      const opts = this.net.boardOptions(line, this.position);
      const bad = opts.map((o) => stationProblem(rules, line.id, o.station.id, this.rn));
      if (opts.length && bad.every(Boolean)) return toast(bad[0]!, 'info');
    }
    this.pickedLine = line;
    // Umland: man sitzt im Zug – „Einstieg“ ist seine erste Station in Wien
    const train = this.inTrain ? this.opts.umland!.options.find((o) => o.lines.includes(line.id)) : undefined;
    this.board = train?.entry ?? this.net.boardOptions(line, this.position, 1)[0].station.id;
    this.render();
  }
}

/**
 * Ein-/Ausstieg nur mit der Tastatur: eine eigene Liste unter dem Auswahlfeld (das Browser-Fenster lässt sich nicht
 * überall per Tastatur steuern). Enter klappt auf, ↑ ↓ wandert durch die Halte (ohne schon zu übernehmen), Enter
 * übernimmt, Escape klappt zu bzw. wählt eine andere Linie. Zugeklappt wechseln ↑ ↓ zwischen den Feldern.
 * Mit der Maus bleibt alles wie gewohnt.
 */
let pointerDown = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (pointerDown = true), true);
  document.addEventListener('pointerup', () => (pointerDown = false), true);
}

function keyboardList(sel: HTMLSelectElement, commit: () => void, cancel: () => void, nav: { up?: () => void; down?: () => void } = {}): { open: () => void } {
  let pop: HTMLElement | null = null;
  const rows = () => [...(pop?.querySelectorAll<HTMLElement>('[data-i]') ?? [])];
  const mark = () => {
    for (const r of rows()) {
      const on = Number(r.dataset.i) === sel.selectedIndex;
      r.classList.toggle('active', on);
      r.setAttribute('aria-selected', String(on));
      if (on) r.scrollIntoView({ block: 'nearest' });
    }
  };
  const close = () => {
    pop?.remove();
    pop = null;
    sel.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    if (pop) return;
    pop = h('div', { class: 'kb-list', role: 'listbox', 'aria-label': 'Ausstieg' });
    let i = 0;
    for (const el of sel.children) {
      if (el instanceof HTMLOptGroupElement) pop.append(h('div', { class: 'kb-group' }, esc(el.label)));
      else {
        const o = el as HTMLOptionElement;
        pop.append(h('div', { class: `kb-opt${o.disabled ? ' here' : ''}`, 'data-i': String(i), role: 'option' }, esc(o.text)));
        i++;
      }
    }
    // Klick in der Liste: übernehmen, ohne dass das Auswahlfeld den Fokus verliert
    pop.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const r = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (!r || r.classList.contains('here')) return;
      sel.selectedIndex = Number(r.dataset.i);
      close();
      commit();
    });
    sel.after(pop);
    sel.setAttribute('aria-expanded', 'true');
    mark();
    rows().find((r) => r.classList.contains('active'))?.scrollIntoView({ block: 'center' });
  };
  const move = (d: 1 | -1) => {
    for (let i = sel.selectedIndex + d; i >= 0 && i < sel.options.length; i += d)
      if (!sel.options[i].disabled) {
        sel.selectedIndex = i;
        return mark();
      }
  };
  sel.addEventListener('keydown', (e) => {
    // Strg+Enter = Route abgeben (RouteBuilder)
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // zu: ↑ ↓ wechselt zwischen Einstieg und Ausstieg; offen: durch die Halte
      if (!pop) return void (e.key === 'ArrowUp' ? nav.up : nav.down)?.();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (pop && sel.value) {
        close();
        commit();
      } else open();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (pop) close();
      else cancel();
    }
  });
  // Fokus weg: zu. Bei einem Mausklick erst danach – sonst rutscht der Inhalt (Liste weg) zwischen Drücken und
  // Loslassen, und der Klick (z.B. auf „andere Linie“) landet ins Leere
  sel.addEventListener('blur', () => {
    if (!pointerDown) return close();
    document.addEventListener('pointerup', () => setTimeout(close), { once: true });
  });
  // Maus: das gewohnte Auswahlfenster – die eigene Liste dann zu
  sel.addEventListener('mousedown', close);
  return { open };
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
