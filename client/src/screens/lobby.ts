import type { FocusArea, GameSettings, GameState, Station, StationKind } from '../../../shared/types.ts';
import { inStationKinds } from '../../../shared/pools.ts';
import { NOT_REMEMBERED } from '../../../shared/defaults.ts';
import {
  DEFAULT_SETTINGS,
  DIFFICULTY_PRESETS,
  DISTANCES,
  FOCUS_RADII,
  BUS_LEVELS,
  RAIL_KINDS,
  STATION_KINDS,
  NET_MODES,
  RESTRICTION_FREQUENCIES,
  ROUTE_GOALS,
  transferPenalty,
  RESTRICTION_EXTRA_MAX_SEC,
  HARD_RESTRICTION_EXTRA_SEC,
  SLOT_DAYTYPE,
  TIME_BONUS_REF_SEC,
  TIME_LIMITS,
  TIME_SLOTS,
  TIPS,
  difficultyMultiplier,
  fmtDuration,
  maxRoundPoints,
} from '../../../shared/rules.ts';
import { api } from '../api.ts';
import { app, routeState, endSession, inviteLink, isHost, savePrefs, setMobileMap } from '../store.ts';
import { distM } from '../net.ts';
import { esc, toast } from '../ui.ts';
import type { Screen } from './screen.ts';

interface Opt {
  value: string;
  label: string;
  title?: string;
}

export function seg(key: string, opts: Opt[], current: string, disabled: boolean): string {
  return `<div class="seg seg-wide">${opts
    .map(
      (o) =>
        `<button data-k="${key}" data-v="${esc(o.value)}" class="${o.value === current ? 'on' : ''}" ${o.title ? `title="${esc(o.title)}"` : ''} ${disabled ? 'disabled' : ''}>${o.label}</button>`,
    )
    .join('')}</div>`;
}

/** Haltestellen: Schiene frei kombinierbar, Bus als Stufe */
export function stationPicker(current: StationKind[], disabled: boolean): string {
  const busLevel = BUS_LEVELS.find((b) => current.includes(b.id))?.id ?? 'none';
  const dis = disabled ? 'disabled' : '';
  return `<div class="station-picker">
    <div class="sp-row"><small>Schiene</small><div class="pool-steps">${RAIL_KINDS.map(
      (k) =>
        `<button data-k="rail" data-v="${k.id}" class="${current.includes(k.id) ? 'on' : ''}" title="${esc(k.hint)}" aria-pressed="${current.includes(k.id)}" ${dis}><span>${k.icon}</span><small>${esc(k.label)}</small></button>`,
    ).join('')}</div></div>
    <div class="sp-row"><small>Bus</small>${seg(
      'bus',
      [{ value: 'none', label: 'Kein Bus' }, ...BUS_LEVELS.map((b) => ({ value: b.id, label: `${b.icon} ${b.short}`, title: b.hint }))],
      busLevel,
      disabled,
    )}</div>
  </div>`;
}

/** "U-Bahn, S-Bahn, Bim · 490 Haltestellen" */
function stationsText(kinds: StationKind[]): string {
  const n = app.net.data.stations.filter((x) => inPool(x, kinds)).length;
  return `${STATION_KINDS.filter((k) => kinds.includes(k.id)).map((k) => k.label).join(', ')} · ${n} Haltestellen`;
}

export function toggle(key: string, label: string, hint: string, on: boolean, disabled: boolean): string {
  return `<label class="toggle ${disabled ? 'is-disabled' : ''}">
    <input type="checkbox" data-k="${key}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
    <span class="switch"></span><span class="tl"><b>${label}</b><small>${hint}</small></span></label>`;
}

function regularHint(s: GameSettings): string {
  if (s.network === 'current') return 'Nächster echter Tag – mit allen aktuellen Sperren und Ersatzverkehren.';
  const day = app.net.data.regularDays[SLOT_DAYTYPE[s.slot]];
  const d = new Date(`${day.date}T00:00:00Z`);
  const txt = d.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  return `Referenztag ${txt} – ${esc(day.note)}.`;
}

