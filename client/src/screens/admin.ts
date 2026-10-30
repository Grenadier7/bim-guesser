// Admin-Seite (nur für Accounts mit Admin-Recht – vergeben über die Kommandozeile; je Sitzung mit dem Passwort
// entsperrt): Übersicht mit Statistik und Lobbys, Accounts, Netzpläne, Einstellungen, Protokoll.
import type { AdminLobby, AdminLogEntry, AdminOverview, AdminStats, AdminUserDetail, AdminUserRow, AdminUserStats } from '../../../shared/types.ts';
import { adm, LockedError, setOnLocked } from '../admin/api.ts';
import { barChart, bindCharts, lineChart } from '../admin/charts.ts';
import { plansTab, type Tab as SubTab } from '../admin/plans.ts';
import { settingsTab } from '../admin/settings.ts';
import { app } from '../store.ts';
import { esc, toast } from '../ui.ts';
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
const phaseLabel = (p: string) => ({ lobby: 'wartet', playing: 'läuft', finished: 'fertig' })[p] ?? p;

export function adminScreen(panel: HTMLElement, onBack: () => void): Screen {
  let tab: Tab = 'overview';
  let locked = false;
  let query = '';
  let detail: string | null = null;
  let statDays = 7;
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
      if (!detail) return users(await adm<AdminUserRow[]>('GET', `/api/admin/users?q=${encodeURIComponent(query)}`));
      const [u, s] = await Promise.all([adm<AdminUserDetail>('GET', `/api/admin/users/${encodeURIComponent(detail)}`), adm<AdminUserStats>('GET', `/api/admin/users/${encodeURIComponent(detail)}/stats?days=90`)]);
      return userDetail(u, s);
    }
    return logHtml(await adm<AdminLogEntry[]>('GET', '/api/admin/log'));
  }

  // -------------------------------------------------------------- Entsperren

  function unlockHtml(): string {
    return `<form class="adm-unlock" id="adm-unlock"><p>🔒 Der Admin-Bereich ist gesperrt. Zum Entsperren bitte dein Passwort eingeben.</p>
      <label class="field"><span>Passwort</span><input type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn btn-primary">Entsperren</button>
      <p class="muted">Bleibt 30 Minuten nach der letzten Aktion offen, höchstens 8 Stunden.</p></form>`;
  }

  // -------------------------------------------------------------- Übersicht

  function overview(o: AdminOverview, s: AdminStats): string {
    const u = o.users;
    const card = (v: string | number, l: string) => `<div class="adm-card"><b>${v}</b><small>${l}</small></div>`;
    const fmtT = (t: number) =>
      statDays <= 2 ? new Date(t).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
    const pts = (f: 'online' | 'players') => s.samples.map((x) => ({ t: x.at, v: x[f] }));
    return `
      ${o.warnings.length ? `<div class="adm-warn">${o.warnings.map((w) => `⚠ ${esc(w)}`).join('<br>')}</div>` : ''}
      <div class="adm-cards">
        ${card(u.online, 'Accounts online')}${card(o.lobbies.length, 'Lobbys')}${card(o.activeGames, 'Spiele laufen')}${card(u.total, 'Accounts')}${card(u.new7d, 'neu (7 Tage)')}${card(u.withEmail, 'mit E-Mail')}${card(u.admins, 'Admins')}
      </div>
      <div class="adm-range">Zeitraum ${[1, 7, 30, 90].map((d) => `<button class="${d === statDays ? 'on' : ''}" data-days="${d}">${d === 1 ? '24 h' : `${d} Tage`}</button>`).join('')}</div>
      <div class="adm-charts">
        ${lineChart('online', 'Accounts online', pts('online'), fmtT)}
        ${lineChart('players', 'Spieler in Lobbys', pts('players'), fmtT)}
        ${barChart('games', 'Fertige Spiele je Tag', ['Routenjagd', 'Quiz'], s.days.map((d) => ({ label: dayLabel(d.day), values: [d.route, d.quiz] })))}
        ${barChart('users', 'Accounts je Tag', ['aktiv', 'neu'], s.days.map((d) => ({ label: dayLabel(d.day), values: [d.activeUsers, d.newUsers] })))}
      </div>
      <dl class="adm-facts">
        <dt>Version</dt><dd>${esc(o.version)} · läuft seit ${dur(o.uptimeSec)} · ${o.memoryMb} MB RAM</dd>
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

  function userDetail(u: AdminUserDetail, us: AdminUserStats): string {
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
      <div class="adm-charts">${barChart('user', 'Gespielt je Tag (90 Tage)', ['Routenjagd', 'Quiz', 'Training'], us.days.map((d) => ({ label: dayLabel(d.day), values: [d.route, d.quiz, d.training] })))}</div>
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
            toast((err as Error).message);
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
      b.addEventListener('click', () => {
        if (!confirm(`Lobby ${b.dataset.close} für alle beenden?`)) return;
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
    root.querySelectorAll<HTMLElement>('[data-user]').forEach((li) => {
      const open = () => {
        detail = li.dataset.user!;
        rerender();
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    });
    root.querySelector('#adm-list')?.addEventListener('click', () => ((detail = null), rerender()));
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
    root.querySelector('[data-act="reset-stats"]')?.addEventListener('click', () => {
      if (confirm(`Statistik, Medaillen und Spiel-XP von ${name} wirklich zurücksetzen?`)) void run(() => adm('POST', `/api/admin/users/${u}/reset-stats`), 'Statistik zurückgesetzt');
    });
    root.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
      if (!confirm(`Account „${name}“ endgültig löschen? Das lässt sich nicht rückgängig machen.`)) return;
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
