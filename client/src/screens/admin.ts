// Admin-Seite (nur für Accounts mit Admin-Recht – vergeben über die Kommandozeile; je Sitzung mit dem Passwort
// entsperrt): Übersicht mit Statistik und Lobbys, Accounts, Netzpläne, Einstellungen, Protokoll.
import type { AdminGuestDetail, AdminGuests, AdminLobby, AdminLogEntry, AdminOverview, AdminStats, AdminUserDetail, AdminUserRow, AdminUserStats } from '../../../shared/types.ts';
import { adm, LockedError, setOnLocked } from '../admin/api.ts';
import { barChart, bindCharts, lineChart, rankChart } from '../admin/charts.ts';
import { plansTab, type Tab as SubTab } from '../admin/plans.ts';
import { settingsTab } from '../admin/settings.ts';
import { openAccount } from '../accountui.ts';
import { COURSES } from '../learn/courses/list.ts';
import { app } from '../store.ts';
import { ask, esc, lineChip, toast } from '../ui.ts';
import { infoTip } from '../widgets.ts';
import { loadingHtml, type Screen } from './screen.ts';

type Tab = 'overview' | 'users' | 'plans' | 'settings' | 'log';

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
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
/** Tag (YYYY-MM-DD) als „heute“, „gestern“ oder Datum */
const shortDay = (d: string) => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' });
  const yesterday = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' });
  return d === today ? 'heute' : d === yesterday ? 'gestern' : new Date(`${d}T12:00:00Z`).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' });
};
const phaseLabel = (p: string) => ({ lobby: 'wartet', playing: 'läuft', finished: 'fertig' })[p] ?? p;
/** breite Grafiken nur, wenn Platz ist – am Handy wären Schrift und Linien sonst winzig */
const wide = () => (document.querySelector('.admin')?.clientWidth ?? innerWidth) >= 700;