/** Wie am Server: Stationen, die für den Haltestellen-Regler in Frage kommen */
function inPool(st: Station, kinds: StationKind[]): boolean {
  return inStationKinds(st, kinds, (id) => app.net.lines.get(id));
}

/** Mittelpunkt eines Bezirks = Schwerpunkt seiner Haltestellen */
function districtCenter(id: number): [number, number] {
  const sts = app.net.data.stations.filter((x) => x.district === id);
  return [sts.reduce((a, x) => a + x.lat, 0) / sts.length, sts.reduce((a, x) => a + x.lon, 0) / sts.length];
}

const fmtKm = (m: number) => `${(m / 1000).toLocaleString('de-AT')} km`;

/** Was in den erweiterten Einstellungen vom Standard abweicht */
function advancedSummary(st: GameSettings): string {
  const d = DEFAULT_SETTINGS;
  const parts: string[] = [];
  if (st.network !== d.network) parts.push('aktuelles Netz');
  if (st.difficulty === 'custom') parts.push('eigene Schwierigkeit');
  if (st.goal !== d.goal) parts.push(st.goal === 'best' ? 'beste Route' : 'schnellste Route');
  if (st.avgWait !== d.avgWait) parts.push(st.avgWait ? 'Ø-Wartezeiten' : 'Fahrplan-Wartezeiten');
  if (st.countWait !== d.countWait) parts.push(st.countWait ? 'mit Wartezeit' : 'ohne Wartezeit');
  if (st.slot !== d.slot) parts.push(TIME_SLOTS.find((t) => t.id === st.slot)!.short);
  if (st.restrictions !== d.restrictions) parts.push(`Einschränkungen: ${RESTRICTION_FREQUENCIES.find((r) => r.id === st.restrictions)!.label.toLowerCase()}`);
  if (st.tips !== d.tips) parts.push(st.tips ? 'mit Tipps' : 'ohne Tipps');
  if (st.focus) parts.push(`Fokus ${fmtKm(st.focus.radiusM)}`);
  return parts.length ? parts.join(' · ') : 'Standard';
}

