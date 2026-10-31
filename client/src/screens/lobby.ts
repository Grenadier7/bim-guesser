import type { FocusArea, GameSettings, GameState, Station, StationKind, TipKind } from '../../../shared/types.ts';
import { icon } from '../icons.ts';
import { inStationKinds } from '../../../shared/pools.ts';
import { NOT_REMEMBERED } from '../../../shared/defaults.ts';
import {
  DEFAULT_SETTINGS,
  DIFFICULTY_PRESETS,
  DISTANCES,
  FOCUS_RADII,
  STATION_GROUPS,
  groupLevel,
  STATION_KINDS,
  NET_MODES,
  RESTRICTION_FREQUENCIES,
  SCORING_MODES,
  scoringModeOf,
  TIP_LEVELS,
  tipShare,
  XTREME_LEVELS,
  xtremeBlocksLocate,
  transferPenalty,
  RESTRICTION_EXTRA_MAX_SEC,
  HARD_RESTRICTION_EXTRA_SEC,
  SLOT_DAYTYPE,
  slotOr,
  TIME_BONUS_REF_SEC,
  TIME_LIMITS,
  TIME_SLOTS,
  TIPS,
  difficultyMultiplier,
  fmtDuration,
  maxRoundPoints,
  maxRoundPointsWithBonus,
  ADDRESS_FACTOR,
} from '../../../shared/rules.ts';
import { api } from '../api.ts';
import { app, routeState, endSession, inviteLink, isHost, savePrefs, setMobileMap } from '../store.ts';
import { distM } from '../net.ts';
import { accountTag, esc, toast } from '../ui.ts';
import { inviteButton } from '../accountui.ts';
import { deferWhileEditing, infoTip, patchQueue, seg, toggleInfo } from '../widgets.ts';
import { bindKick, kickButton } from './host.ts';
import type { Screen } from './screen.ts';
import { openSettingsDialog } from '../settingsShare.ts';

/**
 * Haltestellen je Verkehrsmittel: Kästchen an/aus (an = alle, aus = keine) und darunter ein
 * kleiner senkrechter Regler für die Stufe (oben = alle, unten = aus).
 */
