// Admin-Seite, Reiter „Netzpläne“: Standard-Netzplan und weitere (in der Lobby wählbar), Stellschrauben der
// Routenberechnung, Änderungen an Netz und Fahrplan (jede Änderung wird sofort gespeichert und angewendet – so kennen
// die Auswahlfelder gleich neue Stationen und Linien), Fahrplan je Linie mit direkt änderbaren Fahrzeiten,
// Probe-Abfrage mit allen Details, Versionen.
import L from 'leaflet';
import type { DayType, LineEdit, Mode, NetworkPlan, RouteOption, RoutingAdminState, RoutingParams, ServiceBand, SlotId, TimetableLineInfo, TimetableLineView } from '../../../shared/types.ts';
import { lineColor, MODE_LABEL, TIME_SLOTS } from '../../../shared/rules.ts';
import { NetGraph } from '../netgraph.ts';
import { NetMapLayer, netView } from '../netmap.ts';
import type { NetIndex } from '../net.ts';
import { chain, esc, lineChip, makeExpandable, routeDetails, toast } from '../ui.ts';
import { infoTip } from '../widgets.ts';
import { adm, forgetPlanNet, planNet } from './api.ts';
import { miniMap } from './minimap.ts';
import { mountPickers, pickerSlot } from './picker.ts';

const PARAM_INFO: Record<keyof RoutingParams, { label: string; unit: string; hint: string; step?: number }> = {
  changeMin: { label: 'Umsteigezeit', unit: 'min', hint: 'Umsteigen in ein anderes Fahrzeug an derselben Haltestelle.' },
  transferWalkM: { label: 'Umsteige-Fußweg höchstens', unit: 'm', hint: 'Zu Fuß zu einer anderen Haltestelle umsteigen – bis zu dieser Entfernung (Luftlinie).' },
  accessWalkM: { label: 'Fußweg von/zu Adressen höchstens', unit: 'm', hint: 'Bei Adressen als Start/Ziel: so weit wird höchstens zur ersten/von der letzten Haltestelle gegangen.' },
  walkOnlyM: { label: 'Ganz zu Fuß bis', unit: 'm', hint: 'Bis zu dieser Entfernung wird auch „nur gehen“ als Verbindung angeboten.' },
  maxRides: { label: 'Fahrten je Verbindung höchstens', unit: '', hint: 'Mehr Fahrten (= mehr Umstiege) werden nicht gesucht.' },
  firstWaitFactor: { label: 'Anteil erste Wartezeit („Realistisch“)', unit: '×', hint: 'Am Start zählt nur dieser Anteil der Ø-Wartezeit.', step: 0.05 },
};

type Kind = LineEdit['kind'];
const KINDS: [Kind, string][] = [
  ['headway', 'Takt ändern'],
  ['addVariant', 'Zusätzliche Fahrten'],
  ['extend', 'Verlängern'],
  ['cut', 'Kürzen'],
  ['time', 'Fahrzeit'],
  ['addLine', 'Neue Linie'],
  ['removeLine', 'Linie entfernen'],
  ['addStation', 'Neue Station'],
  ['renameStation', 'Umbenennen'],
  ['moveStation', 'Verschieben'],
  ['removeStation', 'Station auflassen'],
];
const DAYS: [DayType, string][] = [
  ['wd', 'Mo–Fr'],
  ['sa', 'Samstag'],
  ['su', 'Sonn-/Feiertag'],
];
const date = (t: number) => new Date(t).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' });
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'plan';

export interface Tab {
  html(): Promise<string>;
  bind(root: HTMLElement): void;
}