export function lobbyScreen(panel: HTMLElement): Screen {
  app.map.clear();
  app.map.overview();
  let pending = false;
  let tapEnabled: boolean | null = null;
  let advancedOpen = false;

  const send = async (patch: Partial<GameSettings>) => {
    if (pending) return;
    pending = true;
    try {
      const st = (await api.settings(app.session!, patch)) as GameState;
      // Netz und Fokus-Kreis nicht für die nächste Lobby merken – die starten immer mit dem Standard
      const keep: Partial<GameSettings> = { ...st.settings };
      for (const k of NOT_REMEMBERED) delete keep[k];
      app.prefs.settings = keep;
      savePrefs();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      pending = false;
    }
  };

  /** Fokus ändern; fehlende Werte vom aktuellen Fokus bzw. Standard (Stephansplatz, 2,5 km, 50 %) */
  function sendFocus(patch: Partial<FocusArea>) {
    const cur = routeState().settings.focus ?? { lat: 48.2085, lon: 16.3731, radiusM: 2500, share: 0.5 };
    send({ focus: { ...cur, ...patch } });
  }

  function render() {
    const s = routeState();
    const host = isHost();
    const ro = !host;
    const st = s.settings;
    const code = s.id;
    const scroll = panel.scrollTop;
    const players = s.players
      .map(
        (p) => `<li class="${p.connected ? '' : 'offline'}"><span class="dot"></span>${esc(p.name)}${p.id === app.session?.playerId ? ' <small>(du)</small>' : ''}${p.isHost ? ' <span title="Host">👑</span>' : ''}</li>`,
      )
      .join('');
    const mult = difficultyMultiplier(st);
    const focus = st.focus;
    const inCircle = focus
      ? app.net.data.stations.filter((x) => inPool(x, st.stations) && distM(x, focus) <= focus.radiusM).length
      : 0;
    app.map.showAreas(app.net.data.districts, focus);
    setMobileMap(!!focus);
    const canTap = host && !!focus;
    if (tapEnabled !== canTap) {
      tapEnabled = canTap;
      // Host tippt auf die Karte: Fokus-Mittelpunkt verschieben
      app.map.onTap(canTap ? (ll) => sendFocus({ lat: ll[0], lon: ll[1] }) : null);
    }

    panel.innerHTML = `
      <div class="lobby">
        <div class="lobby-code">
          <div><small>Lobby-Code</small><div class="code">${code}</div></div>
          <button class="btn btn-ghost" id="copy">🔗 Link kopieren</button>
        </div>
        <h3>Spieler <small>(${s.players.length})</small></h3>
        <ul class="players">${players}</ul>

        <h3>Einstellungen ${ro ? '<small>– nur der Host kann sie ändern</small>' : ''}</h3>
        <div class="setting"><span>Schwierigkeit</span>
          ${seg('difficulty', [...DIFFICULTY_PRESETS.map((d) => ({ value: d.id, label: d.label })), ...(st.difficulty === 'custom' ? [{ value: 'custom', label: 'Eigene' }] : [])], st.difficulty, ro)}
          <small class="hint">${esc(stationsText(st.stations))}${st.distance !== 'medium' ? ` · ${DISTANCES.find((d) => d.id === st.distance)!.label}` : ''}${st.needTransfer ? ' · immer mit Umstieg' : ''} · <b>Punkte ×${mult.toLocaleString('de-AT')}</b></small></div>
        <div class="setting"><span>Runden</span>${seg('rounds', [3, 5, 7, 10].map((n) => ({ value: String(n), label: String(n) })), String(st.rounds), ro)}</div>

        <div class="setting">
          <div class="tabs">
            <button data-k="limitOn" data-v="1" class="${st.roundTimeLimitSec ? 'on' : ''}" ${ro ? 'disabled' : ''}>⏱ Mit Zeitlimit</button>
            <button data-k="limitOn" data-v="0" class="${st.roundTimeLimitSec ? '' : 'on'}" ${ro ? 'disabled' : ''}>Ohne Zeitlimit</button>
          </div>
          <div class="tab-body">${
            st.roundTimeLimitSec
              ? `${seg('limit', TIME_LIMITS.map((t) => ({ value: String(t), label: fmtDuration(t) })), String(st.roundTimeLimitSec), ro)}
                 <small class="hint">pro Runde, inkl. „Wo liegt das?“. Wer schnell ist, bekommt bis zu +10 % Zeitbonus.</small>`
              : `<small class="hint">Kein Zeitdruck. Zeitbonus gibt es trotzdem – gemessen an ${fmtDuration(TIME_BONUS_REF_SEC)}.</small>`
          }</div>
        </div>

        <div class="toggles main-toggles">
          ${toggle('locate', 'Wo liegt das?', 'Vor jeder Runde Start und Ziel auf der leeren Karte tippen (bis +150)', st.locate, ro)}
        </div>

        <details class="advanced" ${advancedOpen ? 'open' : ''}>
          <summary>⚙️ Erweiterte Einstellungen <small>${esc(advancedSummary(st))}</small></summary>

          <div class="setting"><span>Uhrzeit</span>${seg('slot', TIME_SLOTS.map((t) => ({ value: t.id, label: t.short, title: t.label })), st.slot, ro)}</div>

          <div class="setting"><span>Wertung</span>
            <div class="tabs">${ROUTE_GOALS.map((g) => `<button data-k="goal" data-v="${g.id}" class="${st.goal === g.id ? 'on' : ''}" ${ro ? 'disabled' : ''}>${g.label}</button>`).join('')}</div>
            <small class="hint">${esc(ROUTE_GOALS.find((g) => g.id === st.goal)!.hint)}${
              st.goal === 'best'
                ? ` (+${transferPenalty(st)} min${st.avgWait ? ' – die Wartezeit ist über die Ø-Wartezeiten schon drin' : ''}). Beispiel: 30 min mit 2 Umstiegen = ${30 + 2 * transferPenalty(st)} min, ${30 + 2 * transferPenalty(st) - 1} min direkt gewinnt knapp.`
                : '.'
            }</small></div>

          <div class="setting"><span>Netz</span>${seg('network', NET_MODES.map((n) => ({ value: n.id, label: n.label, title: n.hint })), st.network, ro)}
            <small class="hint">${regularHint(st)}</small></div>

          <div class="setting"><span>Schwierigkeit fein einstellen</span>
            <div class="sliders">
              <div class="slider-row pool-row"><span>Haltestellen</span>${stationPicker(st.stations, ro)}</div>
              <small class="hint">${esc(stationsText(st.stations))}</small>
              <div class="slider-row"><span>Entfernung</span>${seg('distance', DISTANCES.map((d) => ({ value: d.id, label: d.label })), st.distance, ro)}</div>
              ${toggle('needTransfer', 'Immer mit Umstieg', 'Nur Strecken, bei denen die schnellste Verbindung einen Umstieg hat', st.needTransfer, ro)}
            </div></div>

          <div class="setting"><span>Spielregeln</span>
            <div class="toggles">
              ${toggle('countWait', 'Wartezeit mitzählen', 'Gezählt wird ab der Abfragezeit – seltene Linien kosten Wartezeit', st.countWait, ro)}
              ${toggle(
                'avgWait',
                'Ø-Wartezeiten statt Fahrplan-Glück',
                'Jeder Umstieg kostet Umsteigeweg + halben Takt der nächsten Linie (S-Bahn alle 15 min → Ø 7,5 min, U-Bahn alle 4 min → Ø 2 min). Ein zufällig perfekter Anschluss bringt keinen Vorteil. Aus = echte Abfahrten zu 6 Zeitpunkten.',
                st.avgWait,
                ro,
              )}
              ${toggle('tips', 'Tipps erlaubt', `${Object.values(TIPS).map((t) => `${t.label} −${Math.round(t.share * 100)} %`).join(' · ')}. Mehrere Tipps werden miteinander verrechnet – mindestens 10 % bleiben.`, st.tips, ro)}
            </div></div>

          <div class="setting"><span>Einschränkungs-Runden</span>
            ${seg('restrictions', RESTRICTION_FREQUENCIES.map((r) => ({ value: r.id, label: r.label })), st.restrictions, ro)}
            <small class="hint">Ohne U-Bahn, ohne Bus, max. 1 Umstieg oder eine gesperrte Linie der schnellsten Verbindung. ${
              st.restrictions === 'sometimes' ? 'Etwa jede 3. Runde, mindestens eine pro Spiel. ' : ''
            }${st.roundTimeLimitSec ? `Diese Runden haben doppelte Zeit (max. +${fmtDuration(RESTRICTION_EXTRA_MAX_SEC)}), ohne U-Bahn +${fmtDuration(HARD_RESTRICTION_EXTRA_SEC)}.` : ''}</small></div>

          <div class="setting"><span>Fokus-Gebiet</span>
            ${toggle('focusOn', focus ? 'Kreis um den Punkt auf der Karte' : 'Aus – ganz Wien gleichmäßig', focus ? `${inCircle} passende Haltestellen im Kreis` : 'z.B. für jemanden, der sich in einem Grätzl besonders gut auskennt', !!focus, ro)}
            ${
              focus
                ? `<div class="focus-opts">
                    <small class="hint">${host ? '👆 Tippe auf die Karte, um den Mittelpunkt zu verschieben, oder wähle einen Bezirk:' : ''}</small>
                    ${host ? `<select id="district"><option value="">Bezirk als Mittelpunkt …</option>${app.net.data.districts.map((d) => `<option value="${d.id}">${d.id}. ${esc(d.name)}</option>`).join('')}</select>` : ''}
                    <div class="slider-row"><span>Radius</span>${seg('radius', FOCUS_RADII.map((r) => ({ value: String(r), label: fmtKm(r) })), String(focus.radiusM), ro)}</div>
                    <label class="slider-row"><span>Anteil</span>
                      <input type="range" min="10" max="90" step="10" value="${Math.round(focus.share * 100)}" data-k="share" ${ro ? 'disabled' : ''}>
                      <b>${Math.round(focus.share * 100)} %</b></label>
                    <small class="hint">So viele Start- und Zielstationen kommen im Schnitt aus dem Kreis – der Rest aus ganz Wien.</small>
                  </div>`
                : ''
            }
          </div>
          ${host ? '<button class="btn btn-ghost reset-settings" id="resetAll">↺ Alle Einstellungen zurücksetzen</button>' : ''}
        </details>

        <p class="maxpts">Max. <b>${maxRoundPoints(st).toLocaleString('de-AT')}</b> Punkte pro Runde</p>
        ${
          host
            ? `<button class="btn btn-primary btn-big" id="start">${s.players.length > 1 ? `Spiel starten (${s.players.length} Spieler)` : 'Spiel starten'}</button>`
            : `<div class="waiting-host">Warte, bis ${esc(s.players.find((p) => p.isHost)?.name ?? 'der Host')} startet …</div>`
        }
        <button class="link leave" id="leave">Lobby verlassen</button>
      </div>`;
    panel.scrollTop = scroll;

    panel.querySelector<HTMLDetailsElement>('details.advanced')!.addEventListener('toggle', (e) => {
      advancedOpen = (e.target as HTMLDetailsElement).open;
    });
    panel.querySelector('#copy')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteLink(code));
        toast('Einladungslink kopiert', 'info');
      } catch {
        toast(`Code: ${code}`, 'info');
      }
    });
    panel.querySelectorAll<HTMLButtonElement>('button[data-k]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.k!;
        const v = b.dataset.v!;
        if (k === 'rounds') send({ rounds: Number(v) });
        else if (k === 'rail' || k === 'bus') {
          const cur = routeState().settings.stations;
          const rail = cur.filter((x) => RAIL_KINDS.some((r) => r.id === x));
          const bus = cur.filter((x) => BUS_LEVELS.some((b) => b.id === x));
          const next =
            k === 'rail'
              ? [...(rail.includes(v as StationKind) ? rail.filter((x) => x !== v) : [...rail, v as StationKind]), ...bus]
              : [...rail, ...(v === 'none' ? [] : [v as StationKind])];
          if (!next.length) return toast('Mindestens eine Art von Haltestellen muss gewählt sein.', 'info');
          send({ stations: next });
        }
        else if (k === 'radius') sendFocus({ radiusM: Number(v) });
        else if (k === 'limit') send({ roundTimeLimitSec: Number(v) });
        else if (k === 'limitOn') send({ roundTimeLimitSec: v === '1' ? app.prefs.settings.roundTimeLimitSec || DEFAULT_SETTINGS.roundTimeLimitSec : null });
        else send({ [k]: v } as Partial<GameSettings>);
      }),
    );
    panel.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-k]').forEach((c) =>
      c.addEventListener('change', () => {
        if (c.dataset.k === 'focusOn') return c.checked ? sendFocus({}) : send({ focus: null });
        send({ [c.dataset.k!]: c.checked } as Partial<GameSettings>);
      }),
    );
    const shareRange = panel.querySelector<HTMLInputElement>('input[type=range][data-k=share]');
    shareRange?.addEventListener('input', () => (shareRange.nextElementSibling!.textContent = `${shareRange.value} %`));
    shareRange?.addEventListener('change', () => sendFocus({ share: Number(shareRange.value) / 100 }));
    panel.querySelector<HTMLSelectElement>('#district')?.addEventListener('change', (e) => {
      const id = Number((e.target as HTMLSelectElement).value);
      if (!id) return;
      const [lat, lon] = districtCenter(id);
      sendFocus({ lat, lon });
    });
    panel.querySelector('#resetAll')?.addEventListener('click', () => {
      if (!confirm('Alle Einstellungen dieser Lobby auf den Standard zurücksetzen?')) return;
      send({ ...DEFAULT_SETTINGS, focus: null });
    });
    panel.querySelector('#start')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Runde 1 wird vorbereitet …';
      try {
        await api.start(app.session!);
      } catch (err) {
        toast((err as Error).message);
        btn.disabled = false;
      }
    });
    panel.querySelector('#leave')!.addEventListener('click', async () => {
      try {
        await api.leave(app.session!);
      } catch {
        /* egal */
      }
      endSession();
    });
  }

  render();
  return {
    update: render,
    destroy: () => app.map.onTap(null),
  };
}

