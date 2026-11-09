// Spielleitung (nur für Admins, Seite /#spielleitung – nirgends verlinkt außer im Admin-Bereich): eine Routenjagd mit
// ALLEN Einstellungen anlegen – auch denen, die es sonst nur in Tages-Challenges gibt (Variante, Aufgabe, fester Start,
// Bezirke, E-Scooter, Nacht-Uhrzeit …) – und jedes Event starten, nicht nur die heutigen. Mitspielen kann jeder mit dem
// Code wie bei jeder Lobby. In der eigenen Lobby öffnet „🛠 Spielleitung“ dasselbe als Fenster.
//
// Der Server nimmt alle diese Einstellungen ohnehin an (server/settings.ts prüft nur, ob sie gültig sind) – die
// Einschränkungen gibt es nur in der normalen Lobby-Oberfläche.
import { DEFAULT_SETTINGS } from '../../../shared/defaults.ts';
import {
  DISTANCES,
  FOCUS_RADII,
  HIDDEN_SLOTS,
  NET_MODES,
  RESTRICTION_FREQUENCIES,
  ROUTE_GOALS,
  STATION_GROUPS,
  TIME_LIMITS,
  TIME_SLOTS,
  VARIANTS,
  XTREME_LEVELS,
} from '../../../shared/rules.ts';
import type { Challenge } from '../../../shared/challenges.ts';
import type { GameSettings, RoundTask, StationKind } from '../../../shared/types.ts';
import { account } from '../account.ts';
import { api } from '../api.ts';
import { challengeSettings, everyChallenge, todaysChallenges } from '../challenges.ts';
import { app, startSession } from '../store.ts';
import { esc, h, toast } from '../ui.ts';
import { loadingHtml, type Screen } from './screen.ts';

const TASKS: { id: RoundTask; label: string }[] = [
  { id: 'normal', label: 'Normal – schnellste Route' },
  { id: 'choose3', label: 'Drei Ziele (eins reicht)' },
  { id: 'visit3', label: 'Drei Punkte besuchen' },
  { id: 'water', label: 'Zum nächsten Wasser' },
  { id: 'bath', label: 'Zum nächsten Bad' },
  { id: 'heli', label: 'Hubschrauber' },
  { id: 'future', label: 'Zielnetz einblenden' },
];
const TIPS: { id: GameSettings['tips']; label: string }[] = [
  { id: 'off', label: 'Keine' },
  { id: 'cheap', label: 'Günstig' },
  { id: 'expensive', label: 'Teuer' },
];
const NIGHT_LABEL: Record<string, string> = { 'wd-night': 'Mo–Fr 01:30 (Nachtbusse)' };

export const isGameMaster = () => !!account.me?.admin;