export function plansTab(rerender: () => void): Tab {
  let state: RoutingAdminState | null = null;
  let planId = 'regular';
  let net: NetIndex | null = null;
  /** Stellschrauben (erst „Speichern“ wendet an) */
  let params: Partial<RoutingParams> = {};
  let paramsFor = '';
  const form = {
    kind: 'extend' as Kind,
    line: '',
    at: '',
    end: '' as '' | 'start' | 'end',
    beyond: '',
    pair: '',
    min: 3,
    current: null as number | null,
    station: '',
    name: '',
    district: 0,
    point: null as { lat: number; lon: number } | null,
    mode: 'B' as Mode,
    color: '#0a295d',
    stops: [{ station: '', min: 0 }] as { station: string; min: number }[],
    pattern: '',
    day: 'wd' as DayType,
    from: '06:00',
    to: '20:00',
    every: 10,
    service: { wd: [{ from: '05:00', to: '24:00', every: 10 }], sa: [{ from: '05:30', to: '24:00', every: 15 }], su: [{ from: '06:00', to: '24:00', every: 15 }] } as Record<DayType, ServiceBand[]>,
  };
  /** Bereich des Reiters */
  let section: 'fahrplan' | 'aenderungen' | 'karte' | 'probe' | 'plan' = 'fahrplan';
  /** Fahrplan „wie gebaut“ (ohne Änderungen) ansehen */
  let asBuilt = false;
  let lines: TimetableLineInfo[] | null = null;
  let linesFor = '';
  let lineFilter = '';
  let ttLine = '';
  let ttDay: DayType = 'wd';
  /** Haltefolgen der gewählten Linie (Fahrplan-Ansicht bzw. „Takt ändern“) */
  let lineView: TimetableLineView | null = null;
  let lineViewFor = '';
  const lineInfo = (id: string) => lines?.find((l) => l.line === id);
  /** „Halt einfügen“ offen: Haltefolge und Abschnitt */
  let insertAt: { a: string; b: string; station: string; minA: number; minB: number } | null = null;
  /** Abfahrten bearbeiten: je Haltefolge (key) gestrichene und neue Zeiten, bis „Speichern“ */
  const depDraft = new Map<string, { remove: Set<number>; add: number[] }>();
  /** „Takt“ je Haltefolge */
  const hwDraft = new Map<string, { from: string; to: string; every: number }>();
  const viewPlan = () => (asBuilt ? '__base' : planId);
  const endNames = new Map<string, string>();
  const loadLineView = async (line: string) => {
    lineView = line ? await adm<TimetableLineView>('GET', `/api/admin/routing/timetable?plan=${encodeURIComponent(viewPlan())}&line=${encodeURIComponent(line)}`) : null;
    lineViewFor = `${viewPlan()}:${line}`;
    // Enden außerhalb Wiens stehen im Schlüssel als Halt-ID – Namen für die Änderungsliste merken
    for (const p of lineView?.patterns ?? []) {
      const [a, b] = p.key.split('>');
      endNames.set(a, p.stops[0].name);
      endNames.set(b, p.stops[p.stops.length - 1].name);
    }
  };
  const probe = { from: '', to: '', slot: 'wd12' as SlotId, routes: null as RouteOption[] | null, busy: false };
  let newPlan: { label: string; copy: boolean } | null = null;
  let versions: { id: string; at: number; by: string; note: string }[] | null = null;

  const plan = (): NetworkPlan => state!.plans.find((p) => p.id === planId) ?? state!.plans[0];
  const stName = (id: string) => net?.stations.get(id)?.name ?? endNames.get(id) ?? (/^(at:|\d{6,})/.test(id) ? 'außerhalb Wiens' : id);
  const line = () => (form.line ? net?.lines.get(form.line) : undefined);
  /** längste Haltefolge der Linie (für Verlängern/Kürzen) */
  const mainPattern = (): string[] => {
    const l = line();
    if (!l || !net) return [];
    return [...net.patterns(l)].sort((a, b) => b.length - a.length)[0] ?? [];
  };

  function describe(e: LineEdit): string {
    switch (e.kind) {
      case 'extend':
        return `<b>${esc(e.line)}</b> fährt über ${esc(stName(e.at))} hinaus: ${e.stops.map((s) => `${esc(stName(s.station))} <small>+${s.min} min</small>`).join(' → ')}`;
      case 'cut':
        return `<b>${esc(e.line)}</b> endet bei ${esc(stName(e.at))} <small>– Richtung ${esc(stName(e.beyond))} fällt weg</small>`;
      case 'time':
        return `<b>${esc(e.line)}</b> ${esc(stName(e.from))} ↔ ${esc(stName(e.to))}: <b>${e.min} min</b>`;
      case 'addStation':
        return `Neue Station <b>${esc(e.name)}</b> <small>(${e.lat.toFixed(5)}, ${e.lon.toFixed(5)})</small>`;
      case 'renameStation':
        return `Station <b>${esc(e.station)}</b> heißt <b>${esc(e.name)}</b>`;
      case 'moveStation':
        return `<b>${esc(stName(e.station))}</b> verschoben <small>(${e.lat.toFixed(5)}, ${e.lon.toFixed(5)})</small>`;
      case 'removeStation':
        return `<b>${esc(stName(e.station))}</b> aufgelassen <small>– Linien fahren ohne Halt durch</small>`;
      case 'addLine':
        return `Neue Linie ${lineChip(e.mode, e.line, e.color)} ${e.stops.map((s) => esc(stName(s.station))).join(' – ')}`;
      case 'removeLine':
        return `Linie <b>${esc(e.line)}</b> entfernt`;
      case 'headway': {
        const [a, b] = (e.pattern ?? '').split('>');
        return `<b>${esc(e.line)}</b> ${DAYS.find((d) => d[0] === e.day)![1]} ${e.from}–${e.to}: <b>alle ${e.every} min</b>${e.pattern ? ` <small>(${esc(stName(a))} ↔ ${esc(stName(b))})</small>` : ''}`;
      }
      case 'addVariant':
        return `<b>${esc(e.line)}</b> zusätzlich ${e.stops.map((x) => esc(stName(x.station))).join(' – ')} <small>(${serviceText(e.service)})</small>`;
      case 'insertStop':
        return `<b>${esc(e.line)}</b> hält zusätzlich in <b>${esc(stName(e.station))}</b> <small>(zwischen ${esc(stName(e.a))} und ${esc(stName(e.b))}, +${e.minA}/+${e.minB} min)</small>`;
      case 'skipStop':
        return `<b>${esc(e.line)}</b> hält nicht mehr in <b>${esc(stName(e.station))}</b>`;
      case 'departures': {
        const [a, b] = e.pattern.split('>');
        return `<b>${esc(e.line)}</b> ${esc(stName(a))} → ${esc(stName(b))}, ${DAYS.find((d) => d[0] === e.day)![1]}: ${e.add.length ? `+${e.add.join(', ')}` : ''}${e.add.length && e.remove.length ? ' · ' : ''}${e.remove.length ? `<s>${e.remove.join(', ')}</s>` : ''}`;
      }
    }
  }

  function serviceText(sv: Record<DayType, ServiceBand[]>): string {
    return DAYS.filter(([d]) => sv[d]?.length)
      .map(([d, l]) => `${l} ${sv[d].map((b) => `${b.from}–${b.to} alle ${b.every}`).join(', ')}`)
      .join(' · ');
  }

  // -------------------------------------------------------------- speichern

  async function savePlan(p: Partial<NetworkPlan> & { id: string }, ok: string) {
    const cur = state!.plans.find((x) => x.id === p.id);
    const body = { label: cur?.label, hint: cur?.hint, inMenu: cur?.inMenu, params: cur?.params ?? {}, edits: cur?.edits ?? [], ...p };
    state = await adm<RoutingAdminState>('PUT', `/api/admin/routing/plans/${encodeURIComponent(p.id)}`, body);
    forgetPlanNet(p.id);
    net = null;
    versions = null;
    if (ok) toast(ok, 'info');
  }

  /** Änderung hinzufügen = speichern und anwenden */
  async function addEdit(e: LineEdit) {
    await savePlan({ id: planId, edits: [...plan().edits, e] }, 'Gespeichert und angewendet');
  }

  // -------------------------------------------------------------- Ansicht

  async function html(): Promise<string> {
    state ??= await adm<RoutingAdminState>('GET', '/api/admin/routing');
    if (!state.plans.some((p) => p.id === planId)) planId = 'regular';
    net ??= await planNet(planId);
    const p = plan();
    if (paramsFor !== p.id) ((params = { ...p.params }), (paramsFor = p.id));
    const report = state.report[planId] ?? [];
    if (section === 'fahrplan' && linesFor !== viewPlan()) {
      lines = await adm<TimetableLineInfo[]>('GET', `/api/admin/routing/lines?plan=${encodeURIComponent(viewPlan())}`);
      linesFor = viewPlan();
    }
    if (ttLine && lineViewFor !== `${viewPlan()}:${ttLine}`) await loadLineView(ttLine);
    const sections: [typeof section, string][] = [
      ['fahrplan', '🗓 Fahrplan'],
      ['aenderungen', `✏️ Änderungen (${p.edits.length})`],
      ['karte', '🗺 Netzkarte'],
      ['probe', '🔎 Probe-Abfrage'],
      ['plan', '⚙️ Plan & Routenberechnung'],
    ];
    let content = '';
    if (section === 'fahrplan') content = timetableSection();
    else if (section === 'aenderungen')
      content = `${p.edits.length ? `<ol class="adm-list adm-edits">${p.edits.map((e, i) => `<li><span>${describe(e)}</span><button class="icon-btn" data-rmedit="${i}" aria-label="Änderung entfernen">✕</button></li>`).join('')}</ol>` : '<p class="muted">Keine – Netz und Fahrplan wie gebaut.</p>'}
        ${report.length ? `<ul class="adm-report">${report.map((r) => `<li class="${r.startsWith('✔') ? 'good' : 'err'}">${esc(r)}</li>`).join('')}</ul>` : ''}
        <div class="adm-new"><h4>Änderung hinzufügen</h4>${formHtml()}</div>
        ${versionsHtml()}`;
    else if (section === 'karte')
      content = `<p class="muted">So sieht das Netz dieses Plans aus – genau diese Karte bekommen alle, die mit ${p.id === 'regular' ? 'dem Standard-Netz' : `„${esc(p.label)}“`} spielen. Neue Linien werden als Verbindung zwischen ihren Halten gezeichnet.</p>
        <div class="adm-netmap" id="pl-netmap"></div>`;
    else if (section === 'probe')
      content = `<p class="muted">Beste Verbindungen wie im Spiel („Realistisch“) mit diesem Netzplan – zum Ausprobieren von Änderungen.</p>
        <div class="adm-probe">${pickerSlot('station', 'from', probe.from, 'Start')}${pickerSlot('station', 'to', probe.to, 'Ziel')}
        <select id="pr-slot">${TIME_SLOTS.map((t) => `<option value="${t.id}" ${t.id === probe.slot ? 'selected' : ''}>${esc(t.short)}</option>`).join('')}</select>
        <button class="btn btn-ghost" id="pr-go" ${probe.busy ? 'disabled' : ''}>${probe.busy ? 'Rechnet …' : 'Berechnen'}</button></div>
        ${probe.routes ? probeHtml(probe.routes) : ''}`;
    else
      content = `${p.id === 'regular' ? '<p class="muted">Der Standard-Netzplan gilt für „Regulär“ – und damit für Quiz, Training, Lernen und alle Karten.</p>' : metaHtml(p)}
        <h3>Routenberechnung</h3>${paramsHtml(p)}`;
    return `
      <div class="adm-plans">${state.plans
        .map((x) => `<button class="adm-plan ${x.id === planId ? 'on' : ''}" data-plan="${esc(x.id)}">${esc(x.id === 'regular' ? 'Standard' : x.label)}${x.inMenu ? ' <small>im Menü</small>' : ''}<small>${x.edits.length} Änderung${x.edits.length === 1 ? '' : 'en'}</small></button>`)
        .join('')}
        <button class="adm-plan adm-plan-new" id="pl-new">+ Neuer Netzplan</button></div>
      ${newPlan ? newPlanHtml() : ''}
      <div class="adm-subnav">${sections.map(([k, l]) => `<button data-section="${k}" class="${section === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${content}`;
  }

  function versionsHtml(): string {
    return `<details class="adm-versions" ${versions ? 'open' : ''}><summary>Frühere Versionen aller Netzpläne</summary>${
      versions
        ? versions.length
          ? `<ul class="adm-list">${versions.map((v) => `<li><span>${date(v.at)} · ${esc(v.by)} · ${esc(v.note)}</span><button class="btn btn-ghost btn-small" data-restore="${v.id}">Wiederherstellen</button></li>`).join('')}</ul>`
          : '<p class="muted">Noch keine.</p>'
        : '<p class="muted">Lädt …</p>'
    }</details>`;
  }

  // -------------------------------------------------------------- Fahrplan: alle Linien, je Linie alle Halte und Abfahrten

  /** Uhrzeit des Betriebstags: nach Mitternacht als 24:30 usw. (so steht es auch im Fahrplan) */
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  function timetableSection(): string {
    const groups: [string, (l: TimetableLineInfo) => boolean][] = [
      ['🚇 U-Bahn', (l) => l.mode === 'U'],
      ['🚆 S-Bahn', (l) => l.mode === 'S' && !l.regional],
      ['🚆 Regionalzüge (auf S-Bahn-Strecken)', (l) => l.regional],
      ['🚋 Straßenbahn', (l) => l.mode === 'T'],
      ['🚌 Bus', (l) => l.mode === 'B'],
      ['🌙 Nachtbus', (l) => l.mode === 'N'],
    ];
    const f = lineFilter.trim().toLowerCase();
    const shown = (lines ?? []).filter((l) => !f || l.line.toLowerCase().startsWith(f) || l.termini.some((t) => t.toLowerCase().includes(f)));
    const chipOf = (l: TimetableLineInfo) => {
      const nl = net?.lines.get(l.line);
      return lineChip(l.mode, l.line, nl?.color ?? lineColor(l.mode, l.line));
    };
    return `<div class="adm-row adm-ttbar">
        <label class="check"><input type="checkbox" id="tt-built" ${asBuilt ? 'checked' : ''}> wie gebaut (ohne Änderungen)</label>
        <input class="line-input" id="tt-filter" placeholder="Linie oder Endstation filtern …" value="${esc(lineFilter)}" autocomplete="off"></div>
      ${asBuilt ? '<p class="muted">Ansicht des Fahrplans aus den GTFS-Daten – zum Vergleichen; ändern geht im Netzplan.</p>' : ''}
      <div class="adm-ttlayout">
        <div class="adm-ttlines">${groups
          .map(([title, pick]) => {
            const ls = shown.filter(pick);
            if (!ls.length) return '';
            return `<h4>${title} <small class="muted">${ls.length}</small></h4><div class="adm-ttgrid">${ls
              .map(
                (l) => `<button class="adm-ttline ${l.line === ttLine ? 'on' : ''}" data-ttline="${esc(l.line)}">${chipOf(l)}<small>${esc(l.termini.join(' – '))}</small><small class="muted">${l.every ? `alle ${l.every} min · ` : ''}${l.trips.wd} Fahrten Mo–Fr</small></button>`,
              )
              .join('')}</div>`;
          })
          .join('')}</div>
        <div class="adm-ttdetail">${ttLine && lineView ? lineDetailHtml(lineView) : '<p class="muted">Linie wählen – dann siehst du jede Haltefolge mit allen Halten, Fahrzeiten und Abfahrten.</p>'}</div>
      </div>`;
  }

  function lineDetailHtml(v: TimetableLineView): string {
    const info = lineInfo(v.line);
    const nl = net?.lines.get(v.line);
    const chip = lineChip(v.mode, v.line, nl?.color ?? lineColor(v.mode, v.line));
    const ro = asBuilt;
    const dayName = DAYS.find((x) => x[0] === ttDay)![1];
    const strip = (hours: number[]) => {
      const max = Math.max(1, ...hours);
      return `<span class="adm-strip" aria-hidden="true">${hours
        .slice(4, 25)
        .map((n, i) => `<i style="height:${Math.round((n / max) * 100)}%" title="${i + 4}–${i + 5} Uhr: ${n} Fahrten"></i>`)
        .join('')}</span>`;
    };
    return `<div class="adm-ttdhead"><h3>${chip} ${info ? esc(info.termini.join(' – ')) : ''}</h3>
        ${ro ? '' : `<div class="adm-row adm-more"><button class="link" data-quick="addVariant">+ Zusätzliche Fahrten</button><button class="link" data-quick="extend">Verlängern</button><button class="link" data-quick="cut">Kürzen</button><button class="link danger" data-quick="removeLine">Linie entfernen</button></div>`}</div>
      <div class="adm-range">Tag ${DAYS.map(([d, l]) => `<button class="${d === ttDay ? 'on' : ''}" data-ttday="${d}">${l}</button>`).join('')}</div>
      ${v.patterns
        .map((p) => {
          const dd = depDraft.get(p.key);
          // Nachtfahrten des Vortags (vor 0:00) gehören zum Vortag – hier nur dieser Betriebstag (bis 27:59)
          const deps = p.deps[ttDay].filter((t) => t >= 0);
          const hw = hwDraft.get(p.key) ?? { from: '06:00', to: '20:00', every: info?.every ?? 10 };
          let cum = 0;
          const rows = p.stops
            .map((st, i) => {
              cum += st.min ?? 0;
              const prev = p.stops[i - 1];
              const canEdit = !ro && st.station;
              const ins =
                !ro && i && insertAt && prev?.station && st.station && insertAt.a === prev.station && insertAt.b === st.station
                  ? `<tr class="adm-insrow"><td colspan="4"><div class="adm-ins">${pickerSlot('station', 'ins', insertAt.station, 'Neuer Halt …')}
                      <label>${esc(prev.name)} → neu <input type="number" min="0" max="60" data-ins="minA" value="${insertAt.minA}"> min</label>
                      <label>neu → ${esc(st.name)} <input type="number" min="0" max="60" data-ins="minB" value="${insertAt.minB}"> min</label>
                      <button class="btn btn-primary btn-small" id="ins-ok">Einfügen</button><button class="link" id="ins-cancel">Abbrechen</button></div></td></tr>`
                  : '';
              return `${ins}<tr><td>${
                !ro && i && prev?.station && st.station ? `<button class="adm-plus" data-insert="${esc(prev.station)}|${esc(st.station)}" title="Halt zwischen ${esc(prev.name)} und ${esc(st.name)} einfügen" aria-label="Halt einfügen">+</button>` : ''
              }${esc(st.name)}</td>
                <td>${i ? (canEdit && prev?.station ? `<input type="number" min="0" max="60" class="adm-ttmin" data-tt="${esc(prev.station)}|${esc(st.station!)}" value="${st.min ?? ''}"> min` : `${st.min ?? '–'} min`) : ''}</td>
                <td class="muted">${i ? `${cum} min` : 'Start'}</td>
                <td>${canEdit && i && i < p.stops.length - 1 ? `<button class="link" data-skip="${esc(st.station!)}" title="${esc(v.line)} hält hier nicht mehr">auslassen</button>` : ''}</td></tr>`;
            })
            .join('');
          const depChips = deps
            .map((t) => `<span class="adm-dep ${dd?.remove.has(t) ? 'gone' : ''}">${hhmm(t)}${ro ? '' : `<button data-dep="${esc(p.key)}|${t}" aria-label="Abfahrt ${hhmm(t)} streichen">${dd?.remove.has(t) ? '↺' : '✕'}</button>`}</span>`)
            .concat((dd?.add ?? []).map((t) => `<span class="adm-dep new">${hhmm(t)}<button data-depnew="${esc(p.key)}|${t}" aria-label="entfernen">✕</button></span>`))
            .join('');
          return `<div class="adm-ttp"><h4>→ ${esc(p.stops[p.stops.length - 1].name)} <small class="muted">ab ${esc(p.stops[0].name)}${p.through ? ` · durchgebunden mit ${esc(p.through)}` : ''}</small></h4>
            <div class="adm-ttdays">${DAYS.map(([d, l]) => `<span><b>${l}</b> ${p.trips[d].reduce((a, b) => a + b, 0)} Fahrten ${strip(p.trips[d])}</span>`).join('')}</div>
            <table class="adm-table adm-stops"><thead><tr><th>Halt</th><th>Fahrzeit</th><th>ab Start</th><th></th></tr></thead><tbody>${rows}</tbody></table>
            <details class="adm-deps" ${dd ? 'open' : ''}><summary>Abfahrten ${dayName} ab ${esc(p.stops[0].name)}: ${deps.length}</summary>
              <div class="adm-deplist">${depChips || '<small class="muted">keine</small>'}</div>
              ${ro ? '' : `<div class="adm-row"><input class="adm-hhmm" data-depadd="${esc(p.key)}" placeholder="HH:MM" maxlength="5"><button class="btn btn-ghost btn-small" data-depaddbtn="${esc(p.key)}">Abfahrt hinzufügen</button>
                ${dd ? `<button class="btn btn-primary btn-small" data-depsave="${esc(p.key)}">Speichern</button><button class="link" data-depcancel="${esc(p.key)}">Verwerfen</button>` : ''}</div>`}
            </details>
            ${ro ? '' : `<div class="adm-hw"><b>Takt ${dayName}</b> von <input class="adm-hhmm" data-hw="${esc(p.key)}|from" value="${hw.from}" maxlength="5"> bis <input class="adm-hhmm" data-hw="${esc(p.key)}|to" value="${hw.to}" maxlength="5"> alle <input type="number" min="2" max="120" data-hw="${esc(p.key)}|every" value="${hw.every}"> min <button class="btn btn-ghost btn-small" data-hwsave="${esc(p.key)}">Übernehmen</button><small class="muted">beide Richtungen</small></div>`}
          </div>`;
        })
        .join('')}`;
  }

  function newPlanHtml(): string {
    return `<div class="adm-box"><label class="field"><span>Name des neuen Netzplans</span><input id="np-label" maxlength="24" value="${esc(newPlan!.label)}" placeholder="z.B. Mit U5"></label>
      <label class="check"><input type="checkbox" id="np-copy" ${newPlan!.copy ? 'checked' : ''}> Änderungen von „${esc(planId === 'regular' ? 'Standard' : plan().label)}“ übernehmen</label>
      <div class="adm-row"><button class="btn btn-primary" id="np-ok">Anlegen</button><button class="btn btn-ghost" id="np-cancel">Abbrechen</button></div></div>`;
  }

  function metaHtml(p: NetworkPlan): string {
    return `<div class="adm-box adm-meta">
      <label class="field"><span>Name im Menü</span><input id="pm-label" maxlength="24" value="${esc(p.label)}"></label>
      <label class="field"><span>Erklärung (Tooltip in der Lobby)</span><input id="pm-hint" maxlength="200" value="${esc(p.hint)}" placeholder="z.B. Mit der geplanten U5 bis Hernals"></label>
      <label class="check"><input type="checkbox" id="pm-menu" ${p.inMenu ? 'checked' : ''}> In der Lobby unter „Netz“ wählbar</label>
      <div class="adm-row"><button class="btn btn-ghost" id="pm-save">Speichern</button><button class="btn btn-danger btn-small" id="pm-del">Netzplan löschen</button></div></div>`;
  }

  function paramsHtml(p: NetworkPlan): string {
    const rows = (Object.keys(PARAM_INFO) as (keyof RoutingParams)[])
      .map((k) => {
        const info = PARAM_INFO[k];
        return `<label class="adm-param ${params[k] != null ? 'changed' : ''}"><span>${info.label} ${infoTip(esc(info.hint))}</span>
          <input type="number" data-param="${k}" step="${info.step ?? 1}" placeholder="${state!.defaults[k]}" value="${params[k] ?? ''}"> <small>${info.unit} <span class="muted">Standard ${state!.defaults[k]}</span></small></label>`;
      })
      .join('');
    const dirty = JSON.stringify(params) !== JSON.stringify(p.params);
    return `<div class="adm-params">${rows}</div>
      <div class="adm-row adm-save"><button class="btn btn-primary" id="pa-save" ${dirty ? '' : 'disabled'}>${dirty ? 'Speichern und anwenden' : 'Gespeichert'}</button>
      ${Object.keys(p.params).length ? '<button class="btn btn-ghost" id="pa-default">Auf Standard</button>' : ''}</div>`;
  }

  // -------------------------------------------------------------- Formular „Änderung hinzufügen“

  function formHtml(): string {
    const kinds = `<div class="adm-kinds">${KINDS.map(([k, l]) => `<button type="button" data-kind="${k}" class="${form.kind === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const needsLine = ['extend', 'cut', 'time', 'removeLine', 'headway', 'addVariant'].includes(form.kind);
    const lineField = needsLine ? `<div class="field"><span>Linie</span>${pickerSlot('line', 'line', form.line)}</div>` : '';
    let body = '';
    const l = line();
    if (needsLine && !l) body = form.line ? '<p class="err">Diese Linie gibt es nicht.</p>' : '';
    else if (form.kind === 'extend') body = extendHtml();
    else if (form.kind === 'cut') body = cutHtml();
    else if (form.kind === 'time') body = timeHtml();
    else if (form.kind === 'removeLine') body = `<p>Die Linie <b>${esc(form.line)}</b> fährt in diesem Netzplan nicht mehr.</p>${addBtn('Linie entfernen')}`;
    else if (form.kind === 'headway') body = headwayHtml();
    else if (form.kind === 'addVariant') body = variantHtml();
    else if (form.kind === 'addLine') body = addLineHtml();
    else if (form.kind === 'addStation') body = addStationHtml();
    else body = stationEditHtml();
    return `${kinds}${lineField}${body}`;
  }

  const addBtn = (label = 'Hinzufügen und anwenden') => `<button type="button" class="btn btn-primary" id="ed-add">${label}</button>`;

  function extendHtml(): string {
    const p = mainPattern();
    const ends = [...new Set([p[0], p[p.length - 1]].filter(Boolean))];
    return `<div class="field"><span>Ab welcher Endstation geht es weiter?</span><div class="adm-choice">${ends
      .map((id) => `<button type="button" data-at="${esc(id)}" class="${form.at === id ? 'on' : ''}">${esc(stName(id))}</button>`)
      .join('')}</div></div>
      ${form.at ? `<div class="field"><span>Neue Halte ab ${esc(stName(form.at))} – der Reihe nach, Fahrzeit ab dem vorigen Halt</span>${stopsHtml(false)}</div>${addBtn()}` : ''}`;
  }

  function stopsHtml(first: boolean): string {
    return `${form.stops
      .map(
        (s, i) => `<div class="adm-stop">${pickerSlot('station', `stop:${i}`, s.station)}
          ${first && i === 0 ? '<small class="muted">Start</small>' : `<input type="number" min="0" max="60" data-stopmin="${i}" value="${s.min}"> min`}
          ${form.stops.length > 1 ? `<button type="button" class="icon-btn" data-rmstop="${i}" aria-label="Halt entfernen">✕</button>` : ''}</div>`,
      )
      .join('')}<button type="button" class="link" id="ed-addstop">+ weiterer Halt</button>`;
  }

  function cutHtml(): string {
    const p = mainPattern();
    if (p.length < 3) return '<p class="muted">Diese Linie ist zu kurz zum Kürzen.</p>';
    const first = p[0];
    const last = p[p.length - 1];
    // 1. welches Ende fällt weg  2. wo endet sie künftig – mit Vorschau
    const keep = form.end === 'start' ? p.slice(1) : form.end === 'end' ? p.slice(0, -1) : [];
    const gone = form.at && form.end ? (form.end === 'start' ? p.slice(0, p.indexOf(form.at)) : p.slice(p.indexOf(form.at) + 1)) : [];
    const rest = form.at && form.end ? (form.end === 'start' ? p.slice(p.indexOf(form.at)) : p.slice(0, p.indexOf(form.at) + 1)) : [];
    return `<p class="muted">Verlauf: ${p.map((id) => esc(stName(id))).join(' – ')}</p>
      <div class="field"><span>1. Welches Ende fällt weg?</span><div class="adm-choice">
        <button type="button" data-end="start" class="${form.end === 'start' ? 'on' : ''}">Anfang bei ${esc(stName(first))}</button>
        <button type="button" data-end="end" class="${form.end === 'end' ? 'on' : ''}">Ende bei ${esc(stName(last))}</button></div></div>
      ${
        form.end
          ? `<div class="field"><span>2. Wo ${form.end === 'start' ? 'beginnt' : 'endet'} die Linie künftig?</span><div class="adm-choice">${keep
              .slice(form.end === 'start' ? 0 : 1)
              .slice(0, form.end === 'start' ? -1 : undefined)
              .map((id) => `<button type="button" data-at="${esc(id)}" class="${form.at === id ? 'on' : ''}">${esc(stName(id))}</button>`)
              .join('')}</div></div>`
          : ''
      }
      ${form.at && form.end ? `<p class="adm-preview">Künftig: <b>${rest.map((id) => esc(stName(id))).join(' – ')}</b><br><small>Fällt weg: ${gone.map((id) => esc(stName(id))).join(', ')}</small></p>${addBtn()}` : ''}`;
  }

  function pairs(): [string, string][] {
    const l = line();
    if (!l || !net) return [];
    const seen = new Set<string>();
    const out: [string, string][] = [];
    for (const p of net.patterns(l))
      for (let i = 1; i < p.length; i++) {
        const k = [p[i - 1], p[i]].sort().join('|');
        if (!seen.has(k)) (seen.add(k), out.push([p[i - 1], p[i]]));
      }
    return out;
  }

  function timeHtml(): string {
    return `<label class="field"><span>Abschnitt</span><select data-f="pair"><option value="">wählen …</option>${pairs()
      .map(([a, b]) => `<option value="${a}|${b}" ${form.pair === `${a}|${b}` ? 'selected' : ''}>${esc(stName(a))} ↔ ${esc(stName(b))}</option>`)
      .join('')}</select></label>
      ${form.pair ? `<label class="field"><span>Fahrzeit ${form.current != null ? `<small class="muted">(bisher ${form.current} min)</small>` : ''}</span><input type="number" min="0" max="60" data-f="min" value="${form.min}"> min</label>${addBtn()}` : ''}`;
  }

  /** Takt ändern: Haltefolge (beide Richtungen), Tag, Zeitraum, alle X Minuten */
  function headwayHtml(): string {
    const keys = [...new Map(lineView?.patterns.map((p) => [p.key.split('>').sort().join('>'), p]) ?? []).values()];
    const cur = lineInfo(form.line);
    return `${cur?.every ? `<p class="muted">Bisher Mo–Fr tagsüber etwa alle ${cur.every} min.</p>` : ''}
      <label class="field"><span>Haltefolge</span><select data-f="pattern"><option value="">alle der Linie</option>${keys
        .map((p) => `<option value="${esc(p.key)}" ${form.pattern === p.key ? 'selected' : ''}>${esc(p.stops[0].name)} ↔ ${esc(p.stops[p.stops.length - 1].name)}</option>`)
        .join('')}</select></label>
      <div class="adm-grid3"><label class="field"><span>Tag</span><select data-f="day">${DAYS.map(([d, l]) => `<option value="${d}" ${form.day === d ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>von</span><input data-f="from" value="${form.from}" maxlength="5" placeholder="06:00"></label>
        <label class="field"><span>bis</span><input data-f="to" value="${form.to}" maxlength="5" placeholder="20:00"></label>
        <label class="field"><span>alle … Minuten</span><input type="number" min="2" max="120" data-f="every" value="${form.every}"></label></div>
      <p class="muted">Die Fahrten in diesem Zeitraum werden durch neue im gewählten Takt ersetzt – mit den üblichen Fahrzeiten der Linie.</p>${addBtn()}`;
  }

  /** zusätzliche Fahrten einer Linie auf eigener Haltefolge – z.B. jede 2. S1 nach Hütteldorf */
  function variantHtml(): string {
    return `<p class="muted">Eigene Haltefolge der ${esc(form.line)} mit eigenem Takt – z.B. „jede 2. S1 nach Hütteldorf“: hier die Halte bis Hütteldorf und alle 30 min, dazu bei „Takt ändern“ die bisherige S1 auf alle 30 min.</p>
      <div class="field"><span>Halte der Reihe nach (Fahrzeit ab dem vorigen Halt) – fährt in beide Richtungen</span>${stopsHtml(true)}</div>
      ${bandsHtml()}${addBtn('Fahrten hinzufügen')}`;
  }

  function bandsHtml(): string {
    const bands = (d: DayType) =>
      form.service[d]
        .map(
          (b, i) => `<div class="adm-band"><input type="text" class="adm-hhmm" data-band="${d}:${i}:from" value="${b.from}" maxlength="5"> bis <input type="text" class="adm-hhmm" data-band="${d}:${i}:to" value="${b.to}" maxlength="5"> alle
            <input type="number" min="2" max="120" data-band="${d}:${i}:every" value="${b.every}"> min <button type="button" class="icon-btn" data-rmband="${d}:${i}" aria-label="Zeitraum entfernen">✕</button></div>`,
        )
        .join('') || '<small class="muted">fährt nicht</small>';
    return `<div class="field"><span>Betriebszeiten und Takt</span>${DAYS.map(([d, l]) => `<div class="adm-day"><b>${l}</b>${bands(d)}<button type="button" class="link" data-addband="${d}">+ Zeitraum</button></div>`).join('')}
      <small class="muted">Nach Mitternacht als 24:30, 25:00 … eintragen.</small></div>`;
  }

  function addLineHtml(): string {
    return `<div class="adm-grid2">
        <label class="field"><span>Name</span><input data-f="line" value="${esc(form.line)}" maxlength="8" placeholder="z.B. U5"></label>
        <label class="field"><span>Verkehrsmittel</span><select data-f="mode">${(['U', 'S', 'T', 'B', 'N'] as Mode[]).map((m) => `<option value="${m}" ${form.mode === m ? 'selected' : ''}>${MODE_LABEL[m]}</option>`).join('')}</select></label>
        <label class="field"><span>Farbe</span><input type="color" data-f="color" value="${form.color}"></label></div>
      <div class="field"><span>Halte der Reihe nach (Fahrzeit ab dem vorigen Halt) – fährt in beide Richtungen</span>${stopsHtml(true)}</div>
      ${bandsHtml()}
      ${addBtn('Linie anlegen')}`;
  }

  function addStationHtml(): string {
    return `<div class="adm-grid2"><label class="field"><span>Name</span><input data-f="name" value="${esc(form.name)}" maxlength="60" placeholder="z.B. Neustadt"></label>
      <label class="field"><span>Bezirk</span><input type="number" min="1" max="23" data-f="district" value="${form.district || ''}" placeholder="1–23"></label></div>
      <div class="field"><span>Ort – auf die Karte klicken ${form.point ? `<small class="muted">(${form.point.lat.toFixed(5)}, ${form.point.lon.toFixed(5)})</small>` : ''}</span><div class="adm-map" id="ed-map"></div></div>
      <p class="muted">Danach mit „Neue Linie“ oder „Verlängern“ anbinden.</p>${addBtn('Station anlegen')}`;
  }

  function stationEditHtml(): string {
    const st = form.station ? net?.stations.get(form.station) : undefined;
    return `<div class="field"><span>Station</span>${pickerSlot('station', 'station', form.station)}</div>
      ${
        !st
          ? ''
          : form.kind === 'renameStation'
            ? `<label class="field"><span>Neuer Name</span><input data-f="name" value="${esc(form.name || st.name)}" maxlength="60"></label>${addBtn()}`
            : form.kind === 'moveStation'
              ? `<div class="field"><span>Neuer Ort – auf die Karte klicken</span><div class="adm-map" id="ed-map"></div></div>${addBtn()}`
              : `<p>An <b>${esc(st.name)}</b> hält dann keine Linie mehr (sie fahren durch, die Fahrzeiten bleiben). Linien: ${st.lines.map((id) => net!.lines.get(id)).filter(Boolean).map((l) => lineChip(l!.mode, l!.id, l!.color)).join(' ')}</p>${addBtn('Station auflassen')}`
      }`;
  }

  /** Formular → Änderung (oder Meldung, was fehlt) */
  function editFromForm(): LineEdit | string {
    const L = form.line;
    switch (form.kind) {
      case 'extend': {
        if (!form.at) return 'Endstation wählen.';
        if (form.stops.some((s) => !s.station)) return 'Für jeden neuen Halt eine Station wählen.';
        return { kind: 'extend', line: L, at: form.at, stops: form.stops.map((s) => ({ station: s.station, min: Math.max(0, Math.round(s.min)) })) };
      }
      case 'cut': {
        const p = mainPattern();
        if (!form.at || !form.end) return 'Ende und neue Endstation wählen.';
        return { kind: 'cut', line: L, at: form.at, beyond: form.end === 'start' ? p[0] : p[p.length - 1] };
      }
      case 'time': {
        if (!form.pair) return 'Abschnitt wählen.';
        const [from, to] = form.pair.split('|');
        return { kind: 'time', line: L, from, to, min: Math.max(0, Math.round(form.min)) };
      }
      case 'removeLine':
        return { kind: 'removeLine', line: L };
      case 'addLine': {
        if (!L.trim()) return 'Namen der Linie eingeben.';
        if (form.stops.length < 2 || form.stops.some((s) => !s.station)) return 'Mindestens zwei Halte wählen.';
        return { kind: 'addLine', line: L.trim(), mode: form.mode, color: form.color, stops: form.stops.map((s, i) => ({ station: s.station, min: i ? Math.max(0, Math.round(s.min)) : 0 })), service: form.service };
      }
      case 'addStation': {
        if (!form.name.trim()) return 'Namen eingeben.';
        if (!form.point) return 'Ort auf der Karte wählen.';
        return { kind: 'addStation', station: `n${Date.now()}`, name: form.name.trim(), lat: form.point.lat, lon: form.point.lon, district: form.district || 0 };
      }
      case 'renameStation':
        if (!form.station || !form.name.trim()) return 'Station und neuen Namen wählen.';
        return { kind: 'renameStation', station: form.station, name: form.name.trim() };
      case 'moveStation':
        if (!form.station || !form.point) return 'Station und neuen Ort wählen.';
        return { kind: 'moveStation', station: form.station, lat: form.point.lat, lon: form.point.lon };
      case 'removeStation':
        if (!form.station) return 'Station wählen.';
        return { kind: 'removeStation', station: form.station };
      case 'headway': {
        const t = /^([01]?\d|2[0-7]):[0-5]\d$/;
        if (!t.test(form.from) || !t.test(form.to)) return 'Uhrzeiten im Format HH:MM.';
        const pad = (x: string) => x.padStart(5, '0');
        return { kind: 'headway', line: L, day: form.day, from: pad(form.from), to: pad(form.to), every: Math.round(form.every), ...(form.pattern ? { pattern: form.pattern } : {}) };
      }
      case 'addVariant':
        if (form.stops.length < 2 || form.stops.some((x) => !x.station)) return 'Mindestens zwei Halte wählen.';
        return { kind: 'addVariant', line: L, stops: form.stops.map((x, i) => ({ station: x.station, min: i ? Math.max(0, Math.round(x.min)) : 0 })), service: form.service };
      // diese Änderungen entstehen direkt in der Fahrplan-Ansicht
      case 'insertStop':
      case 'skipStop':
      case 'departures':
        return 'Bitte direkt im Fahrplan der Linie ändern.';
    }
  }

  function resetForm(kind = form.kind) {
    Object.assign(form, { kind, line: '', at: '', end: '', beyond: '', pair: '', min: 3, current: null, station: '', name: '', district: 0, point: null, pattern: '', stops: [{ station: '', min: kind === 'addLine' || kind === 'addVariant' ? 0 : 3 }] });
  }

  // -------------------------------------------------------------- Fahrplan-Ansicht

  function probeHtml(routes: RouteOption[]): string {
    if (!routes.length) return '<p class="muted">Keine Verbindung gefunden.</p>';
    return `<ol class="route-list adm-probe-res">${routes
      .slice(0, 6)
      .map(
        (r, i) => `<li class="expandable ${i === 0 ? 'open' : ''}"><div class="rrow"><span class="rank">${i + 1}</span><div class="rmain"><div class="chainline">${chain(r.legs)}</div></div><div class="rtime"><b>${r.medianMin} min</b></div><span class="chev">▾</span></div>
          <div class="rdetail">${routeDetails(r)}</div></li>`,
      )
      .join('')}</ol>`;
  }

  // -------------------------------------------------------------- Aktionen

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message);
    }
    rerender();
  };

  function bind(root: HTMLElement) {
    const n = net!;
    // Auswahlfelder: Linie/Station gewählt
    mountPickers(root, n, (key, id) => {
      if (key === 'line') {
        Object.assign(form, { line: id, at: '', end: '', pair: '', current: null, pattern: '' });
        if (form.kind === 'headway')
          return void run(async () => {
            ttLine = id;
            await loadLineView(id);
          });
      } else if (key === 'station') {
        form.station = id;
        form.name = '';
        form.point = null;
      } else if (key.startsWith('stop:')) form.stops[Number(key.slice(5))].station = id;
      else if (key === 'ins') {
        if (insertAt) insertAt.station = id;
      } else if (key === 'from') probe.from = id;
      else if (key === 'to') probe.to = id;
      rerender();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach((b) =>
      b.addEventListener('click', () => {
        planId = b.dataset.plan!;
        net = null;
        lineView = null;
        lineViewFor = '';
        linesFor = '';
        ttLine = '';
        probe.routes = null;
        resetForm();
        rerender();
      }),
    );
    root.querySelector('#pl-new')?.addEventListener('click', () => ((newPlan = { label: '', copy: true }), rerender()));
    root.querySelector('#np-cancel')?.addEventListener('click', () => ((newPlan = null), rerender()));
    root.querySelector<HTMLInputElement>('#np-label')?.addEventListener('input', (e) => (newPlan!.label = (e.target as HTMLInputElement).value));
    root.querySelector<HTMLInputElement>('#np-copy')?.addEventListener('change', (e) => (newPlan!.copy = (e.target as HTMLInputElement).checked));
    root.querySelector('#np-ok')?.addEventListener('click', () =>
      run(async () => {
        const label = newPlan!.label.trim();
        if (!label) throw new Error('Bitte einen Namen eingeben.');
        let id = slug(label);
        while (state!.plans.some((p) => p.id === id) || id === 'regular') id = `${id.slice(0, 20)}-${Math.floor(Math.random() * 90 + 10)}`;
        const src = plan();
        await savePlan({ id, label, hint: '', inMenu: false, params: newPlan!.copy ? src.params : {}, edits: newPlan!.copy ? src.edits : [] }, `Netzplan „${label}“ angelegt`);
        newPlan = null;
        planId = id;
        paramsFor = '';
      }),
    );
    root.querySelector('#pm-save')?.addEventListener('click', () =>
      run(() =>
        savePlan(
          {
            id: planId,
            label: root.querySelector<HTMLInputElement>('#pm-label')!.value,
            hint: root.querySelector<HTMLInputElement>('#pm-hint')!.value,
            inMenu: root.querySelector<HTMLInputElement>('#pm-menu')!.checked,
          },
          'Gespeichert',
        ),
      ),
    );
    root.querySelector('#pm-del')?.addEventListener('click', () => {
      if (!confirm(`Netzplan „${plan().label}“ löschen? Lobbys, die ihn gewählt haben, spielen dann mit dem Standard-Netz.`)) return;
      void run(async () => {
        state = await adm<RoutingAdminState>('DELETE', `/api/admin/routing/plans/${encodeURIComponent(planId)}`);
        forgetPlanNet(planId);
        planId = 'regular';
        net = null;
        versions = null;
      });
    });
    // Stellschrauben
    root.querySelectorAll<HTMLInputElement>('[data-param]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const k = inp.dataset.param as keyof RoutingParams;
        if (inp.value === '' || Number(inp.value) === state!.defaults[k]) delete params[k];
        else params[k] = Number(inp.value);
        rerender();
      }),
    );
    root.querySelector('#pa-save')?.addEventListener('click', () => run(() => savePlan({ id: planId, params }, 'Gespeichert und angewendet')));
    root.querySelector('#pa-default')?.addEventListener('click', () => run(() => savePlan({ id: planId, params: {} }, 'Auf Standard')));
    root.querySelectorAll<HTMLButtonElement>('[data-rmedit]').forEach((b) =>
      b.addEventListener('click', () => {
        const edits = plan().edits.filter((_, i) => i !== Number(b.dataset.rmedit));
        void run(() => savePlan({ id: planId, edits }, 'Entfernt und angewendet'));
      }),
    );
    // Formular
    root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) =>
      b.addEventListener('click', () => {
        resetForm(b.dataset.kind as Kind);
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-at]').forEach((b) => b.addEventListener('click', () => ((form.at = b.dataset.at!), rerender())));
    root.querySelectorAll<HTMLButtonElement>('[data-end]').forEach((b) => b.addEventListener('click', () => ((form.end = b.dataset.end as 'start' | 'end'), (form.at = ''), rerender())));
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((el) =>
      el.addEventListener('change', async () => {
        const k = el.dataset.f!;
        if (k === 'pair') {
          form.pair = el.value;
          form.current = null;
          // bisherige Fahrzeit aus dem Fahrplan eintragen
          if (form.pair) {
            const [a, b] = form.pair.split('|');
            try {
              const v = await adm<TimetableLineView>('GET', `/api/admin/routing/timetable?plan=${encodeURIComponent(planId)}&line=${encodeURIComponent(form.line)}`);
              const mins = v.patterns.flatMap((p) => p.stops.map((s, i) => (i && ((p.stops[i - 1].station === a && s.station === b) || (p.stops[i - 1].station === b && s.station === a)) ? s.min : null))).filter((x): x is number => x != null);
              if (mins.length) form.current = form.min = mins[0];
            } catch {
              /* ohne Fahrplan: Feld bleibt */
            }
          }
          return rerender();
        }
        if (k === 'min' || k === 'district' || k === 'every') form[k] = Number(el.value);
        else if (k === 'day') form.day = el.value as DayType;
        else if (k === 'pattern' || k === 'from' || k === 'to') form[k] = el.value;
        else if (k === 'mode') form.mode = el.value as Mode;
        else if (k === 'line' || k === 'name' || k === 'color') form[k] = el.value;
        if (k !== 'name' && k !== 'line') rerender();
      }),
    );
    root.querySelectorAll<HTMLInputElement>('[data-stopmin]').forEach((el) => el.addEventListener('change', () => (form.stops[Number(el.dataset.stopmin)].min = Number(el.value))));
    root.querySelectorAll<HTMLButtonElement>('[data-rmstop]').forEach((b) => b.addEventListener('click', () => (form.stops.splice(Number(b.dataset.rmstop), 1), rerender())));
    root.querySelector('#ed-addstop')?.addEventListener('click', () => (form.stops.push({ station: '', min: 3 }), rerender()));
    root.querySelectorAll<HTMLInputElement>('[data-band]').forEach((el) =>
      el.addEventListener('change', () => {
        const [d, i, f] = el.dataset.band!.split(':') as [DayType, string, keyof ServiceBand];
        const b = form.service[d][Number(i)];
        if (f === 'every') b.every = Number(el.value);
        else b[f] = el.value;
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-rmband]').forEach((b) =>
      b.addEventListener('click', () => {
        const [d, i] = b.dataset.rmband!.split(':') as [DayType, string];
        form.service[d].splice(Number(i), 1);
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-addband]').forEach((b) =>
      b.addEventListener('click', () => (form.service[b.dataset.addband as DayType].push({ from: '06:00', to: '20:00', every: 10 }), rerender())),
    );
    const mapEl = root.querySelector<HTMLElement>('#ed-map');
    if (mapEl) {
      const st = form.station ? n.stations.get(form.station) : undefined;
      miniMap(mapEl, n, form.point ?? (st ? { lat: st.lat, lon: st.lon } : null), (p) => {
        form.point = p;
        // Bezirk der nächsten Station übernehmen
        if (form.kind === 'addStation' && !form.district) {
          const near = [...n.stations.values()].sort((a, b) => Math.hypot(a.lat - p.lat, a.lon - p.lon) - Math.hypot(b.lat - p.lat, b.lon - p.lon))[0];
          if (near) form.district = near.district;
        }
        const small = mapEl.previousElementSibling?.querySelector('small');
        if (small) small.textContent = `(${p.lat.toFixed(5)}, ${p.lon.toFixed(5)})`;
      });
    }
    // Bereiche, Fahrplan-Ansicht
    root.querySelectorAll<HTMLButtonElement>('[data-section]').forEach((b) => b.addEventListener('click', () => ((section = b.dataset.section as typeof section), rerender())));
    root.querySelector<HTMLInputElement>('#tt-built')?.addEventListener('change', (e) => {
      asBuilt = (e.target as HTMLInputElement).checked;
      rerender();
    });
    const filter = root.querySelector<HTMLInputElement>('#tt-filter');
    filter?.addEventListener('input', () => {
      lineFilter = filter.value;
      rerender();
      setTimeout(() => {
        const n = document.querySelector<HTMLInputElement>('#tt-filter');
        n?.focus();
        n?.setSelectionRange(n.value.length, n.value.length);
      }, 0);
    });
    root.querySelectorAll<HTMLButtonElement>('[data-ttline]').forEach((b) =>
      b.addEventListener('click', () =>
        run(async () => {
          ttLine = b.dataset.ttline!;
          await loadLineView(ttLine);
        }),
      ),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-ttday]').forEach((b) => b.addEventListener('click', () => ((ttDay = b.dataset.ttday as DayType), depDraft.clear(), rerender())));
    const reloadView = async () => {
      linesFor = '';
      lineViewFor = '';
    };
    root.querySelectorAll<HTMLButtonElement>('[data-skip]').forEach((b) =>
      b.addEventListener('click', () => {
        const station = b.dataset.skip!;
        if (!confirm(`${ttLine} soll in ${n.stations.get(station)?.name ?? station} nicht mehr halten?`)) return;
        void run(async () => {
          await addEdit({ kind: 'skipStop', line: ttLine, station });
          await reloadView();
        });
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-insert]').forEach((b) =>
      b.addEventListener('click', () => {
        const [a, c] = b.dataset.insert!.split('|');
        insertAt = { a, b: c, station: '', minA: 2, minB: 2 };
        rerender();
      }),
    );
    root.querySelectorAll<HTMLInputElement>('[data-ins]').forEach((el) => el.addEventListener('change', () => insertAt && (insertAt[el.dataset.ins as 'minA' | 'minB'] = Number(el.value))));
    root.querySelector('#ins-cancel')?.addEventListener('click', () => ((insertAt = null), rerender()));
    root.querySelector('#ins-ok')?.addEventListener('click', () => {
      const x = insertAt!;
      if (!x.station) return toast('Neuen Halt wählen.');
      void run(async () => {
        await addEdit({ kind: 'insertStop', line: ttLine, a: x.a, b: x.b, station: x.station, minA: Math.round(x.minA), minB: Math.round(x.minB) });
        insertAt = null;
        await reloadView();
      });
    });
    // Abfahrten: streichen/hinzufügen sammeln, dann eine Änderung je Richtung und Tag (mit früheren zusammengeführt)
    const draftOf = (key: string) => depDraft.get(key) ?? depDraft.set(key, { remove: new Set(), add: [] }).get(key)!;
    root.querySelectorAll<HTMLButtonElement>('[data-dep]').forEach((b) =>
      b.addEventListener('click', () => {
        const [key, t] = b.dataset.dep!.split('|');
        const d = draftOf(key);
        const m = Number(t);
        if (d.remove.has(m)) d.remove.delete(m);
        else d.remove.add(m);
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-depnew]').forEach((b) =>
      b.addEventListener('click', () => {
        const [key, t] = b.dataset.depnew!.split('|');
        const d = draftOf(key);
        d.add = d.add.filter((x) => x !== Number(t));
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-depaddbtn]').forEach((b) =>
      b.addEventListener('click', () => {
        const key = b.dataset.depaddbtn!;
        const inp = root.querySelector<HTMLInputElement>(`[data-depadd="${CSS.escape(key)}"]`)!;
        const m = /^(\d{1,2}):([0-5]\d)$/.exec(inp.value.trim());
        if (!m || Number(m[1]) > 27) return toast('Uhrzeit als HH:MM (nach Mitternacht 24:30 …).');
        const d = draftOf(key);
        d.add = [...new Set([...d.add, Number(m[1]) * 60 + Number(m[2])])].sort((x, y) => x - y);
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-depcancel]').forEach((b) => b.addEventListener('click', () => (depDraft.delete(b.dataset.depcancel!), rerender())));
    root.querySelectorAll<HTMLButtonElement>('[data-depsave]').forEach((b) =>
      b.addEventListener('click', () => {
        const key = b.dataset.depsave!;
        const d = depDraft.get(key)!;
        const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const old = plan().edits.find((e) => e.kind === 'departures' && e.line === ttLine && e.pattern === key && e.day === ttDay) as Extract<LineEdit, { kind: 'departures' }> | undefined;
        const add = new Set(old?.add ?? []);
        const remove = new Set(old?.remove ?? []);
        for (const m of d.remove) {
          const t = fmt(m);
          // eine früher hinzugefügte Abfahrt streichen = einfach nicht mehr hinzufügen
          if (add.has(t)) add.delete(t);
          else remove.add(t);
        }
        for (const m of d.add) add.add(fmt(m));
        const edits = plan().edits.filter((e) => e !== old);
        const next: LineEdit[] = add.size || remove.size ? [...edits, { kind: 'departures', line: ttLine, pattern: key, day: ttDay, add: [...add].sort(), remove: [...remove].sort() }] : edits;
        void run(async () => {
          await savePlan({ id: planId, edits: next }, 'Abfahrten gespeichert');
          depDraft.delete(key);
          await reloadView();
        });
      }),
    );
    // Takt je Haltefolge (beide Richtungen)
    root.querySelectorAll<HTMLInputElement>('[data-hw]').forEach((el) =>
      el.addEventListener('change', () => {
        const [key, f] = el.dataset.hw!.split('|');
        const cur = hwDraft.get(key) ?? { from: '06:00', to: '20:00', every: lineInfo(ttLine)?.every ?? 10 };
        if (f === 'every') cur.every = Number(el.value);
        else cur[f as 'from' | 'to'] = el.value.trim();
        hwDraft.set(key, cur);
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-hwsave]').forEach((b) =>
      b.addEventListener('click', () => {
        const key = b.dataset.hwsave!;
        const hw = hwDraft.get(key) ?? { from: '06:00', to: '20:00', every: lineInfo(ttLine)?.every ?? 10 };
        const t = /^([01]?\d|2[0-7]):[0-5]\d$/;
        if (!t.test(hw.from) || !t.test(hw.to)) return toast('Uhrzeiten im Format HH:MM.');
        void run(async () => {
          await addEdit({ kind: 'headway', line: ttLine, day: ttDay, from: hw.from.padStart(5, '0'), to: hw.to.padStart(5, '0'), every: Math.round(hw.every), pattern: key });
          await reloadView();
        });
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach((b) =>
      b.addEventListener('click', () => {
        resetForm(b.dataset.quick as Kind);
        form.line = ttLine;
        if (form.kind === 'addVariant') form.stops = [{ station: '', min: 0 }];
        section = 'aenderungen';
        rerender();
      }),
    );
    const nm = root.querySelector<HTMLElement>('#pl-netmap');
    if (nm) {
      const map = L.map(nm, { minZoom: 10, maxZoom: 17, zoomSnap: 0.25 });
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Esri, HERE, Garmin, © OpenStreetMap', maxZoom: 17 }).addTo(map);
      map.setView([48.2085, 16.3725], 11.5);
      setTimeout(() => {
        map.invalidateSize();
        new NetMapLayer(map, new NetGraph(n)).render(netView());
      }, 60);
    }
    root.querySelector('#ed-add')?.addEventListener('click', () => {
      const e = editFromForm();
      if (typeof e === 'string') return toast(e);
      void run(async () => {
        await addEdit(e);
        resetForm();
      });
    });
    // Fahrplan: Fahrzeit direkt ändern → „Fahrzeit“-Änderung (eine je Abschnitt, neuere ersetzt ältere)
    root.querySelectorAll<HTMLInputElement>('[data-tt]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const [from, to] = inp.dataset.tt!.split('|');
        const min = Math.max(0, Math.round(Number(inp.value)));
        const edits = plan().edits.filter((e) => !(e.kind === 'time' && e.line === ttLine && ((e.from === from && e.to === to) || (e.from === to && e.to === from))));
        void run(async () => {
          await savePlan({ id: planId, edits: [...edits, { kind: 'time', line: ttLine, from, to, min }] }, `${ttLine}: ${n.stations.get(from)?.name} ↔ ${n.stations.get(to)?.name} jetzt ${min} min`);
          linesFor = '';
          lineViewFor = '';
        });
      }),
    );
    // Probe
    root.querySelector<HTMLSelectElement>('#pr-slot')?.addEventListener('change', (e) => (probe.slot = (e.target as HTMLSelectElement).value as SlotId));
    root.querySelector('#pr-go')?.addEventListener('click', () => {
      if (!probe.from || !probe.to) return toast('Start und Ziel wählen.');
      probe.busy = true;
      rerender();
      void run(async () => {
        try {
          probe.routes = await adm<RouteOption[]>('POST', '/api/admin/routing/test', { plan: planId, from: probe.from, to: probe.to, slot: probe.slot });
        } finally {
          probe.busy = false;
        }
      });
    });
    const res = root.querySelector<HTMLElement>('.adm-probe-res');
    if (res) makeExpandable(res);
    // Versionen
    const vd = root.querySelector<HTMLDetailsElement>('details.adm-versions');
    vd?.addEventListener('toggle', () => {
      if (vd.open && !versions)
        void run(async () => {
          versions = await adm('GET', '/api/admin/routing/versions');
        });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm('Alle Netzpläne auf diesen Stand zurücksetzen?')) return;
        void run(async () => {
          state = await adm<RoutingAdminState>('POST', `/api/admin/routing/versions/${b.dataset.restore}/restore`);
          forgetPlanNet();
          net = null;
          versions = null;
          paramsFor = '';
          toast('Wiederhergestellt', 'info');
        });
      }),
    );
  }

  return { html, bind };
}
