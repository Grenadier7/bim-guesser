// Admin-Seite (nur für Accounts mit Admin-Recht – vergeben über die Kommandozeile):
// Übersicht (Server, Lobbys), Accounts verwalten, Routenberechnung einstellen, Protokoll.
import type {
  AdminLobby,
  AdminLogEntry,
  AdminOverview,
  AdminUserDetail,
  AdminUserRow,
  LineEdit,
  Mode,
  RouteOption,
  RoutingAdminState,
  RoutingParams,
  SlotId,
} from '../../../shared/types.ts';
import { TIME_SLOTS } from '../../../shared/rules.ts';
import { call } from '../account.ts';
import { app } from '../store.ts';
import { chain, esc, toast } from '../ui.ts';
import { infoTip } from '../widgets.ts';
import { loadingHtml, type Screen } from './screen.ts';

type Tab = 'overview' | 'users' | 'routing' | 'log';

const PARAM_INFO: Record<keyof RoutingParams, { label: string; unit: string; hint: string; step?: number }> = {
  changeMin: { label: 'Umsteigezeit', unit: 'min', hint: 'Umsteigen in ein anderes Fahrzeug an derselben Haltestelle.' },
  transferWalkM: { label: 'Umsteige-Fußweg höchstens', unit: 'm', hint: 'Zu Fuß zu einer anderen Haltestelle umsteigen – bis zu dieser Entfernung (Luftlinie).' },
  accessWalkM: { label: 'Fußweg von/zu Adressen höchstens', unit: 'm', hint: 'Bei Adressen als Start/Ziel: so weit wird höchstens zur ersten/von der letzten Haltestelle gegangen.' },
  walkOnlyM: { label: 'Ganz zu Fuß bis', unit: 'm', hint: 'Bis zu dieser Entfernung wird auch „nur gehen“ als Verbindung angeboten.' },
  maxRides: { label: 'Fahrten je Verbindung höchstens', unit: '', hint: 'Mehr Fahrten (= mehr Umstiege) werden nicht gesucht.' },
  firstWaitFactor: { label: 'Anteil erste Wartezeit („Realistisch“)', unit: '×', hint: 'Am Start zählt nur dieser Anteil der Ø-Wartezeit – zur ersten Abfahrt kann man sich die Zeit einteilen.', step: 0.05 },
};