/** alle Einstellungen als Formular (vorbelegt mit `s`) */
function formHtml(s: GameSettings): string {
  const opt = <T extends string | number>(list: { id: T; label: string }[], cur: T) => list.map((o) => `<option value="${esc(String(o.id))}" ${o.id === cur ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  const sel = (name: string, label: string, options: string) => `<label class="field"><span>${label}</span><select name="${name}">${options}</select></label>`;
  const check = (name: keyof GameSettings, label: string) => `<label class="check"><input type="checkbox" name="${name}" ${s[name] ? 'checked' : ''}> ${label}</label>`;
  const slots = [...TIME_SLOTS.map((t) => ({ id: t.id as string, label: t.label })), ...Object.keys(HIDDEN_SLOTS).map((id) => ({ id, label: NIGHT_LABEL[id] ?? id }))];
  const kinds = new Set<StationKind>(s.stations);
  const stationRows = STATION_GROUPS.map(
    (g) => `<label class="field"><span>${g.icon} ${esc(g.label)}</span><select name="st-${g.id}"><option value="">aus</option>${g.levels
      .map((l) => `<option value="${l.id}" ${kinds.has(l.id) ? 'selected' : ''} title="${esc(l.hint)}">${esc(l.short)}</option>`)
      .join('')}</select></label>`,
  ).join('');
  const districts = new Set(s.districts ?? []);
  const f = s.focus;
  const names = [...new Set(app.net.data.stations.map((x) => x.name))].sort((a, b) => a.localeCompare(b, 'de'));
  return `<form class="gm-form" id="gm-form">
    <fieldset><legend>Spiel</legend><div class="gm-grid">
      <label class="field"><span>Runden</span><input type="number" name="rounds" min="1" max="10" value="${s.rounds}"></label>
      ${sel('roundTimeLimitSec', 'Zeitlimit je Runde', `<option value="">ohne</option>${[20, 30, 45, ...TIME_LIMITS].map((t) => `<option value="${t}" ${s.roundTimeLimitSec === t ? 'selected' : ''}>${t < 60 ? `${t} s` : `${t / 60} min`}</option>`).join('')}`)}
      ${sel('slot', 'Uhrzeit', opt(slots, s.slot as string))}
      ${sel('network', 'Netz', opt(NET_MODES.map((m) => ({ id: m.id as string, label: m.label })), s.network as string))}
      ${sel('goal', 'Was zählt', opt(ROUTE_GOALS, s.goal))}
      ${sel('tips', 'Tipps', opt(TIPS, s.tips))}
      ${sel('xtreme', 'X-treme', opt(XTREME_LEVELS, s.xtreme))}
      ${sel('restrictions', 'Einschränkungs-Runden', opt(RESTRICTION_FREQUENCIES, s.restrictions))}
    </div>
    <div class="gm-checks">${check('locate', '„Wo liegt das?“ – Start und Ziel erst tippen')}${check('countWait', 'Wartezeit am Start zählt')}${check('avgWait', 'Ø-Wartezeit statt Fahrplan')}${check('onlyRunning', 'Nur fahrende Linien vorschlagen')}${check('scooter', 'E-Scooter statt zu Fuß')}</div></fieldset>

    <fieldset><legend>Start und Ziel</legend><div class="gm-grid">
      ${sel('endpoints', 'Start und Ziel', opt([{ id: 'stations', label: 'Haltestellen' }, { id: 'addresses', label: 'Adressen' }], s.endpoints))}
      ${sel('distance', 'Entfernung', opt(DISTANCES, s.distance))}
      ${sel('minTransfers', 'Mindestens Umstiege', opt([0, 1, 2].map((n) => ({ id: String(n), label: String(n) })), String(s.minTransfers)))}
      <label class="field"><span>Fester Start <small class="muted">(Stationsname)</small></span><input name="start" list="gm-stations" value="${esc(s.start ?? '')}" placeholder="zufällig" autocomplete="off"></label>
      ${stationRows}
    </div>
    <datalist id="gm-stations">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <details class="gm-sub" ${districts.size ? 'open' : ''}><summary>Nur in Bezirken ${districts.size ? `(${[...districts].join(', ')})` : '(ganz Wien)'}</summary>
      <div class="gm-districts">${Array.from({ length: 23 }, (_, i) => i + 1)
        .map((d) => `<label class="check"><input type="checkbox" name="district" value="${d}" ${districts.has(d) ? 'checked' : ''}> ${d}.</label>`)
        .join('')}</div></details>
    <details class="gm-sub" ${f ? 'open' : ''}><summary>Fokus-Gebiet ${f ? '(an)' : '(aus)'}</summary>
      <label class="check"><input type="checkbox" name="focusOn" ${f ? 'checked' : ''}> Stationen in diesem Kreis häufiger ziehen</label>
      <div class="gm-grid">
        <label class="field"><span>Breite</span><input name="focusLat" inputmode="decimal" value="${f?.lat ?? 48.2085}"></label>
        <label class="field"><span>Länge</span><input name="focusLon" inputmode="decimal" value="${f?.lon ?? 16.3731}"></label>
        ${sel('focusR', 'Radius', FOCUS_RADII.map((r) => `<option value="${r}" ${(f?.radiusM ?? 2500) === r ? 'selected' : ''}>${r / 1000} km</option>`).join(''))}
        <label class="field"><span>Anteil im Kreis</span><input type="number" name="focusShare" min="10" max="90" step="10" value="${Math.round((f?.share ?? 0.5) * 100)}"></label>
      </div></details></fieldset>

    <fieldset><legend>Spezial (sonst nur in Tages-Challenges)</legend><div class="gm-grid">
      ${sel('variant', 'Variante für alle Runden', opt(VARIANTS.map((v) => ({ id: v.id, label: `${v.icon ? `${v.icon} ` : ''}${v.label}` })), s.variant))}
      ${sel('task', 'Aufgabe', opt(TASKS, s.task))}
      ${sel(
        'challenge',
        'Läuft als Event',
        `<option value="">– nein –</option>${everyChallenge()
          .map((c) => `<option value="${esc(c.id)}" ${s.challenge === c.id ? 'selected' : ''}>${esc(`${c.icon} ${c.title}`)}</option>`)
          .join('')}`,
      )}
    </div><p class="muted gm-note">„Läuft als Event“: Name und Intro des Events, Einstellungen in der Lobby gesperrt, zählt als Tages-Challenge. Alle anderen Felder gelten trotzdem wie hier eingestellt.</p></fieldset>
  </form>`;
}

/** Formular → Einstellungen (der Server prüft und ergänzt) */
function readForm(form: HTMLFormElement): Partial<GameSettings> {
  const fd = new FormData(form);
  const str = (k: string) => String(fd.get(k) ?? '');
  const on = (k: string) => fd.get(k) === 'on';
  const stations = STATION_GROUPS.map((g) => str(`st-${g.id}`)).filter(Boolean) as StationKind[];
  const districts = fd.getAll('district').map(Number);
  const limit = str('roundTimeLimitSec');
  return {
    rounds: Number(str('rounds')) || DEFAULT_SETTINGS.rounds,
    roundTimeLimitSec: limit ? Number(limit) : null,
    slot: str('slot') as GameSettings['slot'],
    network: str('network') as GameSettings['network'],
    goal: str('goal') as GameSettings['goal'],
    tips: str('tips') as GameSettings['tips'],
    xtreme: str('xtreme') as GameSettings['xtreme'],
    restrictions: str('restrictions') as GameSettings['restrictions'],
    locate: on('locate'),
    countWait: on('countWait'),
    avgWait: on('avgWait'),
    onlyRunning: on('onlyRunning'),
    scooter: on('scooter'),
    endpoints: str('endpoints') as GameSettings['endpoints'],
    distance: str('distance') as GameSettings['distance'],
    minTransfers: Number(str('minTransfers')) as 0 | 1 | 2,
    stations: stations.length ? stations : DEFAULT_SETTINGS.stations,
    start: str('start').trim() || null,
    districts: districts.length ? districts : null,
    focus: on('focusOn') ? { lat: Number(str('focusLat')), lon: Number(str('focusLon')), radiusM: Number(str('focusR')), share: Number(str('focusShare')) / 100 } : null,
    variant: str('variant') as GameSettings['variant'],
    task: str('task') as RoundTask,
    challenge: str('challenge') || null,
  };
}

/** Events als Karten: die heutigen offen, alle anderen zum Aufklappen */
function eventsHtml(): string {
  const today = new Set(todaysChallenges().map((c) => c.id));
  const card = (c: Challenge) => `<div class="gm-event"><span class="gm-ev-icon">${esc(c.icon)}</span><div><b>${esc(c.title)}</b><small>${esc(c.text)}</small></div>
    <button type="button" class="btn btn-ghost btn-small" data-event="${esc(c.id)}">Starten</button></div>`;
  const all = everyChallenge();
  const rest = all.filter((c) => !today.has(c.id));
  return `<p class="muted gm-note">Heute</p><div class="gm-events">${all.filter((c) => today.has(c.id)).map(card).join('')}</div>
    <details class="gm-sub gm-more"><summary>Alle weiteren Events (${rest.length})</summary><div class="gm-events">${rest.map(card).join('')}</div></details>`;
}

const eventSettings = (c: Challenge): Partial<GameSettings> => challengeSettings(c.settings, c.id);

/** was der Server anders übernommen hat als gewünscht (z.B. Fokus außerhalb Wiens) */
function differences(want: Partial<GameSettings>, got: GameSettings): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(want) as [keyof GameSettings, unknown][]) {
    // Schwierigkeit rechnet der Server aus den Reglern; Listen/Objekte vergleicht er in eigener Form
    if (k === 'difficulty' || k === 'focus' || k === 'stations' || k === 'districts') continue;
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(got[k])) out.push(k);
  }
  return out;
}

// ---------------------------------------------------------------- geheime Seite: Lobby anlegen

export function gamemasterScreen(panel: HTMLElement, onBack: () => void): Screen {
  app.map.clear();
  let gone = false;
  panel.innerHTML = `<div class="admin">${loadingHtml('Lädt …')}</div>`;
  // Admin? – direkt beim Server (der Account im Browser ist beim Öffnen per Link evtl. noch nicht geladen)
  void fetch('/api/admin/status', { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<{ admin: boolean }>) : { admin: false }))
    .catch(() => ({ admin: false }))
    .then((s) => {
      if (gone) return;
      if (s.admin) return render();
      panel.innerHTML = `<div class="admin"><button class="link" id="back">← Zurück</button><p class="muted">Diese Seite gibt es nicht.</p></div>`;
      panel.querySelector('#back')!.addEventListener('click', onBack);
    });
  let settings: GameSettings = { ...DEFAULT_SETTINGS, ...(app.prefs.settings as Partial<GameSettings>), challenge: null };
  let busy = false;
  const render = () => {
    panel.innerHTML = `<div class="admin gm"><div class="adm-head"><button class="link" id="back">← Zurück</button></div>
      <h2>🛠 Spielleitung</h2>
      <p class="muted">Routenjagd mit allen Einstellungen – mitspielen kann jeder mit dem Code. Du bist Host und kannst in der Lobby über „🛠 Spielleitung“ jederzeit weiter ändern.</p>
      <label class="field"><span>Dein Name im Spiel</span><input id="gm-name" maxlength="40" value="${esc(account.me?.name ?? app.prefs.name)}"></label>
      <h3>Event starten</h3>${eventsHtml()}
      <h3>Alle Einstellungen</h3>${formHtml(settings)}
      <div class="adm-row gm-actions"><button class="btn btn-primary" id="gm-create">Lobby erstellen</button><button class="btn btn-ghost" id="gm-reset">Auf Standard</button></div></div>`;
    panel.querySelector('#back')!.addEventListener('click', onBack);
    const form = panel.querySelector<HTMLFormElement>('#gm-form')!;
    form.addEventListener('submit', (e) => e.preventDefault());
    panel.querySelector('#gm-create')!.addEventListener('click', () => void create(readForm(form)));
    panel.querySelector('#gm-reset')!.addEventListener('click', () => ((settings = { ...DEFAULT_SETTINGS }), render()));
    panel.querySelectorAll<HTMLButtonElement>('[data-event]').forEach((b) =>
      b.addEventListener('click', () => {
        const c = everyChallenge().find((x) => x.id === b.dataset.event);
        if (c) void create(eventSettings(c));
      }),
    );
  };
  async function create(want: Partial<GameSettings>) {
    if (busy) return;
    busy = true;
    const name = panel.querySelector<HTMLInputElement>('#gm-name')?.value.trim() || 'Spielleitung';
    try {
      const res = await api.create(name, 'route', want);
      const diff = differences(want, res.state.settings as GameSettings);
      if (diff.length) toast(`Nicht übernommen: ${diff.join(', ')}`, 'info');
      startSession({ code: res.state.id, playerId: res.playerId, token: res.token }, res.state);
    } catch (e) {
      toast((e as Error).message);
      busy = false;
    }
  }
  return {
    destroy: () => {
      gone = true;
    },
  };
}

// ---------------------------------------------------------------- in der eigenen Lobby: als Fenster

export function openGamemaster(current: GameSettings) {
  if (!app.session || !isGameMaster()) return;
  const dlg = h('dialog', { class: 'gm-dlg', 'aria-label': 'Spielleitung' });
  dlg.innerHTML = `<div class="gm"><div class="gm-dlg-head"><h3>🛠 Spielleitung</h3><button class="link" data-close>Schließen</button></div>
    <h4>Event starten</h4>${eventsHtml()}
    <h4>Alle Einstellungen</h4>${formHtml(current)}
    <div class="adm-row gm-actions"><button class="btn btn-primary" id="gm-apply">Übernehmen</button><button class="btn btn-ghost" data-close>Abbrechen</button></div></div>`;
  const close = () => (dlg.close(), dlg.remove());
  const apply = async (want: Partial<GameSettings>) => {
    try {
      const st = await api.settings(app.session!, want);
      const diff = differences(want, (st as { settings: GameSettings }).settings);
      toast(diff.length ? `Übernommen – außer: ${diff.join(', ')}` : 'Übernommen', 'info');
      close();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === dlg || t.closest('[data-close]')) return close();
    const ev = t.closest<HTMLElement>('[data-event]');
    if (ev) {
      const c = everyChallenge().find((x) => x.id === ev.dataset.event);
      if (c) void apply(eventSettings(c));
    }
    if (t.closest('#gm-apply')) void apply(readForm(dlg.querySelector<HTMLFormElement>('#gm-form')!));
  });
  dlg.addEventListener('cancel', (e) => (e.preventDefault(), close()));
  dlg.querySelector('#gm-form')!.addEventListener('submit', (e) => e.preventDefault());
  document.body.append(dlg);
  dlg.showModal();
}