function stationPicker(current: StationKind[], disabled: boolean): string {
  const dis = disabled ? 'disabled' : '';
  return `<div class="station-cols">${STATION_GROUPS.map((g) => {
    const lvl = groupLevel(current, g.id);
    const on = lvl !== null;
    const ticks = [...g.levels].reverse().map((l) => ({ id: l.id as string, short: l.short, hint: l.hint }));
    ticks.push({ id: '0', short: 'Aus', hint: 'keine Stationen' });
    return `<div class="sc-col ${on ? 'on' : ''}">
      <button class="sc-box" data-k="grp" data-v="${g.id}" aria-pressed="${on}" ${dis}><span>${g.icon}</span><small>${esc(g.label)}</small></button>
      <div class="vslider">${ticks
        .map(
          (t) =>
            `<button class="vtick ${(t.id === '0' ? !on : t.id === lvl) ? 'cur' : ''}" data-k="lvl" data-v="${g.id}:${t.id}" title="${esc(t.hint)}" ${dis}><i></i><span>${esc(t.short)}</span></button>`,
        )
        .join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

const poolCount = (kinds: StationKind[]) => app.net.data.stations.filter((x) => inPool(x, kinds)).length;

/** "U-Bahn, S-Bahn, Bim · 490 Haltestellen" */
function stationsText(kinds: StationKind[]): string {
  const n = app.net.data.stations.filter((x) => inPool(x, kinds)).length;
  return `${STATION_KINDS.filter((k) => kinds.includes(k.id)).map((k) => k.label).join(', ')} · ${n} Haltestellen`;
}

/** Erklärung zu „Was zählt?“ */
const scoringInfo = () =>
  SCORING_MODES.filter((m) => m.enabled !== false)
    .map((m) => `<b>${m.icon} ${esc(m.label)}:</b> ${esc(m.hint)}`)
    .join('<br><br>');

type AdvTab = 'diff' | 'rules' | 'world';
const ADV_TABS: { id: AdvTab; label: string }[] = [
  { id: 'diff', label: `${icon('target', 16)} Schwierigkeit` },
  { id: 'rules', label: `${icon('ruler', 16)} Regeln` },
  { id: 'world', label: `${icon('clock', 16)} Zeit & Netz` },
];

function regularHint(s: GameSettings): string {
  if (s.network !== 'regular') return esc(NET_MODES.find((n) => n.id === s.network)?.hint ?? '');
  const day = app.net.data.regularDays[SLOT_DAYTYPE[slotOr(s.slot)]];
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


export function lobbyScreen(panel: HTMLElement): Screen {
  app.map.clear();
  app.map.overview();
  let tapEnabled: boolean | null = null;
  let advancedOpen = false;
  let advTab: AdvTab = 'diff';

  const send = patchQueue(async (patch: Partial<GameSettings>) => {
    try {
      const st = (await api.settings(app.session!, patch)) as GameState;
      // Netz und Fokus-Kreis nicht für die nächste Lobby merken – die starten immer mit dem Standard
      const keep: Partial<GameSettings> = { ...st.settings };
      for (const k of NOT_REMEMBERED) delete keep[k];
      app.prefs.settings = keep;
      savePrefs();
    } catch (e) {
      toast((e as Error).message);
    }
  });

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
        (p) => `<li class="${p.connected ? '' : 'offline'}"><span class="dot"></span>${esc(p.name)}${accountTag(p)}${p.id === app.session?.playerId ? ' <small>(du)</small>' : ''}${p.isHost ? ` <span class="host-crown" title="Host">${icon('crown', 14)}</span>` : ''}${kickButton(p)}</li>`,
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

    /** X-treme-Kachel (im Reiter "Regeln") */
    function xtremeTile(): string {
      return `<div class="xtreme-tile ${st.xtreme !== 'off' ? 'on' : ''}">
            <div class="xt-head">⚡ X-TREME ${infoTip(XTREME_LEVELS.map((x) => `<b>${esc(x.label)}:</b> ${esc(x.hint)}`).join('<br>') + '<br><b>Immer doppelte Zeit.</b> Bei „Ohne Namen“ und „Ohne Karte“ ist „Wo liegt das?“ aus.')}</div>
            ${seg('xtreme', XTREME_LEVELS.map((x) => ({ value: x.id, label: x.label })), st.xtreme, ro)}
            ${st.xtreme !== 'off' ? `<small>${esc(XTREME_LEVELS.find((x) => x.id === st.xtreme)!.hint)} Doppelte Zeit.</small>` : ''}
          </div>`;
    }

    /** Inhalt des gewählten Reiters in "Erweitert" */
    function advancedTab(): string {
      if (advTab === 'world')
        return `
          <div class="setting"><span>Uhrzeit</span>${seg('slot', TIME_SLOTS.map((t) => ({ value: t.id, label: t.short, title: t.label })), st.slot, ro)}</div>
          <div class="setting"><span>Netz ${infoTip(
            NET_MODES.map((n) => `<b>${esc(n.label)}:</b> ${n.id === 'regular' ? `${esc(n.hint)} ${regularHint({ ...st, network: 'regular' })}` : esc(n.hint)}`).join('<br>'),
          )}</span>${seg('network', NET_MODES.map((n) => ({ value: n.id, label: esc(n.label), title: n.hint })), st.network, ro)}</div>
          <div class="toggles">
            ${toggleInfo(
              'focusOn',
              'Fokus-Gebiet',
              'Ein Kreis auf der Karte, aus dem Start und Ziel bevorzugt kommen – z.B. für jemanden, der sich in einem Grätzl besonders gut auskennt. „Anteil“ = so viele Stationen kommen im Schnitt aus dem Kreis, der Rest aus ganz Wien.',
              !!focus,
              ro,
              focus && st.endpoints !== 'addresses' ? `${inCircle} passende Haltestellen im Kreis` : '',
            )}
          </div>
          ${
            focus
              ? `<div class="focus-opts">
                  ${host ? `<small class="hint">👆 Karte antippen oder Bezirk wählen:</small><select id="district"><option value="">Bezirk als Mittelpunkt …</option>${app.net.data.districts.map((d) => `<option value="${d.id}">${d.id}. ${esc(d.name)}</option>`).join('')}</select>` : ''}
                  <div class="slider-row"><span>Radius</span>${seg('radius', FOCUS_RADII.map((r) => ({ value: String(r), label: fmtKm(r) })), String(focus.radiusM), ro)}</div>
                  <label class="slider-row"><span>Anteil</span>
                    <input type="range" min="10" max="90" step="10" value="${Math.round(focus.share * 100)}" data-k="share" ${ro ? 'disabled' : ''}>
                    <b>${Math.round(focus.share * 100)} %</b></label>
                </div>`
              : ''
          }`;
      if (advTab === 'rules') {
        const mode = scoringModeOf(st);
        const penalty = transferPenalty({ ...st, goal: 'best' });
        return `
          <div class="setting"><span>${icon('scale', 15)} Was zählt? ${infoTip(scoringInfo())}</span>${seg(
            'scoring',
            SCORING_MODES.filter((m) => m.enabled !== false).map((m) => ({ value: m.id, label: `${m.icon} ${esc(m.label)}`, title: m.hint })),
            mode ?? '',
            ro,
          )}
            ${mode ? '' : '<small class="hint">Eigene Kombination (alter Link) – einen Modus antippen.</small>'}</div>
          ${
            mode === 'realistic'
              ? `<div class="toggles">${toggleInfo(
                  'avoidTransfers',
                  'Umstiege vermeiden',
                  `Jeder Umstieg zählt zusätzlich ${penalty} min – für alle, die lieber direkt fahren, auch wenn es etwas länger dauert. Beispiel: 30 min mit 2 Umstiegen zählen als ${30 + 2 * penalty} min – eine direkte Verbindung mit ${30 + 2 * penalty - 1} min gewinnt.<br>Aus = nur die Zeit zählt (Umsteigeweg und Wartezeit sind sowieso schon drin).`,
                  st.goal === 'best',
                  ro,
                  st.goal === 'best' ? `+${penalty} min je Umstieg` : '',
                )}</div>`
              : ''
          }
          <div class="setting"><span>${icon('bulb', 15)} Tipps ${infoTip(
            `Ein Tipp kostet einen Anteil der Routenpunkte:<br>${(Object.keys(TIPS) as TipKind[])
              .map((k) => `${esc(TIPS[k].label)}: günstig −${Math.round(tipShare(k, 'cheap') * 100)} % · teuer −${Math.round(tipShare(k, 'expensive') * 100)} %`)
              .join('<br>')}<br>Mehrere Tipps werden miteinander verrechnet – mindestens 10 % der Punkte bleiben.<br>Bei X-treme sind Tipps immer teuer.`,
          )}</span>
            <div class="seg seg-wide">${TIP_LEVELS.map(
              (t) =>
                `<button data-k="tips" data-v="${t.id}" class="${st.tips === t.id ? 'on' : ''}" ${ro || (t.id === 'cheap' && st.xtreme !== 'off') ? 'disabled' : ''}>${t.label}</button>`,
            ).join('')}</div>
            ${st.xtreme !== 'off' && st.tips !== 'off' ? '<small class="hint xtreme-hint">⚡ X-treme: Tipps sind teuer.</small>' : ''}</div>
          <div class="setting"><span>${icon('trophy', 15)} Challenges ${infoTip(
            `Runden mit Zusatz-Aufgabe: ohne U-Bahn, ohne Bus, max. 1 Umstieg oder eine gesperrte Linie der schnellsten Verbindung.<br><b>Manchmal:</b> etwa jede 3. Runde, mindestens eine pro Spiel.<br>Challenge-Runden haben doppelte Zeit (max. +${fmtDuration(RESTRICTION_EXTRA_MAX_SEC)}), ohne U-Bahn +${fmtDuration(HARD_RESTRICTION_EXTRA_SEC)}.`,
          )}</span>${seg('restrictions', RESTRICTION_FREQUENCIES.map((r) => ({ value: r.id, label: r.label })), st.restrictions, ro)}</div>
          ${xtremeTile()}`;
      }
      const addr = st.endpoints === 'addresses';
      return `
          <div class="setting"><span>${icon('pin', 15)} Start & Ziel ${infoTip(
            `<b>Haltestellen:</b> Start und Ziel sind Stationen.<br><b>Adressen:</b> ${(app.net.data.addressCount ?? 0).toLocaleString('de-AT')} echte Adressen (Stadt Wien), gleichmäßig über die Stadt verteilt – erst zu Fuß zur passenden Haltestelle. Punkte ×${ADDRESS_FACTOR.toLocaleString('de-AT')} – mehr als mit allen Haltestellen.<br>Mit Adressen steht die Schwierigkeit auf „Eigene“; eine Schnellwahl (Leicht … Profi) stellt wieder auf Haltestellen.`,
          )}</span>${seg('endpoints', [
            { value: 'stations', label: '🚏 Haltestellen' },
            ...(app.net.data.addressCount ? [{ value: 'addresses', label: '🏠 Adressen' }] : []),
          ], st.endpoints ?? 'stations', ro)}
            ${addr ? `<small class="hint">${(app.net.data.addressCount ?? 0).toLocaleString('de-AT')} Adressen · Punkte ×${mult.toLocaleString('de-AT')}</small>` : ''}</div>
          ${
            addr
              ? ''
              : `<div class="setting"><span>Haltestellen ${infoTip(
            STATION_GROUPS.map((g) => `<b>${g.icon} ${g.label}:</b> ${g.levels.map((l) => `${esc(l.short)} = ${esc(l.hint)}`).join(' · ')}`).join('<br>') +
              '<br>Kästchen an/aus, darunter die Stufe wählen. Der Punkte-Multiplikator richtet sich nach der schwierigsten Auswahl.',
          )}</span>
            ${stationPicker(st.stations, ro)}
            <small class="hint">${esc(stationsText(st.stations))} · Punkte ×${mult.toLocaleString('de-AT')}</small></div>`
          }
          <div class="setting"><span>Entfernung</span>${seg('distance', DISTANCES.map((d) => ({ value: d.id, label: d.label })), st.distance, ro)}</div>
          <div class="setting"><span>Min. Umstiege ${infoTip(
            'So viele Umstiege hat die beste Verbindung <b>mindestens</b>. 0 = auch Direktverbindungen, 2 = nur Strecken mit 2+ Umstiegen.<br>Leicht 0 · Mittel 1 · Schwer und Profi 2. Mehr Umstiege = mehr Punkte (×1 / ×1,05 / ×1,1).',
          )}</span>
            <label class="slider-row min-tr"><input type="range" min="0" max="2" step="1" value="${st.minTransfers}" data-k="minTransfers" ${ro ? 'disabled' : ''}>
              <b>${st.minTransfers === 0 ? '0 – auch direkt' : `mind. ${st.minTransfers}`}</b></label></div>
`;
    }

    panel.innerHTML = `
      <div class="lobby">
        <div class="lobby-code">
          <div><small>Lobby-Code</small><div class="code">${code}</div></div>
          <div class="code-actions"><button class="btn btn-ghost btn-icon" id="copy">${icon('link')}<span>Link kopieren</span></button>${inviteButton()}</div>
        </div>
        <h3>Spieler <small>(${s.players.length})</small></h3>
        <ul class="players">${players}</ul>

        <h3>Einstellungen ${ro ? '<small>– nur der Host kann sie ändern</small>' : ''}</h3>
        <div class="setting"><span>Schwierigkeit</span>
          ${seg('difficulty', [...DIFFICULTY_PRESETS.map((d) => ({ value: d.id, label: d.label })), ...(st.difficulty === 'custom' ? [{ value: 'custom', label: 'Eigene' }] : [])], st.difficulty, ro)}
          <small class="hint">${st.endpoints === 'addresses' ? `${(app.net.data.addressCount ?? 0).toLocaleString('de-AT')} Adressen` : `${poolCount(st.stations)} Haltestellen`}${st.distance !== 'medium' ? ` · ${DISTANCES.find((d) => d.id === st.distance)!.label}` : ''}${st.minTransfers ? ` · mind. ${st.minTransfers} Umstieg${st.minTransfers > 1 ? 'e' : ''}` : ''} · <b>Punkte ×${mult.toLocaleString('de-AT')}</b> ${st.endpoints === 'addresses' ? '' : infoTip(esc(stationsText(st.stations)))}</small></div>
        <div class="setting"><span>Runden</span>${seg('rounds', [3, 5, 7, 10].map((n) => ({ value: String(n), label: String(n) })), String(st.rounds), ro)}</div>

        <div class="setting"><span>${icon('clock', 15)} Zeitlimit ${infoTip(
          `Pro Runde, inkl. „Wo liegt das?“. Nach Ablauf wird abgegeben, was eingegeben ist. Wer schnell ist, bekommt bis zu +10 % Zeitbonus.<br><b>Ohne:</b> kein Zeitdruck – der Zeitbonus wird an ${fmtDuration(TIME_BONUS_REF_SEC)} gemessen.`,
        )}</span>
          ${seg(
            'limit',
            [
              ...TIME_LIMITS.map((t) => ({ value: String(t), label: st.xtreme !== 'off' ? `${fmtDuration(t)} → ${fmtDuration(t * 2)}` : fmtDuration(t) })),
              { value: 'none', label: '∞ Ohne' },
            ],
            st.roundTimeLimitSec ? String(st.roundTimeLimitSec) : 'none',
            ro,
          )}
          ${st.xtreme !== 'off' && st.roundTimeLimitSec ? `<small class="hint xtreme-hint">⚡ X-treme: doppelte Zeit – ${fmtDuration(st.roundTimeLimitSec)} wird zu <b>${fmtDuration(st.roundTimeLimitSec * 2)}</b>.</small>` : ''}
        </div>

        <div class="toggles main-toggles">
          ${toggleInfo(
            'locate',
            'Wo liegt das?',
            'Vor jeder Runde Start und Ziel auf der leeren Karte antippen – bis +150 Punkte (75 je Station: voll bis 250 m, 0 ab 3 km).',
            st.locate,
            ro || xtremeBlocksLocate(st.xtreme),
            xtremeBlocksLocate(st.xtreme) ? 'aus wegen X-treme' : '',
          )}
        </div>

        <details class="advanced" ${advancedOpen ? 'open' : ''}>
          <summary>${icon('sliders')} Erweiterte Einstellungen</summary>
          <div class="tabs adv-tabs">${ADV_TABS.map((t) => `<button data-adv="${t.id}" class="${advTab === t.id ? 'on' : ''}">${t.label}</button>`).join('')}${
            `<button type="button" class="icon-reset" id="shareSettings" title="Einstellungen teilen: Link oder JSON (Import für Hosts)" aria-label="Einstellungen teilen">⇅</button>${
              host ? '<button type="button" class="icon-reset" id="resetAll" title="Alle Einstellungen zurücksetzen" aria-label="Alle Einstellungen zurücksetzen">↺</button>' : ''
            }`
          }</div>
          <div class="adv-body">${advancedTab()}</div>

        </details>

        <p class="maxpts">Max. <b>${maxRoundPoints(st).toLocaleString('de-AT')}</b> Punkte pro Runde <small>(bis ${maxRoundPointsWithBonus(st).toLocaleString('de-AT')} mit einer Route, die schneller ist als die beste Verbindung)</small></p>
        ${
          host
            ? st.xtreme !== 'off'
              ? `<button class="btn btn-big btn-xtreme" id="start">⚡ X-TREME starten <small>${esc(XTREME_LEVELS.find((x) => x.id === st.xtreme)!.label)}${s.players.length > 1 ? ` · ${s.players.length} Spieler` : ''}</small></button>`
              : `<button class="btn btn-primary btn-big" id="start">${s.players.length > 1 ? `Spiel starten (${s.players.length} Spieler)` : 'Spiel starten'}</button>`
            : `<div class="waiting-host">Warte, bis ${esc(s.players.find((p) => p.isHost)?.name ?? 'der Host')} startet …</div>`
        }
        <button class="link leave" id="leave">Lobby verlassen</button>
      </div>`;
    panel.scrollTop = scroll;
    bindKick(panel);

    panel.querySelector<HTMLDetailsElement>('details.advanced')!.addEventListener('toggle', (e) => {
      advancedOpen = (e.target as HTMLDetailsElement).open;
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-adv]').forEach((b) =>
      b.addEventListener('click', () => {
        advTab = b.dataset.adv as AdvTab;
        render();
      }),
    );
    panel.querySelector('#copy')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteLink(code));
        toast('Einladungslink kopiert', 'info');
      } catch {
        toast(`Code: ${code}`, 'info');
      }
    });
    // ⓘ: Antippen hält das Fenster offen (Handy) – und schaltet dabei nicht den Schalter daneben um
    panel.querySelectorAll<HTMLButtonElement>('.info-tip').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.classList.toggle('open');
      }),
    );
    panel.querySelectorAll<HTMLButtonElement>('button[data-k]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.k!;
        const v = b.dataset.v!;
        if (k === 'rounds') send({ rounds: Number(v) });
        else if (k === 'scoring') send({ ...SCORING_MODES.find((m) => m.id === v)!.settings });
        else if (k === 'grp' || k === 'lvl') {
          const cur = routeState().settings.stations;
          const [gid, lid] = k === 'grp' ? [v, null] : v.split(':');
          const g = STATION_GROUPS.find((x) => x.id === gid)!;
          const others = cur.filter((x) => !g.levels.some((l) => l.id === x));
          // Kästchen: an → höchste Stufe, aus → 0 · Regler: gewählte Stufe (0 = aus)
          const level = k === 'grp' ? (groupLevel(cur, g.id) ? null : g.levels[g.levels.length - 1].id) : lid === '0' ? null : (lid as StationKind);
          const next = [...others, ...(level ? [level] : [])];
          if (!next.length) return toast('Mindestens eine Art von Haltestellen muss gewählt sein.', 'info');
          send({ stations: next });
        }
        else if (k === 'radius') sendFocus({ radiusM: Number(v) });
        else if (k === 'limit') send({ roundTimeLimitSec: v === 'none' ? null : Number(v) });
        else send({ [k]: v } as Partial<GameSettings>);
      }),
    );
    panel.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-k]').forEach((c) =>
      c.addEventListener('change', () => {
        if (c.dataset.k === 'focusOn') return c.checked ? sendFocus({}) : send({ focus: null });
        // „Umstiege vermeiden“ (nur bei Realistisch) = Wertung „beste Route“
        if (c.dataset.k === 'avoidTransfers') return send({ goal: c.checked ? 'best' : 'fastest' });
        send({ [c.dataset.k!]: c.checked } as Partial<GameSettings>);
      }),
    );
    const mtRange = panel.querySelector<HTMLInputElement>('input[type=range][data-k=minTransfers]');
    mtRange?.addEventListener('input', () => (mtRange.nextElementSibling!.textContent = mtRange.value === '0' ? '0 – auch direkt' : `mind. ${mtRange.value}`));
    mtRange?.addEventListener('change', () => send({ minTransfers: Number(mtRange.value) as GameSettings['minTransfers'] }));
    const shareRange = panel.querySelector<HTMLInputElement>('input[type=range][data-k=share]');
    shareRange?.addEventListener('input', () => (shareRange.nextElementSibling!.textContent = `${shareRange.value} %`));
    shareRange?.addEventListener('change', () => sendFocus({ share: Number(shareRange.value) / 100 }));
    panel.querySelector<HTMLSelectElement>('#district')?.addEventListener('change', (e) => {
      const id = Number((e.target as HTMLSelectElement).value);
      if (!id) return;
      const [lat, lon] = districtCenter(id);
      sendFocus({ lat, lon });
    });
    panel.querySelector('#shareSettings')?.addEventListener('click', () =>
      openSettingsDialog(
        'route',
        routeState().settings,
        host
          ? async (s) => {
              const st = (await api.settings(app.session!, s as Partial<GameSettings>)) as GameState;
              const keep: Partial<GameSettings> = { ...st.settings };
              for (const k of NOT_REMEMBERED) delete keep[k];
              app.prefs.settings = keep;
              savePrefs();
              return st.settings as unknown as Record<string, unknown>;
            }
          : null,
      ),
    );
    panel.querySelector('#resetAll')?.addEventListener('click', (e) => {
      // sitzt in der Überschrift von "Erweitert" – nicht auf-/zuklappen
      e.preventDefault();
      e.stopPropagation();
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
    update: deferWhileEditing(panel, render),
    destroy: () => app.map.onTap(null),
  };
}