const ago = (t: number) => {
  if (!t) return '–';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'gerade eben';
  if (m < 60) return `vor ${m} min`;
  if (m < 48 * 60) return `vor ${Math.round(m / 60)} h`;
  return `vor ${Math.round(m / 1440)} Tagen`;
};
const date = (t: number) => new Date(t).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' });
const dur = (sec: number) => (sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86400 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.floor(sec / 86400)} Tage`);

export function adminScreen(panel: HTMLElement, onBack: () => void): Screen {
  let tab: Tab = 'overview';
  let query = '';
  let detail: string | null = null;
  /** geöffnete Lobby (Übersicht) – aktualisiert sich alle paar Sekunden */
  let lobbyCode: string | null = null;
  const poll = setInterval(() => void refreshLobby(), 4000);
  let routing: RoutingAdminState | null = null;
  /** Entwurf der Routenberechnung (erst „Speichern“ wendet an) */
  let draft: { params: Partial<RoutingParams>; edits: LineEdit[] } | null = null;
  let probe: { from: string; to: string; slot: SlotId; routes: RouteOption[] | null } = { from: '', to: '', slot: 'wd12', routes: null };
  /** Formular „neue Linien-Änderung“ */
  const form = { kind: 'extend' as LineEdit['kind'], line: '', at: '', beyond: '', pair: '', min: 3, stops: [{ name: '', min: 2 }] };
  let gen = 0;
  app.map.clear();

  const net = () => app.net;
  const stName = (id: string) => net().stations.get(id)?.name ?? id;
  /** Station zu einem Namen – bei gleichen Namen die, an der Linien dieses Verkehrsmittels halten */
  const stationByName = (name: string, mode?: Mode): string | null => {
    const n = name.trim().toLowerCase();
    const all = [...net().stations.values()].filter((s) => s.name.toLowerCase() === n);
    const fit = mode && all.find((s) => s.lines.some((l) => net().lines.get(l)?.mode === mode));
    return (fit || all[0])?.id ?? null;
  };
  const lineStations = (line: string): string[] => {
    const l = net().lines.get(line);
    return l ? [...new Set(l.patterns.flat())] : [];
  };
  const termini = (line: string): string[] => {
    const l = net().lines.get(line);
    return l ? [...new Set(l.patterns.flatMap((p) => [p[0], p[p.length - 1]]))] : [];
  };
  const pairs = (line: string): [string, string][] => {
    const l = net().lines.get(line);
    const seen = new Set<string>();
    const out: [string, string][] = [];
    for (const p of l?.patterns ?? [])
      for (let i = 1; i < p.length; i++) {
        const k = [p[i - 1], p[i]].sort().join('|');
        if (!seen.has(k)) (seen.add(k), out.push([p[i - 1], p[i]]));
      }
    return out;
  };
  const describe = (e: LineEdit) =>
    e.kind === 'extend'
      ? `<b>${esc(e.line)}</b> fährt über ${esc(stName(e.at))} hinaus: ${e.stops.map((s) => `${esc(stName(s.station))} <small>+${s.min} min</small>`).join(' → ')}`
      : e.kind === 'cut'
        ? `<b>${esc(e.line)}</b> endet bei ${esc(stName(e.at))} <small>(ohne den Teil Richtung ${esc(stName(e.beyond))})</small>`
        : `<b>${esc(e.line)}</b> ${esc(stName(e.from))} ↔ ${esc(stName(e.to))}: <b>${e.min} min</b>`;

  // -------------------------------------------------------------- Rahmen

  async function render() {
    const g = ++gen;
    const tabs: [Tab, string][] = [
      ['overview', '📊 Übersicht'],
      ['users', '👥 Accounts'],
      ['routing', '🧭 Routenberechnung'],
      ['log', '📜 Protokoll'],
    ];
    const head = `<button class="link" id="back">← Zurück</button>
      <h2>🛠 Admin</h2>
      <div class="adm-tabs">${tabs.map(([t, l]) => `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    panel.innerHTML = `<div class="admin">${head}<div class="adm-body">${loadingHtml('Lädt …')}</div></div>`;
    bindHead();
    let html: string;
    try {
      html = await body();
    } catch (e) {
      html = `<p class="err">${esc((e as Error).message)}</p>`;
    }
    if (g !== gen) return;
    panel.querySelector('.adm-body')!.innerHTML = html;
    bindBody();
  }

  function bindHead() {
    panel.querySelector('#back')!.addEventListener('click', onBack);
    panel.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab as Tab;
        detail = null;
        lobbyCode = null;
        void render();
      }),
    );
  }

  async function body(): Promise<string> {
    if (tab === 'overview' && lobbyCode) {
      try {
        return lobbyHtml(await call<AdminLobby>('GET', `/api/admin/lobbies/${lobbyCode}`));
      } catch {
        toast(`Lobby ${lobbyCode} gibt es nicht mehr.`, 'info');
        lobbyCode = null;
      }
    }
    if (tab === 'overview') return overview(await call<AdminOverview>('GET', '/api/admin/overview'));
    if (tab === 'users') return detail ? userDetail(await call<AdminUserDetail>('GET', `/api/admin/users/${encodeURIComponent(detail)}`)) : users(await call<AdminUserRow[]>('GET', `/api/admin/users?q=${encodeURIComponent(query)}`));
    if (tab === 'routing') {
      routing ??= await call<RoutingAdminState>('GET', '/api/admin/routing');
      draft ??= structuredClone({ params: routing.overrides.params, edits: routing.overrides.edits });
      return routingHtml();
    }
    return logHtml(await call<AdminLogEntry[]>('GET', '/api/admin/log'));
  }

  // -------------------------------------------------------------- Übersicht

  function overview(o: AdminOverview): string {
    const u = o.users;
    const card = (v: string | number, l: string) => `<div class="adm-card"><b>${v}</b><small>${l}</small></div>`;
    return `
      ${o.warnings.length ? `<div class="adm-warn">${o.warnings.map((w) => `⚠ ${esc(w)}`).join('<br>')}</div>` : ''}
      <div class="adm-cards">
        ${card(u.total, 'Accounts')}${card(u.online, 'gerade online')}${card(u.new7d, 'neu (7 Tage)')}${card(u.withEmail, 'mit E-Mail')}
        ${card(o.lobbies.length, 'Lobbys')}${card(o.activeGames, 'Spiele laufen')}${card(u.admins, 'Admins')}
      </div>
      <dl class="adm-facts">
        <dt>Version</dt><dd>${esc(o.version)} · läuft seit ${dur(o.uptimeSec)} · ${o.memoryMb} MB RAM</dd>
        <dt>E-Mail</dt><dd>${o.mail ? '✔ eingerichtet („Passwort vergessen“ geht)' : '✖ aus – SMTP_URL fehlt (Reset-Links unter Accounts erzeugen)'}</dd>
        <dt>Fahrplan</dt><dd>${o.timetable.loaded ? `✔ eigener Referenzfahrplan, gültig bis ${esc(o.timetable.validUntil ?? '?')}` : '✖ aus – es wird die Online-Auskunft gefragt'}</dd>
      </dl>
      <h3>Lobbys</h3>
      ${
        o.lobbies.length
          ? `<ul class="adm-list">${o.lobbies
              .map(
                (l) => `<li><div><b class="mono">${esc(l.code)}</b> ${l.mode === 'quiz' ? '🧠 Quiz' : '🏁 Routenjagd'} · ${esc(phaseLabel(l.phase))} · aktiv ${ago(l.lastActivity)}
                  <div class="adm-players">${l.players.map((p) => `<span class="${p.connected ? 'on' : ''}">${esc(p.name)}${p.account ? ` <small>(${esc(p.account)})</small>` : ''}</span>`).join('')}</div></div>
                  <div class="adm-row"><button class="btn btn-ghost btn-small" data-lobby="${esc(l.code)}">Verwalten</button><button class="btn btn-ghost btn-small" data-close="${esc(l.code)}">Beenden</button></div></li>`,
              )
              .join('')}</ul>`
          : '<p class="muted">Gerade keine Lobby offen.</p>'
      }`;
  }
  const phaseLabel = (p: string) => ({ lobby: 'wartet', playing: 'läuft', finished: 'fertig' })[p] ?? p;

  function lobbyHtml(l: AdminLobby): string {
    const btn = (act: string, label: string, cls = 'btn-ghost') => `<button class="btn ${cls} btn-small" data-lact="${act}">${label}</button>`;
    const actions =
      l.phase === 'lobby'
        ? btn('start', '▶ Spiel starten', 'btn-primary')
        : l.phase === 'playing'
          ? `${l.paused ? btn('resume', '▶ Fortsetzen', 'btn-primary') : btn('pause', '⏸ Pause')}${l.mode === 'route' ? btn('cancel', 'Runde abbrechen') : ''}${btn('next', 'Weiter')}${btn('lobby', 'Zurück in die Lobby')}`
          : btn('lobby', 'Zurück in die Lobby');
    return `<button class="link" id="adm-lobbies">← alle Lobbys</button>
      <div class="profile-head"><h3><span class="mono">${esc(l.code)}</span> ${l.mode === 'quiz' ? '🧠 Quiz' : '🏁 Routenjagd'}</h3>
        <a class="link" href="/?code=${encodeURIComponent(l.code)}" target="_blank" rel="noopener">Als Spieler beitreten ↗</a></div>
      <p class="muted">${esc(phaseLabel(l.phase))}${l.progress ? ` · ${esc(l.progress)}` : ''} · erstellt ${ago(l.createdAt)} · aktiv ${ago(l.lastActivity)}</p>
      <div class="adm-row">${actions}<button class="btn btn-danger btn-small" data-close="${esc(l.code)}">Lobby beenden</button></div>
      <h3>Spieler (${l.players.length})</h3>
      <table class="adm-table"><thead><tr><th>Name</th><th>Punkte</th><th></th></tr></thead><tbody>${l.players
        .map(
          (p) => `<tr><td><span class="online-dot ${p.connected ? 'on' : ''}"></span>${esc(p.name)}${p.account ? ` <small class="muted">Account ${esc(p.account)}</small>` : ''}${p.host ? ' <span class="adm-badge">Host</span>' : ''}</td>
            <td>${p.score.toLocaleString('de-AT')}</td>
            <td class="adm-row"><button class="btn btn-ghost btn-small" data-host="${esc(p.id)}" data-on="${p.host ? '0' : '1'}">${p.host ? 'Host-Rechte nehmen' : 'Zum Host machen'}</button>
              <button class="btn btn-ghost btn-small" data-kick="${esc(p.id)}" data-name="${esc(p.name)}">Entfernen</button></td></tr>`,
        )
        .join('')}</tbody></table>
      <h3>Chat</h3>
      <ul class="adm-chat">${l.chat.map((m) => `<li><small class="muted">${new Date(m.at).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}</small> ${m.name ? `<b>${esc(m.name)}:</b> ` : ''}${esc(m.text)}</li>`).join('') || '<li class="muted">Noch nichts geschrieben.</li>'}</ul>
      <form class="adm-row" id="adm-say"><input class="line-input" name="text" maxlength="300" placeholder="Nachricht als Spielleitung …" autocomplete="off"><button class="btn btn-ghost">Senden</button></form>`;
  }

  /** offene Lobby neu laden, ohne eine angefangene Chat-Nachricht zu verlieren */
  async function refreshLobby() {
    if (tab !== 'overview' || !lobbyCode) return;
    const typing = panel.querySelector<HTMLInputElement>('#adm-say input');
    if (typing && (typing.value || document.activeElement === typing)) return;
    try {
      const l = await call<AdminLobby>('GET', `/api/admin/lobbies/${lobbyCode}`);
      const root = panel.querySelector<HTMLElement>('.adm-body');
      if (!root || tab !== 'overview' || lobbyCode !== l.code) return;
      root.innerHTML = lobbyHtml(l);
      bindBody();
    } catch {
      /* weg oder kurz nicht erreichbar – beim nächsten Klick merkt man es */
    }
  }

  // -------------------------------------------------------------- Accounts

  function users(list: AdminUserRow[]): string {
    return `<input class="line-input" id="adm-q" placeholder="Name oder E-Mail suchen …" value="${esc(query)}" autocomplete="off" spellcheck="false">
      <ul class="adm-list adm-users">${
        list
          .map(
            (u) => `<li data-user="${esc(u.name)}" tabindex="0"><div><span class="online-dot ${u.online ? 'on' : ''}"></span><b>${esc(u.name)}</b>${u.admin ? ' <span class="adm-badge">Admin</span>' : ''}
              <small class="muted">${u.email ? esc(u.email) : 'keine E-Mail'}</small></div>
              <small>Lv ${u.level} · ${u.games} Spiele · ${u.online ? 'online' : `zuletzt ${ago(u.lastSeen)}`}</small></li>`,
          )
          .join('') || '<li class="muted">Niemand gefunden.</li>'
      }</ul>`;
  }

  function userDetail(u: AdminUserDetail): string {
    const s = u.stats;
    const dataKeys = Object.entries(u.data);
    return `<button class="link" id="adm-list">← alle Accounts</button>
      <div class="profile-head"><h3><span class="online-dot ${u.online ? 'on' : ''}"></span>${esc(u.name)}${u.admin ? ' <span class="adm-badge">Admin</span>' : ''}</h3></div>
      <dl class="adm-facts">
        <dt>E-Mail</dt><dd>${u.email ? esc(u.email) : '<span class="muted">keine</span>'}</dd>
        <dt>Dabei seit</dt><dd>${date(u.created)}</dd>
        <dt>Zuletzt da</dt><dd>${u.online ? 'gerade online' : `${ago(u.lastSeen)} (${date(u.lastSeen)})`}</dd>
        <dt>Angemeldet auf</dt><dd>${u.sessions} Gerät(en)</dd>
        <dt>Level</dt><dd>${u.level} · ${u.xp} XP</dd>
        <dt>Spiele</dt><dd>${s.games} Routenjagd (${s.wins} Siege, ${s.rounds} Runden, Ø ${s.avgRoute} Punkte) · ${s.quizGames} Quiz · ${s.trainings} Training</dd>
        <dt>Medaillen</dt><dd>${u.medals.filter((m) => m.at).map((m) => `<span title="${esc(m.title)}">${m.icon}</span>`).join(' ') || '–'}</dd>
        <dt>Freunde</dt><dd>${u.friends.map(esc).join(', ') || '–'}${u.incoming.length ? ` · Anfragen von ${u.incoming.map(esc).join(', ')}` : ''}${u.outgoing.length ? ` · angefragt: ${u.outgoing.map(esc).join(', ')}` : ''}</dd>
        <dt>Spielstand</dt><dd>${dataKeys.length ? dataKeys.map(([k, n]) => `${esc(k.replace(/^oeffi-/, ''))} <small>(${n} B)</small>`).join(', ') : '–'}</dd>
      </dl>
      <div class="adm-actions">
        <form data-act="password"><label class="field"><span>Neues Passwort setzen ${infoTip('Meldet den Account auf allen Geräten ab. Das Passwort dann persönlich weitergeben.')}</span>
          <input name="v" type="text" minlength="8" required autocomplete="off" placeholder="mind. 8 Zeichen"></label><button class="btn btn-ghost">Setzen</button></form>
        <div><button class="btn btn-ghost" data-act="reset-link">🔗 Link zum Zurücksetzen erzeugen</button> ${infoTip('Gilt 1 Stunde. Zum Weitergeben, wenn keine E-Mail ankommt – die Person legt damit selbst ein neues Passwort fest.')}
          <div id="adm-link"></div></div>
        <form data-act="name"><label class="field"><span>Umbenennen</span><input name="v" value="${esc(u.name)}" required minlength="3" maxlength="20"></label><button class="btn btn-ghost">Speichern</button></form>
        <form data-act="email"><label class="field"><span>E-Mail <small class="muted">(leer = entfernen)</small></span><input name="v" type="email" value="${esc(u.email ?? '')}"></label><button class="btn btn-ghost">Speichern</button></form>
        <div class="adm-row">
          <button class="btn btn-ghost" data-act="logout">Auf allen Geräten abmelden</button>
          <button class="btn btn-ghost" data-act="reset-stats">Statistik zurücksetzen</button>
          ${u.admin ? `<span class="muted">Admins lassen sich nur löschen, nachdem ihnen über die Kommandozeile die Rechte genommen wurden.</span>` : `<button class="btn btn-danger" data-act="delete">Account löschen</button>`}
        </div>
      </div>`;
  }

  // -------------------------------------------------------------- Routenberechnung

  function routingHtml(): string {
    const st = routing!;
    const d = draft!;
    const dirty = JSON.stringify({ p: d.params, e: d.edits }) !== JSON.stringify({ p: st.overrides.params, e: st.overrides.edits });
    const lines = [...net().lines.values()].filter((l) => l.mode !== 'W');
    const stationList = [...new Set([...net().stations.values()].map((s) => s.name))].sort((a, b) => a.localeCompare(b, 'de'));
    const paramRows = (Object.keys(PARAM_INFO) as (keyof RoutingParams)[])
      .map((k) => {
        const info = PARAM_INFO[k];
        const v = d.params[k];
        return `<label class="adm-param ${v != null ? 'changed' : ''}"><span>${info.label} ${infoTip(esc(info.hint))}</span>
          <input type="number" data-param="${k}" step="${info.step ?? 1}" placeholder="${st.defaults[k]}" value="${v ?? ''}"> <small>${info.unit} <span class="muted">Standard ${st.defaults[k]}</span></small></label>`;
      })
      .join('');
    const l = form.line && net().lines.get(form.line);
    const opt = (ids: string[], cur: string, empty: string) => `<option value="">${empty}</option>${ids.map((id) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(stName(id))}</option>`).join('')}`;
    let fields = '';
    if (l) {
      if (form.kind === 'extend')
        fields = `<label class="field"><span>Bisherige Endstation</span><select data-f="at">${opt(termini(form.line), form.at, 'wählen …')}</select></label>
          <div class="field"><span>Weiter über diese Halte <small class="muted">(Fahrzeit ab dem vorigen Halt)</small></span>
          ${form.stops
            .map(
              (s, i) => `<div class="adm-stop"><input list="adm-stations" data-stop="${i}" value="${esc(s.name)}" placeholder="Station">
                <input type="number" min="0" max="60" data-stopmin="${i}" value="${s.min}"> min ${form.stops.length > 1 ? `<button type="button" class="icon-btn" data-rmstop="${i}" aria-label="Halt entfernen">✕</button>` : ''}</div>`,
            )
            .join('')}
          <button type="button" class="link" id="adm-addstop">+ weiterer Halt</button></div>`;
      else if (form.kind === 'cut')
        fields = `<label class="field"><span>Neue Endstation</span><select data-f="at">${opt(lineStations(form.line), form.at, 'wählen …')}</select></label>
          <label class="field"><span>Weg fällt der Teil Richtung</span><select data-f="beyond">${opt(lineStations(form.line), form.beyond, 'wählen …')}</select></label>`;
      else
        fields = `<label class="field"><span>Abschnitt</span><select data-f="pair"><option value="">wählen …</option>${pairs(form.line)
          .map(([a, b]) => `<option value="${a}|${b}" ${form.pair === `${a}|${b}` ? 'selected' : ''}>${esc(stName(a))} ↔ ${esc(stName(b))}</option>`)
          .join('')}</select></label>
          <label class="field"><span>Fahrzeit</span><input type="number" min="0" max="60" data-f="min" value="${form.min}"> min</label>`;
    }
    const slotOpts = TIME_SLOTS.map((t) => `<option value="${t.id}" ${t.id === probe.slot ? 'selected' : ''}>${esc(t.short)}</option>`).join('');
    return `
      <p class="muted">Gilt für den eigenen Referenzfahrplan (reguläres Netz) – für neue Runden, Training und den Routen-Baukasten. Laufende Runden behalten ihre Werte.</p>
      <datalist id="adm-stations">${stationList.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <datalist id="adm-lines">${lines.map((x) => `<option value="${esc(x.id)}">`).join('')}</datalist>
      <h3>Parameter</h3>
      <div class="adm-params">${paramRows}</div>
      <h3>Linien-Änderungen</h3>
      ${d.edits.length ? `<ul class="adm-list adm-edits">${d.edits.map((e, i) => `<li><span>${describe(e)}</span><button class="icon-btn" data-rmedit="${i}" aria-label="Änderung entfernen">✕</button></li>`).join('')}</ul>` : '<p class="muted">Keine – Fahrplan wie aus den GTFS-Daten.</p>'}
      <details class="adm-new" ${form.line ? 'open' : ''}><summary>+ Änderung hinzufügen</summary>
        <div class="seg seg-wide">${(
          [
            ['extend', 'Verlängern'],
            ['cut', 'Kürzen'],
            ['time', 'Fahrzeit'],
          ] as const
        )
          .map(([k, lbl]) => `<button type="button" data-kind="${k}" class="${form.kind === k ? 'on' : ''}">${lbl}</button>`)
          .join('')}</div>
        <label class="field"><span>Linie</span><input list="adm-lines" data-f="line" value="${esc(form.line)}" placeholder="z.B. S40" autocomplete="off"></label>
        ${form.line && !l ? '<p class="err">Diese Linie gibt es nicht.</p>' : fields}
        ${l ? '<button type="button" class="btn btn-ghost" id="adm-addedit">Zur Liste hinzufügen</button>' : ''}
      </details>
      <div class="adm-row adm-save">
        <button class="btn btn-primary" id="adm-save" ${dirty ? '' : 'disabled'}>${dirty ? 'Speichern und anwenden' : 'Gespeichert'}</button>
        ${dirty ? '<button class="btn btn-ghost" id="adm-discard">Verwerfen</button>' : ''}
        <button class="btn btn-ghost" id="adm-defaults" ${Object.keys(d.params).length || d.edits.length ? '' : 'disabled'}>Alles auf Standard</button>
      </div>
      ${st.overrides.updatedAt ? `<p class="muted">Zuletzt geändert ${date(st.overrides.updatedAt)} von ${esc(st.overrides.updatedBy ?? '?')}</p>` : ''}
      ${st.report.length ? `<ul class="adm-report">${st.report.map((r) => `<li class="${r.startsWith('✔') ? 'good' : 'err'}">${esc(r)}</li>`).join('')}</ul>` : ''}
      <h3>Probe-Abfrage ${infoTip('Schnellste Verbindungen wie im Spiel („Realistisch“) mit den gespeicherten Einstellungen.')}</h3>
      <div class="adm-probe">
        <input list="adm-stations" id="adm-from" placeholder="Start" value="${esc(probe.from)}">
        <input list="adm-stations" id="adm-to" placeholder="Ziel" value="${esc(probe.to)}">
        <select id="adm-slot">${slotOpts}</select>
        <button class="btn btn-ghost" id="adm-probe">Berechnen</button>
      </div>
      ${probe.routes ? `<ol class="route-list">${probe.routes.slice(0, 5).map((r, i) => `<li><div class="rrow"><span class="rank">${i + 1}</span><div class="rmain"><div class="chainline">${chain(r.legs)}</div></div><div class="rtime"><b>${r.medianMin} min</b></div></div></li>`).join('')}</ol>` : ''}`;
  }

  /** Formular → Linien-Änderung (oder Meldung, was fehlt) */
  function editFromForm(): LineEdit | string {
    const line = form.line;
    const mode = net().lines.get(line)!.mode;
    if (form.kind === 'extend') {
      if (!form.at) return 'Bisherige Endstation wählen.';
      const stops: { station: string; min: number }[] = [];
      for (const s of form.stops) {
        const id = stationByName(s.name, mode);
        if (!id) return `Station „${s.name}“ nicht gefunden.`;
        stops.push({ station: id, min: Math.max(0, Math.round(s.min)) });
      }
      return { kind: 'extend', line, at: form.at, stops };
    }
    if (form.kind === 'cut') {
      if (!form.at || !form.beyond || form.at === form.beyond) return 'Neue Endstation und die wegfallende Richtung wählen.';
      return { kind: 'cut', line, at: form.at, beyond: form.beyond };
    }
    if (!form.pair) return 'Abschnitt wählen.';
    const [from, to] = form.pair.split('|');
    return { kind: 'time', line, from, to, min: Math.max(0, Math.round(form.min)) };
  }

  // -------------------------------------------------------------- Protokoll

  function logHtml(list: AdminLogEntry[]): string {
    return list.length
      ? `<table class="adm-table"><thead><tr><th>Wann</th><th>Wer</th><th>Was</th><th>Betrifft</th></tr></thead><tbody>${list
          .map((e) => `<tr><td>${date(e.at)}</td><td>${esc(e.admin)}</td><td>${esc(e.action)}${e.detail ? `<br><small class="muted">${esc(e.detail)}</small>` : ''}</td><td>${esc(e.target ?? '')}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="muted">Noch nichts passiert.</p>';
  }

  // -------------------------------------------------------------- Aktionen

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      if (ok) toast(ok, 'info');
      void render();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  function bindBody() {
    const root = panel.querySelector<HTMLElement>('.adm-body')!;
    // Übersicht und Lobby
    root.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm(`Lobby ${b.dataset.close} für alle beenden?`)) return;
        void run(async () => {
          await call('POST', `/api/admin/lobbies/${b.dataset.close}/close`);
          lobbyCode = null;
        }, 'Lobby beendet');
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-lobby]').forEach((b) =>
      b.addEventListener('click', () => {
        lobbyCode = b.dataset.lobby!;
        void render();
      }),
    );
    root.querySelector('#adm-lobbies')?.addEventListener('click', () => ((lobbyCode = null), void render()));
    const lobbyPost = (path: string, body: object, ok: string) => run(() => call('POST', `/api/admin/lobbies/${lobbyCode}/${path}`, body), ok);
    root.querySelectorAll<HTMLButtonElement>('[data-lact]').forEach((b) => b.addEventListener('click', () => void lobbyPost(b.dataset.lact!, {}, '')));
    root.querySelectorAll<HTMLButtonElement>('[data-host]').forEach((b) => b.addEventListener('click', () => void lobbyPost('host', { playerId: b.dataset.host, on: b.dataset.on === '1' }, '')));
    root.querySelectorAll<HTMLButtonElement>('[data-kick]').forEach((b) =>
      b.addEventListener('click', () => {
        if (confirm(`${b.dataset.name} aus der Lobby entfernen?`)) void lobbyPost('kick', { playerId: b.dataset.kick }, `${b.dataset.name} entfernt`);
      }),
    );
    root.querySelector<HTMLFormElement>('#adm-say')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = (e.currentTarget as HTMLFormElement).elements.namedItem('text') as HTMLInputElement;
      if (!inp.value.trim()) return;
      const text = inp.value;
      inp.value = '';
      void lobbyPost('chat', { text }, '');
    });
    // Accounts
    const q = root.querySelector<HTMLInputElement>('#adm-q');
    let t: ReturnType<typeof setTimeout>;
    q?.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        query = q.value;
        void render().then(() => {
          const n = panel.querySelector<HTMLInputElement>('#adm-q');
          n?.focus();
          n?.setSelectionRange(n.value.length, n.value.length);
        });
      }, 250);
    });
    q?.focus();
    root.querySelectorAll<HTMLElement>('[data-user]').forEach((li) => {
      const open = () => {
        detail = li.dataset.user!;
        void render();
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    });
    root.querySelector('#adm-list')?.addEventListener('click', () => ((detail = null), void render()));
    if (detail) bindUser(root, detail);
    if (tab === 'routing') bindRouting(root);
  }

  function bindUser(root: HTMLElement, name: string) {
    const u = encodeURIComponent(name);
    root.querySelectorAll<HTMLFormElement>('form[data-act]').forEach((f) =>
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = (f.elements.namedItem('v') as HTMLInputElement).value;
        if (f.dataset.act === 'password') void run(() => call('POST', `/api/admin/users/${u}/password`, { password: v }), 'Passwort gesetzt – auf allen Geräten abgemeldet');
        if (f.dataset.act === 'email') void run(() => call('PUT', `/api/admin/users/${u}/email`, { email: v }), 'E-Mail gespeichert');
        if (f.dataset.act === 'name')
          void (async () => {
            try {
              detail = (await call<{ name: string }>('PUT', `/api/admin/users/${u}/name`, { name: v })).name;
              toast('Umbenannt', 'info');
              void render();
            } catch (err) {
              toast((err as Error).message);
            }
          })();
      }),
    );
    root.querySelector('[data-act="reset-link"]')?.addEventListener('click', async () => {
      try {
        const { link } = await call<{ link: string }>('POST', `/api/admin/users/${u}/reset-link`);
        const box = root.querySelector<HTMLElement>('#adm-link')!;
        box.innerHTML = `<input class="adm-linkbox" readonly value="${esc(link)}"><button class="btn btn-ghost btn-small" id="adm-copy">Kopieren</button><small class="muted">gilt 1 Stunde</small>`;
        box.querySelector('#adm-copy')!.addEventListener('click', () => void navigator.clipboard.writeText(link).then(() => toast('Link kopiert', 'info')));
      } catch (e) {
        toast((e as Error).message);
      }
    });
    root.querySelector('[data-act="logout"]')?.addEventListener('click', () => void run(() => call('POST', `/api/admin/users/${u}/logout`), 'Auf allen Geräten abgemeldet'));
    root.querySelector('[data-act="reset-stats"]')?.addEventListener('click', () => {
      if (confirm(`Statistik, Medaillen und Spiel-XP von ${name} wirklich zurücksetzen?`)) void run(() => call('POST', `/api/admin/users/${u}/reset-stats`), 'Statistik zurückgesetzt');
    });
    root.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
      if (!confirm(`Account „${name}“ endgültig löschen? Das lässt sich nicht rückgängig machen.`)) return;
      void run(async () => {
        await call('DELETE', `/api/admin/users/${u}`);
        detail = null;
      }, 'Account gelöscht');
    });
  }

  function bindRouting(root: HTMLElement) {
    const d = draft!;
    const rerender = () => {
      const scroll = panel.scrollTop;
      root.innerHTML = routingHtml();
      bindRouting(root);
      panel.scrollTop = scroll;
    };
    root.querySelectorAll<HTMLInputElement>('[data-param]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const k = inp.dataset.param as keyof RoutingParams;
        if (inp.value === '' || Number(inp.value) === routing!.defaults[k]) delete d.params[k];
        else d.params[k] = Number(inp.value);
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-rmedit]').forEach((b) =>
      b.addEventListener('click', () => {
        d.edits.splice(Number(b.dataset.rmedit), 1);
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) =>
      b.addEventListener('click', () => {
        form.kind = b.dataset.kind as LineEdit['kind'];
        rerender();
      }),
    );
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((el) =>
      el.addEventListener('change', () => {
        const k = el.dataset.f as 'line' | 'at' | 'beyond' | 'pair' | 'min';
        if (k === 'min') form.min = Number(el.value);
        else if (k === 'line') {
          // Groß-/Kleinschreibung egal: „s40“ → S40
          const v = el.value.trim();
          form.line = net().lines.has(v) ? v : ([...net().lines.keys()].find((id) => id.toLowerCase() === v.toLowerCase()) ?? v);
          form.at = form.beyond = form.pair = '';
        } else form[k] = el.value;
        rerender();
      }),
    );
    root.querySelectorAll<HTMLInputElement>('[data-stop]').forEach((el) => el.addEventListener('change', () => (form.stops[Number(el.dataset.stop)].name = el.value)));
    root.querySelectorAll<HTMLInputElement>('[data-stopmin]').forEach((el) => el.addEventListener('change', () => (form.stops[Number(el.dataset.stopmin)].min = Number(el.value))));
    root.querySelectorAll<HTMLButtonElement>('[data-rmstop]').forEach((b) =>
      b.addEventListener('click', () => {
        form.stops.splice(Number(b.dataset.rmstop), 1);
        rerender();
      }),
    );
    root.querySelector('#adm-addstop')?.addEventListener('click', () => {
      form.stops.push({ name: '', min: 2 });
      rerender();
    });
    root.querySelector('#adm-addedit')?.addEventListener('click', () => {
      const e = editFromForm();
      if (typeof e === 'string') return toast(e);
      d.edits.push(e);
      Object.assign(form, { at: '', beyond: '', pair: '', stops: [{ name: '', min: 2 }] });
      rerender();
    });
    root.querySelector('#adm-discard')?.addEventListener('click', () => {
      draft = structuredClone({ params: routing!.overrides.params, edits: routing!.overrides.edits });
      void render();
    });
    const save = async (body: { params: Partial<RoutingParams>; edits: LineEdit[] }) => {
      try {
        routing = await call<RoutingAdminState>('PUT', '/api/admin/routing', body);
        draft = structuredClone({ params: routing.overrides.params, edits: routing.overrides.edits });
        toast('Gespeichert und angewendet – zum Ausprobieren im Spiel die Seite neu laden', 'info', { label: 'Neu laden', run: () => location.reload() });
        void render();
      } catch (e) {
        toast((e as Error).message);
      }
    };
    root.querySelector('#adm-save')?.addEventListener('click', () => void save(d));
    root.querySelector('#adm-defaults')?.addEventListener('click', () => {
      if (confirm('Alle Parameter und Linien-Änderungen auf den Standard zurücksetzen?')) void save({ params: {}, edits: [] });
    });
    root.querySelector('#adm-probe')?.addEventListener('click', async () => {
      probe.from = root.querySelector<HTMLInputElement>('#adm-from')!.value;
      probe.to = root.querySelector<HTMLInputElement>('#adm-to')!.value;
      probe.slot = root.querySelector<HTMLSelectElement>('#adm-slot')!.value as SlotId;
      const from = stationByName(probe.from);
      const to = stationByName(probe.to);
      if (!from || !to) return toast('Start und Ziel aus der Liste wählen.');
      const btn = root.querySelector<HTMLButtonElement>('#adm-probe')!;
      btn.disabled = true;
      btn.textContent = 'Rechnet …';
      try {
        probe.routes = await call<RouteOption[]>('POST', '/api/admin/routing/test', { from, to, slot: probe.slot });
      } catch (e) {
        toast((e as Error).message);
      }
      rerender();
    });
  }

  void render();
  return {
    destroy: () => {
      gen++;
      clearInterval(poll);
    },
  };
}