export function adminScreen(panel: HTMLElement, onBack: () => void): Screen {
  let tab: Tab = 'overview';
  let locked = false;
  /** Passwort zu kurz für den Admin-Bereich → Hinweis mit Knopf zum Ändern */
  let weakPw = '';
  let query = '';
  let guestQuery = '';
  /** geöffneter Besucher ohne Account (Kurzkennung) */
  let guest: string | null = null;
  let detail: string | null = null;
  let statDays = 7;
  /** Accounts-Reiter: Accounts oder Besucher ohne Account */
  let people: 'accounts' | 'guests' = 'accounts';
  /** Zeitraum der Grafiken eines Accounts */
  let userDays = 90;
  /** geöffnete Lobby (Übersicht) – aktualisiert sich alle paar Sekunden */
  let lobbyCode: string | null = null;
  let gen = 0;
  const poll = setInterval(() => void refreshLobby(), 4000);
  const rerender = () => void render();
  const subtabs: Partial<Record<Tab, SubTab>> = { plans: plansTab(rerender), settings: settingsTab(rerender) };
  setOnLocked(() => {
    locked = true;
  });
  app.map.clear();
  panel.innerHTML = `<div class="admin">${loadingHtml('Lädt …')}</div>`;

  // -------------------------------------------------------------- Rahmen

  async function render() {
    const g = ++gen;
    const scroll = panel.scrollTop;
    let html: string;
    try {
      html = locked ? unlockHtml() : await body();
    } catch (e) {
      if (e instanceof LockedError) html = unlockHtml();
      else html = `<p class="err">${esc((e as Error).message)}</p>`;
    }
    if (g !== gen) return;
    const tabs: [Tab, string][] = [
      ['overview', '📊 Übersicht'],
      ['users', '👥 Accounts'],
      ['plans', '🧭 Netzpläne'],
      ['settings', '⚙️ Einstellungen'],
      ['log', '📜 Protokoll'],
    ];
    panel.innerHTML = `<div class="admin"><div class="adm-head"><button class="link" id="back">← Zurück</button>${locked ? '' : '<button class="link" id="adm-lock">🔒 Sperren</button>'}</div>
      <h2>🛠 Admin</h2>
      ${locked ? '' : `<div class="adm-tabs">${tabs.map(([t, l]) => `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${l}</button>`).join('')}</div>`}
      <div class="adm-body">${html}</div></div>`;
    panel.scrollTop = scroll;
    bindHead();
    bindBody();
  }

  function bindHead() {
    panel.querySelector('#back')!.addEventListener('click', onBack);
    panel.querySelector('#adm-lock')?.addEventListener('click', () =>
      void adm('POST', '/api/admin/lock')
        .catch(() => {})
        .finally(() => {
          locked = true;
          rerender();
        }),
    );
    panel.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.tab as Tab;
        detail = null;
        guest = null;
        lobbyCode = null;
        panel.scrollTop = 0;
        rerender();
      }),
    );
  }

  async function body(): Promise<string> {
    const sub = subtabs[tab];
    if (sub) return sub.html();
    if (tab === 'overview' && lobbyCode) {
      try {
        return lobbyHtml(await adm<AdminLobby>('GET', `/api/admin/lobbies/${lobbyCode}`));
      } catch (e) {
        if (e instanceof LockedError) throw e;
        toast(`Lobby ${lobbyCode} gibt es nicht mehr.`, 'info');
        lobbyCode = null;
      }
    }
    if (tab === 'overview') {
      const [o, s] = await Promise.all([adm<AdminOverview>('GET', '/api/admin/overview'), adm<AdminStats>('GET', `/api/admin/stats?days=${statDays}`)]);
      return overview(o, s);
    }
    if (tab === 'users') {
      if (!detail && people === 'guests' && guest) return guestDetail(await adm<AdminGuestDetail>('GET', `/api/admin/guests/${encodeURIComponent(guest)}?days=${Math.min(90, userDays)}`));
      if (!detail && people === 'guests') return peopleSwitch() + guests(await adm<AdminGuests>('GET', `/api/admin/guests?q=${encodeURIComponent(guestQuery)}`));
      if (!detail) return peopleSwitch() + users(await adm<AdminUserRow[]>('GET', `/api/admin/users?q=${encodeURIComponent(query)}`));
      const [u, s] = await Promise.all([
        adm<AdminUserDetail>('GET', `/api/admin/users/${encodeURIComponent(detail)}`),
        adm<AdminUserStats>('GET', `/api/admin/users/${encodeURIComponent(detail)}/stats?days=${userDays}`),
      ]);
      return userDetail(u, s);
    }
    return logHtml(await adm<AdminLogEntry[]>('GET', '/api/admin/log'));
  }

  // -------------------------------------------------------------- Entsperren

  function unlockHtml(): string {
    if (weakPw)
      return `<div class="adm-unlock"><p class="err">${esc(weakPw)}</p>
        <button class="btn btn-primary" id="adm-pw">Passwort jetzt ändern</button>
        <button class="link" id="adm-retry">Nochmal entsperren</button></div>`;
    return `<form class="adm-unlock" id="adm-unlock"><p>🔒 Der Admin-Bereich ist gesperrt. Zum Entsperren bitte dein Passwort eingeben.</p>
      <label class="field"><span>Passwort</span><input type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn btn-primary">Entsperren</button>
      <p class="muted">Bleibt 30 Minuten nach der letzten Aktion offen, höchstens 8 Stunden.</p></form>`;
  }

  // -------------------------------------------------------------- Übersicht

  function overview(o: AdminOverview, s: AdminStats): string {
    const u = o.users;
    const v = o.visitors;
    const card = (val: string | number, l: string, sub = '') => `<div class="adm-card"><b>${val}</b><small>${l}</small>${sub ? `<small class="adm-card-sub">${sub}</small>` : ''}</div>`;
    const fmtT = (t: number) =>
      statDays <= 2 ? new Date(t).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
    // gewählter Zeitraum – die Verlaufs-Grafiken zeigen ihn ganz, auch wenn es erst später Messwerte gibt
    const range: [number, number] = [Date.now() - statDays * 864e5, Date.now()];
    const fmtTip = (t: number) => new Date(t).toLocaleString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const pts = (f: 'online' | 'players' | 'visitors' | 'anon' | 'playing' | 'lobbies') => s.samples.map((x) => ({ t: x.at, v: x[f] }));
    // ab 2 Tagen sind die Verläufe verdichtet (je Stunde bzw. 3 Stunden der Höchstwert)
    const peak = statDays <= 2 ? '' : statDays > 30 ? ' (Höchstwert je 3 h)' : ' (Höchstwert je Stunde)';
    const period = statDays === 1 ? 'heute' : `letzte ${statDays} Tage`;
    const lineRow = (line: string) => {
      const l = app.net.lines.get(line);
      return lineChip(l?.mode ?? (/^(R|REX|CJX)\d/.test(line) ? 'S' : 'B'), line, l?.color ?? '#5b6170');
    };
    const sum = (f: (d: AdminStats['days'][number]) => number) => s.days.reduce((a, d) => a + f(d), 0);
    const lobbyGames = sum((d) => d.route + d.challenge + d.quiz);
    const multi = sum((d) => d.multi);
    const players = sum((d) => d.players);
    const courseTitle = (id: string) => {
      const c = COURSES.find((x) => x.id === id);
      return c ? `${c.icon} ${esc(c.title)}` : esc(id);
    };
    return `
      ${o.warnings.length ? `<div class="adm-warn">${o.warnings.map((w) => `⚠ ${esc(w)}`).join('<br>')}</div>` : ''}
      <div class="adm-cards">
        ${card(v.online, 'Besucher online', `${v.anon} ohne Account`)}${card(v.today, 'Besucher heute')}${card(o.activeGames, 'Spiele laufen', `${o.lobbies.length} Lobbys offen`)}
        ${card(u.total, 'Accounts', `${u.new7d} neu in 7 Tagen`)}${card(u.online, 'Accounts online')}${card(u.withEmail, 'mit E-Mail', u.total ? `${Math.round((u.withEmail / u.total) * 100)} %` : '')}
      </div>
      <div class="adm-range">Zeitraum ${[1, 7, 30, 90].map((d) => `<button class="${d === statDays ? 'on' : ''}" data-days="${d}">${d === 1 ? '24 h' : `${d} Tage`}</button>`).join('')}</div>
      <div class="adm-charts">
        ${lineChart('visitors', `Besucher online${peak}`, [{ name: 'alle', points: pts('visitors') }, { name: 'ohne Account', points: pts('anon') }], fmtT, wide(), fmtTip, range)}
        ${barChart('visits', 'Besucher je Tag', ['mit Account', 'ohne Account'], s.days.map((d) => ({ label: dayLabel(d.day), values: [d.visitors - d.anonVisitors, d.anonVisitors] })))}
        ${barChart('users', 'Accounts je Tag', ['gespielt, schon länger dabei', 'neu angelegt'], s.days.map((d) => ({ label: dayLabel(d.day), values: [d.returning, d.newUsers] })))}
        ${barChart(
          'games',
          'Gespielt je Tag',
          ['Routenjagd', 'Tages-Challenge', 'Quiz', 'Strecke des Tages', 'Training'],
          s.days.map((d) => ({ label: dayLabel(d.day), values: [d.route, d.challenge, d.quiz, d.daily, d.training] })),
          wide(),
          `<p class="muted adm-note">${
          lobbyGames
            ? `Lobby-Spiele (${period}): ${lobbyGames}, davon ${multi} mit mehreren Spielern (${Math.round((multi / lobbyGames) * 100)} %) · Ø ${(players / lobbyGames).toLocaleString('de-AT', { maximumFractionDigits: 1 })} Spieler je Spiel`
            : `Keine fertigen Lobby-Spiele (${period}).`
          }</p>`,
        )}
        ${lineChart('lobbies', `Lobbys und Spieler${peak}`, [{ name: 'Spieler verbunden', points: pts('players') }, { name: 'Spiele laufen', points: pts('playing') }], fmtT, wide(), fmtTip, range)}
        ${rankChart('Meistgewählte Linien', s.lines.slice(0, 15).map((l) => ({ label: lineRow(l.line), n: l.n })), period)}
        ${rankChart(
          'Lernpfad: Kurs abgeschlossen',
          s.courses.map((c) => ({ label: courseTitle(c.id), n: c.done, tip: `${c.done} Accounts abgeschlossen, ${c.mastered} gemeistert` })),
          `${s.learners} von ${u.total} Accounts mit mind. einem Kurs`,
          'Noch keine Daten.',
          true,
        )}
      </div>
      <dl class="adm-facts">
        <dt>Version</dt><dd>${esc(o.version)} · läuft seit ${dur(o.uptimeSec)} · ${o.memoryMb} MB RAM</dd>
        <dt>Admins</dt><dd>${u.admins}</dd>
        <dt>E-Mail</dt><dd>${o.mail ? '✔ eingerichtet („Passwort vergessen“ geht)' : '✖ aus – SMTP_URL fehlt (Links zum Zurücksetzen unter Accounts erzeugen)'}</dd>
        <dt>Fahrplan</dt><dd>${o.timetable.loaded ? `✔ eigener Referenzfahrplan, gültig bis ${esc(o.timetable.validUntil ?? '?')}` : '✖ aus – es wird die Online-Auskunft gefragt'}</dd>
      </dl>
      <h3>Lobbys</h3>
      ${
        o.lobbies.length
          ? `<ul class="adm-list">${o.lobbies
              .map(
                (l) => `<li><div><b class="mono">${esc(l.code)}</b> ${l.mode === 'quiz' ? '🧠 Quiz' : '🏁 Routenjagd'} · ${esc(phaseLabel(l.phase))}${l.progress ? ` · ${esc(l.progress)}` : ''} · aktiv ${ago(l.lastActivity)}
                  <div class="adm-players">${l.players.map((p) => `<span class="${p.connected ? 'on' : ''}">${esc(p.name)}${p.account ? ` <small>(${esc(p.account)})</small>` : ''}</span>`).join('')}</div></div>
                  <div class="adm-row"><button class="btn btn-ghost btn-small" data-lobby="${esc(l.code)}">Verwalten</button><button class="btn btn-ghost btn-small" data-close="${esc(l.code)}">Beenden</button></div></li>`,
              )
              .join('')}</ul>`
          : '<p class="muted">Gerade keine Lobby offen.</p>'
      }`;
  }

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
    if (tab !== 'overview' || !lobbyCode || locked) return;
    const typing = panel.querySelector<HTMLInputElement>('#adm-say input');
    if (typing && (typing.value || document.activeElement === typing)) return;
    try {
      const l = await adm<AdminLobby>('GET', `/api/admin/lobbies/${lobbyCode}`);
      const root = panel.querySelector<HTMLElement>('.adm-body');
      if (!root || tab !== 'overview' || lobbyCode !== l.code) return;
      root.innerHTML = lobbyHtml(l);
      bindBody();
    } catch {
      /* weg oder kurz nicht erreichbar – beim nächsten Klick merkt man es */
    }
  }

  // -------------------------------------------------------------- Accounts

  function peopleSwitch(): string {
    return `<div class="adm-range adm-people">${(
      [
        ['accounts', '👤 Accounts'],
        ['guests', '👻 Ohne Account'],
      ] as const
    )
      .map(([k, l]) => `<button class="${people === k ? 'on' : ''}" data-people="${k}">${l}</button>`)
      .join('')}</div>`;
  }

  function users(list: AdminUserRow[]): string {
    return `<input class="line-input" id="adm-q" placeholder="Name oder E-Mail suchen …" value="${esc(query)}" autocomplete="off" spellcheck="false">
      <ul class="adm-list adm-users">${
        list
          .map(
            (u) => `<li data-user="${esc(u.name)}" tabindex="0"><div><span class="online-dot ${u.online ? 'on' : ''}"></span><b>${esc(u.name)}</b>${u.admin ? ' <span class="adm-badge">Admin</span>' : ''}
              <small class="muted">${u.email ? esc(u.email) : 'keine E-Mail'}</small></div>
              <small>Lv ${u.level} · ${u.games} ${u.games === 1 ? 'Spiel' : 'Spiele'} · ${u.online ? 'online' : `zuletzt ${ago(u.lastSeen)}`}</small></li>`,
          )
          .join('') || '<li class="muted">Niemand gefunden.</li>'
      }</ul>`;
  }

  function guests(g: AdminGuests): string {
    const card = (val: string | number, l: string, sub = '') => `<div class="adm-card"><b>${val}</b><small>${l}</small>${sub ? `<small class="adm-card-sub">${sub}</small>` : ''}</div>`;
    const pct = (n: number) => (g.browsers ? `${Math.round((n / g.browsers) * 100)} %` : '');
    return `<div class="adm-cards">${card(g.online, 'gerade online')}${card(g.browsers, 'Browser in 90 Tagen')}${card(g.played, 'haben gespielt', pct(g.played))}${card(g.returning, 'an mehreren Tagen da', pct(g.returning))}${card(g.converted, 'haben inzwischen einen Account')}</div>
      ${
        g.inLobbies.length
          ? `<h3>Gerade in einer Lobby</h3><ul class="adm-list">${g.inLobbies
              .map(
                (p) => `<li><div><span class="online-dot ${p.connected ? 'on' : ''}"></span><b>${esc(p.name)}</b> <small class="muted">${p.mode === 'quiz' ? '🧠 Quiz' : '🏁 Routenjagd'} · ${esc(phaseLabel(p.phase))}</small></div>
                  <button class="link mono" data-globby="${esc(p.lobby)}">${esc(p.lobby)}</button></li>`,
              )
              .join('')}</ul>`
          : ''
      }
      <input class="line-input" id="adm-q" placeholder="Name suchen …" value="${esc(guestQuery)}" autocomplete="off" spellcheck="false">
      <ul class="adm-list adm-users">${
        g.list
          .map(
            (x) => `<li data-guest="${esc(x.id)}" tabindex="0"><div><span class="online-dot ${x.online ? 'on' : ''}"></span>${x.name ? `<b>${esc(x.name)}</b>` : '<b class="muted">ohne Namen</b>'}
              <small class="muted mono">${esc(x.id)}</small></div>
              <small>${x.games} ${x.games === 1 ? 'Spiel' : 'Spiele'} · an ${x.days} ${x.days === 1 ? 'Tag' : 'Tagen'} da · ${x.online ? 'online' : `zuletzt ${shortDay(x.last)}`}</small></li>`,
          )
          .join('') || `<li class="muted">${guestQuery ? 'Niemand gefunden.' : 'Noch keine Besuche ohne Account.'}</li>`
      }</ul>
      <p class="muted adm-note">Ohne Account kennt der Server nur eine zufällige Kennung je Browser, die Tage, an denen sie da war, den zuletzt verwendeten Spielernamen und was damit gespielt wurde (90 Tage). Höchstens 100, zuletzt da zuerst.</p>`;
  }

  function guestDetail(x: AdminGuestDetail): string {
    const g = x.games;
    const total = g.route + g.challenge + g.quiz + g.daily + g.training;
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const fmtD = (t: number) => new Date(t).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
    const roundPts = x.days.filter((d) => d.avgRoute != null).map((d) => ({ t: Date.parse(`${d.day}T12:00:00Z`), v: d.avgRoute! }));
    const range: [number, number] = [Date.parse(`${x.days[0].day}T00:00:00Z`), Date.parse(`${x.days[x.days.length - 1].day}T23:59:00Z`)];
    const lineRow = (line: string) => {
      const l = app.net.lines.get(line);
      return lineChip(l?.mode ?? (/^(R|REX|CJX)\d/.test(line) ? 'S' : 'B'), line, l?.color ?? '#5b6170');
    };
    const visitedOnly = x.days.filter((d) => d.visited && !(d.route + d.challenge + d.quiz + d.daily + d.training)).length;
    return `<button class="link" id="adm-glist">← alle ohne Account</button>
      <div class="profile-head"><h3><span class="online-dot ${x.online ? 'on' : ''}"></span>${x.name ? esc(x.name) : '<span class="muted">ohne Namen</span>'} <small class="muted mono">${esc(x.id)}</small></h3></div>
      <dl class="adm-facts">
        <dt>Name</dt><dd>${x.name ? `${esc(x.name)} <small class="muted">(zuletzt verwendet)</small>` : '<span class="muted">nie einen Namen eingegeben</span>'}</dd>
        <dt>Erstmals da</dt><dd>${shortDay(x.first)}</dd>
        <dt>Zuletzt da</dt><dd>${x.online ? 'gerade online' : shortDay(x.last)}</dd>
        <dt>Besuche</dt><dd>an ${plural(x.visitDays, 'Tag', 'Tagen')}${visitedOnly ? ` <small class="muted">(davon ${visitedOnly} nur geschaut, im Zeitraum)</small>` : ''}</dd>
        ${x.hasAccount ? '<dt>Account</dt><dd>derselbe Browser war auch schon mit Account da</dd>' : ''}
        <dt>Gespielt</dt><dd>${
          total
            ? `${plural(g.route, 'Routenjagd', 'Routenjagden')} (${plural(g.wins, 'Sieg', 'Siege')}) · ${plural(g.challenge, 'Tages-Challenge', 'Tages-Challenges')} · ${g.quiz} Quiz (${plural(g.quizWins, 'Sieg', 'Siege')}) · ${g.daily}× Strecke des Tages · ${g.training} Training`
            : '<span class="muted">noch nichts</span>'
        }</dd>
        <dt>Routen</dt><dd>${x.rounds ? `${plural(x.rounds.n, 'Runde', 'Runden')} · Ø ${x.rounds.avg} Punkte · bestes Ergebnis ${x.rounds.best} · ${x.rounds.perfect} perfekt` : '<span class="muted">noch keine Runde</span>'}</dd>
        <dt>In Öffis unterwegs</dt><dd>${x.minutes ? (x.minutes < 60 ? `${x.minutes} min` : `${Math.floor(x.minutes / 60).toLocaleString('de-AT')} h ${x.minutes % 60} min`) : '–'} <small class="muted">(eigene Routen)</small></dd>
      </dl>
      <div class="adm-range">Zeitraum ${[30, 90].map((d) => `<button class="${d === Math.min(90, userDays) ? 'on' : ''}" data-udays="${d}">${d} Tage</button>`).join('')}</div>
      <div class="adm-charts">
        ${barChart(
          'guest',
          'Gespielt je Tag',
          ['Routenjagd', 'Tages-Challenge', 'Quiz', 'Strecke des Tages', 'Training'],
          x.days.map((d) => ({ label: dayLabel(d.day), values: [d.route, d.challenge, d.quiz, d.daily, d.training] })),
          wide(),
        )}
        ${
          roundPts.length
            ? lineChart('guest-route', 'Ø Routenpunkte je Tag', [{ name: 'Ø Punkte', points: roundPts }], fmtD, false, (t) => new Date(t).toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' }), range, {
                last: 'zuletzt',
                late: false,
                max: 1300,
              })
            : `<figure class="chart"><figcaption>Ø Routenpunkte je Tag</figcaption><p class="muted ch-empty">Keine Routenjagd-Runde in diesem Zeitraum.</p></figure>`
        }
        ${rankChart('Meistgenutzte Linien', x.lines.map((l) => ({ label: lineRow(l.line), n: l.n, tip: `${l.n}-mal gefahren` })), 'alle Spiele', 'Noch keine Linien gefahren.')}
      </div>
      <div class="adm-actions"><div class="adm-row"><button class="btn btn-danger" id="adm-gdel">Daten dieses Browsers löschen</button> ${infoTip('Löscht Besuche, Namen und Spielergebnisse dieses Browsers. Kommt er wieder, beginnt alles neu.')}</div></div>`;
  }

  function userDetail(u: AdminUserDetail, us: AdminUserStats): string {
    const s = u.stats;
    const dataKb = Object.values(u.data).reduce((a, b) => a + b, 0) / 1024;
    const done = us.courses.filter((c) => c.done);
    const course = (id: string) => COURSES.find((c) => c.id === id);
    const lineRow = (line: string) => {
      const l = app.net.lines.get(line);
      return lineChip(l?.mode ?? (/^(R|REX|CJX)\d/.test(line) ? 'S' : 'B'), line, l?.color ?? '#5b6170');
    };
    const fmtD = (t: number) => new Date(t).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
    const roundPts = us.days.filter((d) => d.avgRoute != null).map((d) => ({ t: Date.parse(`${d.day}T12:00:00Z`), v: d.avgRoute! }));
    const range: [number, number] = [Date.parse(`${us.days[0].day}T00:00:00Z`), Date.parse(`${us.days[us.days.length - 1].day}T23:59:00Z`)];
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return `<button class="link" id="adm-list">← alle Accounts</button>
      <div class="profile-head"><h3><span class="online-dot ${u.online ? 'on' : ''}"></span>${esc(u.name)}${u.admin ? ' <span class="adm-badge">Admin</span>' : ''}</h3></div>
      <dl class="adm-facts">
        <dt>E-Mail</dt><dd>${u.email ? esc(u.email) : '<span class="muted">keine</span>'}</dd>
        <dt>Dabei seit</dt><dd>${date(u.created)}</dd>
        <dt>Zuletzt da</dt><dd>${u.online ? 'gerade online' : `${ago(u.lastSeen)} (${date(u.lastSeen)})`}</dd>
        <dt>Angemeldet auf</dt><dd>${plural(u.sessions, 'Gerät', 'Geräten')}</dd>
        <dt>Level</dt><dd>${u.level} · ${u.xp.toLocaleString('de-AT')} XP</dd>
        <dt>Gespielt</dt><dd>${plural(s.games, 'Routenjagd', 'Routenjagden')} (${plural(s.wins, 'Sieg', 'Siege')}) · ${s.quizGames} Quiz (${plural(s.quizWins, 'Sieg', 'Siege')}) · ${us.daily}× Strecke des Tages · ${plural(us.challenges, 'Tages-Challenge', 'Tages-Challenges')} · ${s.trainings} Training</dd>
        <dt>Routen</dt><dd>${s.rounds ? `${plural(s.rounds, 'Runde', 'Runden')} · Ø ${s.avgRoute} Punkte · bestes Ergebnis ${s.bestRound} · ${s.perfectRounds} perfekt` : '<span class="muted">noch keine Runde</span>'}</dd>
        <dt>In Öffis unterwegs</dt><dd>${s.minutes ? (s.minutes < 60 ? `${s.minutes} min` : `${Math.floor(s.minutes / 60).toLocaleString('de-AT')} h ${s.minutes % 60} min`) : '–'} <small class="muted">(eigene Routen)</small></dd>
        <dt>Lernpfad</dt><dd>${done.length} von ${us.courses.length} Kursen${s.coursesMastered ? ` (${s.coursesMastered} gemeistert)` : ''}${
          done.length ? `<br><small>${done.map((c) => `${course(c.id)?.icon ?? ''} ${esc(course(c.id)?.title ?? c.id)}${c.mastered ? ' ★' : ''}`).join(' · ')}</small>` : ''
        }</dd>
        <dt>Medaillen</dt><dd>${u.medals.filter((m) => m.tier).map((m) => `<span title="${esc(m.title)}${m.tiers > 1 ? ` · Stufe ${m.tier}` : ''}">${m.icon}</span>`).join(' ') || '–'}</dd>
        <dt>Freunde</dt><dd>${u.friends.map(esc).join(', ') || '–'}${u.incoming.length ? ` · Anfragen von ${u.incoming.map(esc).join(', ')}` : ''}${u.outgoing.length ? ` · angefragt: ${u.outgoing.map(esc).join(', ')}` : ''}</dd>
        <dt>Gespeicherter Spielstand</dt><dd>${dataKb ? `${dataKb.toLocaleString('de-AT', { maximumFractionDigits: 1 })} KB` : '–'}</dd>
      </dl>
      <div class="adm-range">Zeitraum ${[30, 90, 365].map((d) => `<button class="${d === userDays ? 'on' : ''}" data-udays="${d}">${d === 365 ? '1 Jahr' : `${d} Tage`}</button>`).join('')}</div>
      <div class="adm-charts">
        ${barChart(
          'user',
          'Gespielt je Tag',
          ['Routenjagd', 'Quiz', 'Strecke des Tages', 'Training'],
          us.days.map((d) => ({ label: dayLabel(d.day), values: [d.route, d.quiz, d.daily, d.training] })),
          wide(),
          '',
          // dieselben Farben wie in der Übersicht (dort Tages-Challenge an 2. Stelle)
          [0, 2, 3, 4],
        )}
        ${
          roundPts.length
            ? lineChart('user-route', 'Ø Routenpunkte je Tag', [{ name: 'Ø Punkte', points: roundPts }], fmtD, false, (t) => new Date(t).toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' }), range, {
                last: 'zuletzt',
                late: false,
                max: 1300,
              })
            : `<figure class="chart"><figcaption>Ø Routenpunkte je Tag</figcaption><p class="muted ch-empty">Keine Routenjagd-Runde in diesem Zeitraum.</p></figure>`
        }
        ${rankChart(
          'Meistgenutzte Linien',
          us.lines.map((l) => ({ label: lineRow(l.line), n: l.n, tip: `${l.n}-mal gefahren` })),
          'alle Spiele',
          'Noch keine Linien gefahren.',
        )}
      </div>
      ${
        u.admin
          ? '<p class="muted">Admin-Accounts lassen sich hier nicht ändern – nur über die Kommandozeile am Server (Rechte nehmen mit „revoke“).</p>'
          : `<div class="adm-actions">
        <form data-act="password"><label class="field"><span>Neues Passwort setzen ${infoTip('Meldet den Account auf allen Geräten ab. Das Passwort dann persönlich weitergeben.')}</span>
          <input name="v" type="text" minlength="8" required autocomplete="off" placeholder="mind. 8 Zeichen"></label><button class="btn btn-ghost">Setzen</button></form>
        <div><button class="btn btn-ghost" data-act="reset-link">🔗 Link zum Zurücksetzen erzeugen</button> ${infoTip('Gilt 1 Stunde. Zum Weitergeben, wenn keine E-Mail ankommt – die Person legt damit selbst ein neues Passwort fest.')}
          <div id="adm-link"></div></div>
        <form data-act="name"><label class="field"><span>Umbenennen</span><input name="v" value="${esc(u.name)}" required minlength="3" maxlength="20"></label><button class="btn btn-ghost">Speichern</button></form>
        <form data-act="email"><label class="field"><span>E-Mail <small class="muted">(leer = entfernen)</small></span><input name="v" type="email" value="${esc(u.email ?? '')}"></label><button class="btn btn-ghost">Speichern</button></form>
        <div class="adm-row">
          <button class="btn btn-ghost" data-act="logout">Auf allen Geräten abmelden</button>
          <button class="btn btn-ghost" data-act="reset-stats">Statistik zurücksetzen</button>
          <button class="btn btn-danger" data-act="delete">Account löschen</button>
        </div>
      </div>`
      }`;
  }

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
    } catch (e) {
      if (!(e instanceof LockedError)) toast((e as Error).message);
    }
    rerender();
  };

  function bindBody() {
    const root = panel.querySelector<HTMLElement>('.adm-body')!;
    root.querySelector('#adm-pw')?.addEventListener('click', () => openAccount('settings'));
    root.querySelector('#adm-retry')?.addEventListener('click', () => ((weakPw = ''), rerender()));
    const unlock = root.querySelector<HTMLFormElement>('#adm-unlock');
    if (unlock) {
      unlock.querySelector<HTMLInputElement>('input[type=password]')!.focus();
      unlock.addEventListener('submit', (e) => {
        e.preventDefault();
        const pw = (unlock.elements.namedItem('password') as HTMLInputElement).value;
        void (async () => {
          try {
            await adm('POST', '/api/admin/unlock', { password: pw });
            locked = false;
          } catch (err) {
            const m = (err as Error).message;
            if (/mindestens \d+ Zeichen/.test(m)) weakPw = m;
            else toast(m);
          }
          rerender();
        })();
      });
      return;
    }
    const sub = subtabs[tab];
    if (sub) return sub.bind(root);
    bindCharts(root);
    root.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((b) => b.addEventListener('click', () => ((statDays = Number(b.dataset.days)), rerender())));
    // Übersicht und Lobby
    root.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await ask(`Lobby ${b.dataset.close} für alle beenden?`, { ok: 'Beenden', danger: true }))) return;
        void run(async () => {
          await adm('POST', `/api/admin/lobbies/${b.dataset.close}/close`);
          lobbyCode = null;
        }, 'Lobby beendet');
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-lobby]').forEach((b) => b.addEventListener('click', () => ((lobbyCode = b.dataset.lobby!), rerender())));
    root.querySelector('#adm-lobbies')?.addEventListener('click', () => ((lobbyCode = null), rerender()));
    const lobbyPost = (path: string, body: object, ok: string) => run(() => adm('POST', `/api/admin/lobbies/${lobbyCode}/${path}`, body), ok);
    root.querySelectorAll<HTMLButtonElement>('[data-lact]').forEach((b) => b.addEventListener('click', () => void lobbyPost(b.dataset.lact!, {}, '')));
    root.querySelectorAll<HTMLButtonElement>('[data-host]').forEach((b) => b.addEventListener('click', () => void lobbyPost('host', { playerId: b.dataset.host, on: b.dataset.on === '1' }, '')));
    root.querySelectorAll<HTMLButtonElement>('[data-kick]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (await ask(`${b.dataset.name} aus der Lobby entfernen?`, { ok: 'Entfernen', danger: true })) void lobbyPost('kick', { playerId: b.dataset.kick }, `${b.dataset.name} entfernt`);
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
        if (people === 'guests') guestQuery = q.value;
        else query = q.value;
        void render().then(() => {
          const n = panel.querySelector<HTMLInputElement>('#adm-q');
          n?.focus();
          n?.setSelectionRange(n.value.length, n.value.length);
        });
      }, 250);
    });
    root.querySelectorAll<HTMLElement>('[data-user]').forEach((li) => {
      const open = () => {
        detail = li.dataset.user!;
        rerender();
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    });
    root.querySelector('#adm-list')?.addEventListener('click', () => ((detail = null), rerender()));
    root.querySelectorAll<HTMLElement>('[data-guest]').forEach((li) => {
      const open = () => {
        guest = li.dataset.guest!;
        panel.scrollTop = 0;
        rerender();
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    });
    root.querySelector('#adm-glist')?.addEventListener('click', () => ((guest = null), rerender()));
    root.querySelector('#adm-gdel')?.addEventListener('click', async () => {
      if (!guest || !(await ask('Alle Daten dieses Browsers (Besuche, Name, Spielergebnisse) löschen?', { ok: 'Löschen', danger: true }))) return;
      const id = guest;
      void run(async () => {
        await adm('DELETE', `/api/admin/guests/${encodeURIComponent(id)}`);
        guest = null;
      }, 'Gelöscht');
    });
    root.querySelectorAll<HTMLButtonElement>('[data-people]').forEach((b) => b.addEventListener('click', () => ((people = b.dataset.people as typeof people), (guest = null), rerender())));
    root.querySelectorAll<HTMLButtonElement>('[data-globby]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = 'overview';
        lobbyCode = b.dataset.globby!;
        panel.scrollTop = 0;
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-udays]').forEach((b) => b.addEventListener('click', () => ((userDays = Number(b.dataset.udays)), rerender())));
    if (detail) bindUser(root, detail);
  }

  function bindUser(root: HTMLElement, name: string) {
    const u = encodeURIComponent(name);
    root.querySelectorAll<HTMLFormElement>('form[data-act]').forEach((f) =>
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = (f.elements.namedItem('v') as HTMLInputElement).value;
        if (f.dataset.act === 'password') void run(() => adm('POST', `/api/admin/users/${u}/password`, { password: v }), 'Passwort gesetzt – auf allen Geräten abgemeldet');
        if (f.dataset.act === 'email') void run(() => adm('PUT', `/api/admin/users/${u}/email`, { email: v }), 'E-Mail gespeichert');
        if (f.dataset.act === 'name')
          void run(async () => {
            detail = (await adm<{ name: string }>('PUT', `/api/admin/users/${u}/name`, { name: v })).name;
          }, 'Umbenannt');
      }),
    );
    root.querySelector('[data-act="reset-link"]')?.addEventListener('click', async () => {
      try {
        const { link } = await adm<{ link: string }>('POST', `/api/admin/users/${u}/reset-link`);
        const box = root.querySelector<HTMLElement>('#adm-link')!;
        box.innerHTML = `<input class="adm-linkbox" readonly value="${esc(link)}"><button class="btn btn-ghost btn-small" id="adm-copy">Kopieren</button><small class="muted">gilt 1 Stunde</small>`;
        box.querySelector('#adm-copy')!.addEventListener('click', () => void navigator.clipboard.writeText(link).then(() => toast('Link kopiert', 'info')));
      } catch (e) {
        toast((e as Error).message);
      }
    });
    root.querySelector('[data-act="logout"]')?.addEventListener('click', () => void run(() => adm('POST', `/api/admin/users/${u}/logout`), 'Auf allen Geräten abgemeldet'));
    root.querySelector('[data-act="reset-stats"]')?.addEventListener('click', async () => {
      if (await ask(`Statistik, Medaillen und Spiel-XP von ${name} wirklich zurücksetzen?`, { ok: 'Zurücksetzen', danger: true })) void run(() => adm('POST', `/api/admin/users/${u}/reset-stats`), 'Statistik zurückgesetzt');
    });
    root.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      if (!(await ask(`Account „${name}“ endgültig löschen? Das lässt sich nicht rückgängig machen.`, { ok: 'Endgültig löschen', danger: true }))) return;
      void run(async () => {
        await adm('DELETE', `/api/admin/users/${u}`);
        detail = null;
      }, 'Account gelöscht');
    });
  }

  // gleich zu Beginn: gesperrt? (dann Passwort-Abfrage statt Inhalt)
  void adm<{ admin: boolean; unlocked: boolean }>('GET', '/api/admin/status')
    .then((s) => {
      locked = !s.unlocked;
    })
    .catch(() => {})
    .finally(rerender);
  return {
    destroy: () => {
      gen++;
      clearInterval(poll);
    },
  };
}
