// Account-Oberfläche: Knopf in der Kopfzeile, Account-Fenster (Anmelden/Registrieren/Passwort vergessen, Profil mit
// Level, Medaillen und Statistik, Leute, Freunde, Einstellungen), Einladungs-Banner und „Freunde einladen“.
// Das Fenster liegt über allem – so geht es auch mitten in einer Lobby auf, ohne sie zu verlassen.
import type { AccountStats, FavoriteLine, LevelInfo, MedalPublic, Profile, UserListItem } from '../../shared/types.ts';
import { account, accountApi, deleteAccount, newMedals, signedIn, signOut } from './account.ts';
import { api } from './api.ts';
import { app, endSession, savePrefs, startSession } from './store.ts';
import { esc, h, lineChip, toast } from './ui.ts';
import { icon } from './icons.ts';

type Tab = 'login' | 'register' | 'forgot' | 'reset' | 'profile' | 'people' | 'friends' | 'settings' | 'privacy';

const sheet = h('div', { class: 'acct-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Account' });
sheet.hidden = true;
document.body.append(sheet);
let tab: Tab = 'login';
let viewing: string | null = null;
let resetToken: string | null = null;
let peopleQuery = '';

// ---------------------------------------------------------------- Öffnen / Schließen

export function openAccount(t?: Tab, profileName: string | null = null) {
  tab = t ?? (account.me ? 'profile' : 'login');
  viewing = profileName;
  sheet.hidden = false;
  document.body.classList.add('acct-open');
  void render();
}

function close() {
  sheet.hidden = true;
  document.body.classList.remove('acct-open');
}

sheet.addEventListener('click', (e) => e.target === sheet && close());
document.addEventListener('keydown', (e) => e.key === 'Escape' && !sheet.hidden && close());

// ---------------------------------------------------------------- Bausteine

function levelBar(l: LevelInfo): string {
  const pct = Math.round(((l.xp - l.levelXp) / Math.max(1, l.nextXp - l.levelXp)) * 100);
  return `<div class="lvl"><span class="lvl-badge">Lv ${l.level}</span><div class="lvl-bar" role="progressbar" aria-label="Fortschritt bis Level ${l.level + 1}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <small>${l.xp - l.levelXp} / ${l.nextXp - l.levelXp} XP bis Level ${l.level + 1}</small></div>`;
}

function medalsHtml(ms: MedalPublic[]): string {
  const got = ms.filter((m) => m.at).length;
  return `<h4>🏅 Medaillen <small class="muted">${got} von ${ms.length}</small></h4>
    <div class="medals">${[...ms]
      .sort((a, b) => Number(!!b.at) - Number(!!a.at))
      .map(
        (m) =>
          `<div class="medal ${m.at ? 'on' : 'locked'}" title="${m.at ? '' : 'noch nicht erreicht: '}${esc(m.text)}${m.at ? ` – ${new Date(m.at).toLocaleDateString('de-AT')}` : ''}"><span>${m.icon}</span><b>${esc(m.title)}</b><small>${esc(m.text)}</small></div>`,
      )
      .join('')}</div>`;
}

const favChip = (f: FavoriteLine | null, label: string) =>
  `<div class="fav"><small>${label}</small>${f ? `${lineChip(f.mode, f.id, f.color)}<small class="muted">${f.count}×</small>` : '<small class="muted">–</small>'}</div>`;

function statsHtml(s: AccountStats): string {
  const tile = (v: string | number, t: string) => `<div class="stat"><b>${typeof v === 'number' ? v.toLocaleString('de-AT') : v}</b><small>${t}</small></div>`;
  const kind = { game: '🏁 Routenjagd', quiz: '🧠 Quiz', training: '🏋️ Training' };
  return `<h4>📊 Statistik</h4>
    <div class="stats">
      ${tile(s.games, 'Routenjagden')}${tile(s.wins, 'Siege')}${tile(s.rounds, 'Runden')}${tile(s.avgRoute, 'Ø Routenpunkte')}
      ${tile(s.bestRound, 'beste Runde')}${tile(s.perfectRounds, 'Volltreffer')}${tile(s.beatApi, 'besser als Auskunft')}${tile(s.quizGames, 'Quiz-Spiele')}
      ${tile(s.trainings, 'Trainingsstrecken')}${tile(`${Math.round(s.minutes / 60)} h`, 'in Öffis unterwegs')}${tile(`${s.coursesDone}/9`, 'Kurse')}${tile(s.coursesMastered, 'gemeistert')}
    </div>
    <h4>❤️ Lieblinge</h4>
    <div class="favs">${favChip(s.favorites.U, 'U-Bahn')}${favChip(s.favorites.S, 'S-Bahn')}${favChip(s.favorites.T, 'Bim')}${favChip(s.favorites.B, 'Bus')}
      <div class="fav"><small>Station</small>${s.favoriteStation ? `<b>${esc(s.favoriteStation.name)}</b><small class="muted">${s.favoriteStation.count}× umgestiegen</small>` : '<small class="muted">–</small>'}</div></div>
    ${
      s.recent.length
        ? `<h4>🕒 Zuletzt</h4><ul class="recent">${s.recent
            .map(
              (r) =>
                `<li><span>${kind[r.kind]}</span><small class="muted">${new Date(r.at).toLocaleDateString('de-AT')}</small><span>${
                  r.kind === 'training' ? (r.points ? '👍 schnell' : '✓') : `${r.points.toLocaleString('de-AT')} Pkt.${r.rank && r.players && r.players > 1 ? ` · ${r.rank}. von ${r.players}` : ''}`
                }</span></li>`,
            )
            .join('')}</ul>`
        : ''
    }`;
}

/** Knopf passend zur Beziehung (Freund hinzufügen, Anfrage annehmen …) */
function relationButton(name: string, rel: UserListItem['relation']): string {
  const n = esc(name);
  if (rel === 'self') return '';
  if (rel === 'friend') return `<button class="btn btn-ghost btn-sm" data-unfriend="${n}" title="Freundschaft beenden">✓ Freunde</button>`;
  if (rel === 'incoming') return `<button class="btn btn-primary btn-sm" data-befriend="${n}">Annehmen</button><button class="btn btn-ghost btn-sm" data-unfriend="${n}">Ablehnen</button>`;
  if (rel === 'outgoing') return `<button class="btn btn-ghost btn-sm" data-unfriend="${n}" title="Anfrage zurückziehen">Angefragt ✕</button>`;
  return account.me ? `<button class="btn btn-ghost btn-sm" data-befriend="${n}">+ Freund</button>` : '';
}

const userRow = (u: UserListItem) =>
  `<li><button class="link user-link" data-profile="${esc(u.name)}"><span class="online-dot ${u.online ? 'on' : ''}" title="${u.online ? 'gerade online' : 'offline'}"></span>${esc(u.name)}</button>
    <span class="lvl-badge small">Lv ${u.level}</span><span class="row-actions">${relationButton(u.name, u.relation)}</span></li>`;

// ---------------------------------------------------------------- Inhalt

/** Datenschutz-Hinweis – kurz und in normaler Sprache */
/** Kontakt und ob Reset-Mails gehen – ändert sich nur mit einem Neustart des Servers, also einmal holen */
let serverInfoP: Promise<{ contact: string | null; mail: boolean }> | null = null;
function serverInfo() {
  serverInfoP ??= accountApi.privacy().catch(() => ((serverInfoP = null), { contact: null, mail: false }));
  return serverInfoP;
}

async function privacyHtml(): Promise<string> {
  const p = await serverInfo();
  return `<div class="privacy">
    <h4>Ohne Account</h4>
    <p>Einstellungen, Lernstand und Tutorial bleiben nur in deinem Browser. Am Server gibt es dazu nichts. Dein Spielname ist nur in der Lobby sichtbar, solange sie besteht.
      Kein Tracking, keine Werbung, keine Analyse-Dienste.</p>
    <h4>Mit Account wird gespeichert</h4>
    <ul>
      <li><b>Benutzername</b> und <b>Passwort</b> – das Passwort nur verschlüsselt (Argon2), niemand kann es lesen.</li>
      <li><b>E-Mail</b> (freiwillig) – nur für „Passwort vergessen“, nie sichtbar für andere.</li>
      <li>Dein <b>Spielstand</b>: Lernfortschritt, Einstellungen, Tutorial – damit er auf allen Geräten gleich ist.</li>
      <li><b>Statistik</b>: Spiele, Punkte, Medaillen, Lieblingslinien, Freundschaften und Einladungen, wann du zuletzt online warst.</li>
    </ul>
    <h4>Wer sieht was?</h4>
    <p>Alle: Name, Level, Medaillen und seit wann du dabei bist. Nur Freunde: Statistik, Lieblingslinien und ob du gerade online bist.</p>
    <h4>Cookie</h4>
    <p>Ein einziges Cookie (<code>bg_sid</code>) hält dich angemeldet – technisch nötig, kein Tracking. Es verschwindet beim Abmelden.</p>
    <h4>Wo liegen die Daten?</h4>
    <p>Auf dem Server des Betreibers von BimGuesser. Die Verbindung läuft verschlüsselt über den Tunnel-Dienst ngrok.${p.mail ? ' E-Mails zum Zurücksetzen des Passworts werden über einen E-Mail-Anbieter verschickt.' : ''}
      Die Kartenbilder kommen von Esri bzw. OpenStreetMap – dein Browser lädt sie direkt von dort.</p>
    <h4>Löschen</h4>
    <p>Unter ⚙️ kannst du deinen Account jederzeit selbst löschen – alles oben Genannte ist dann sofort weg.</p>
    ${p.contact ? `<h4>Fragen?</h4><p>Schreib an <a href="mailto:${esc(p.contact)}">${esc(p.contact)}</a>.</p>` : ''}
  </div>`;
}

async function body(): Promise<string> {
  const me = account.me;
  if (tab === 'privacy') return `<button class="link" data-tab="${me ? 'settings' : 'register'}">← zurück</button>${await privacyHtml()}`;
  if (viewing) {
    const p: Profile = await accountApi.profile(viewing);
    return `<button class="link" data-back>← zurück</button>
      <div class="profile-head"><h3><span class="online-dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}</h3><span class="row-actions">${relationButton(p.name, p.relation)}</span></div>
      <small class="muted">dabei seit ${new Date(p.created).toLocaleDateString('de-AT')}</small>
      ${levelBar(p.level)}${medalsHtml(p.medals)}
      ${p.stats ? statsHtml(p.stats) : `<p class="muted">Statistik und Lieblingslinien sehen nur Freunde.</p>`}`;
  }
  if (!me) {
    if (tab === 'register')
      return `<form class="acct-form" data-form="register">
        <label class="field"><span>Benutzername</span><input name="name" required minlength="3" maxlength="20" autocomplete="username" value="${esc(app.prefs.name)}"></label>
        <label class="field"><span>E-Mail <small class="muted">(optional – nur für „Passwort vergessen“)</small></span><input name="email" type="email" maxlength="120" autocomplete="email"></label>
        <label class="field"><span>Passwort <small class="muted">(mind. 8 Zeichen)</small></span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
        <button class="btn btn-primary btn-big">Account erstellen</button>
        <p class="muted">Dein Lernstand, Tutorial und Einstellungen aus diesem Browser werden übernommen.</p></form>
        <p class="muted"><button type="button" class="link" data-tab="privacy">Datenschutz – was gespeichert wird</button></p>`;
    if (tab === 'forgot')
      return `<form class="acct-form" data-form="forgot">
        <p>Wir schicken dir einen Link zum Zurücksetzen – an die E-Mail-Adresse deines Accounts.</p>
        <label class="field"><span>E-Mail</span><input name="email" type="email" required autocomplete="email"></label>
        <button class="btn btn-primary">Link schicken</button></form>`;
    if (tab === 'reset')
      return `<form class="acct-form" data-form="reset">
        <p>Neues Passwort festlegen:</p>
        <label class="field"><span>Neues Passwort <small class="muted">(mind. 8 Zeichen)</small></span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
        <button class="btn btn-primary">Speichern und anmelden</button></form>`;
    const srv = await serverInfo();
    const forgot = srv.mail
      ? '<button type="button" class="link" data-tab="forgot">Passwort vergessen?</button>'
      : srv.contact
        ? `Passwort vergessen? Schreib an <a href="mailto:${esc(srv.contact)}">${esc(srv.contact)}</a>.`
        : '';
    return `<form class="acct-form" data-form="login">
      <label class="field"><span>Benutzername oder E-Mail</span><input name="name" required autocomplete="username"></label>
      <label class="field"><span>Passwort</span><input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn btn-primary btn-big">Anmelden</button>
      <p class="muted">Du bleibst auf diesem Gerät angemeldet. ${forgot}</p></form>`;
  }
  if (tab === 'people') {
    const list = await accountApi.users(peopleQuery);
    return `<input class="line-input" id="people-q" placeholder="Name suchen …" value="${esc(peopleQuery)}" autocomplete="off" spellcheck="false">
      <ul class="users">${list.map(userRow).join('') || '<li class="muted">Niemand gefunden.</li>'}</ul>`;
  }
  if (tab === 'friends') {
    const f = await accountApi.friends();
    return `${f.incoming.length ? `<h4>📬 Anfragen</h4><ul class="users">${f.incoming.map(userRow).join('')}</ul>` : ''}
      <h4>🤝 Freunde (${f.friends.length})</h4><ul class="users">${f.friends.map(userRow).join('') || '<li class="muted">Noch keine – unter 👥 Leute findest du andere.</li>'}</ul>
      ${f.outgoing.length ? `<h4>📤 Gesendet</h4><ul class="users">${f.outgoing.map(userRow).join('')}</ul>` : ''}`;
  }
  if (tab === 'settings')
    return `<form class="acct-form" data-form="email"><label class="field"><span>E-Mail <small class="muted">(für „Passwort vergessen“)</small></span>
        <input name="email" type="email" maxlength="120" value="${esc(me.email ?? '')}" autocomplete="email"></label><button class="btn btn-ghost">Speichern</button></form>
      <form class="acct-form" data-form="password"><input class="vh" type="text" name="username" autocomplete="username" value="${esc(me.name)}" tabindex="-1" aria-hidden="true">
        <label class="field"><span>Bisheriges Passwort</span><input name="old" type="password" required autocomplete="current-password"></label>
        <label class="field"><span>Neues Passwort</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
        <button class="btn btn-ghost">Passwort ändern</button><small class="muted">Andere Geräte werden dabei abgemeldet.</small></form>
      <button class="btn btn-ghost" id="logout">Abmelden</button>
      <details class="danger-zone"><summary>Account löschen</summary>
        <form class="acct-form" data-form="delete"><input class="vh" type="text" name="username" autocomplete="username" value="${esc(me.name)}" tabindex="-1" aria-hidden="true">
          <p>Löscht deinen Account <b>sofort und endgültig</b>: Spielstand auf dem Server, Statistik, Medaillen, Freundschaften. Das lässt sich nicht rückgängig machen.</p>
          <label class="field"><span>Passwort zur Bestätigung</span><input name="password" type="password" required autocomplete="current-password"></label>
          <button class="btn btn-danger">Account endgültig löschen</button></form></details>
      <p class="muted"><button type="button" class="link" data-tab="privacy">Datenschutz – was gespeichert wird</button></p>`;
  const p = await accountApi.profile(me.name);
  return `<div class="profile-head"><h3>${esc(me.name)}</h3></div>${levelBar(p.level)}${medalsHtml(p.medals)}${p.stats ? statsHtml(p.stats) : ''}`;
}

/** jede Anzeige bekommt eine Nummer – eine ältere, langsamere Antwort überschreibt nie eine neuere */
let renderGen = 0;

async function render() {
  const gen = ++renderGen;
  const me = account.me;
  const tabs: [Tab, string][] = me
    ? [
        ['profile', '🙂 Profil'],
        ['friends', `🤝 Freunde${me.friendRequests ? ` <span class="badge">${me.friendRequests}</span>` : ''}`],
        ['people', '👥 Leute'],
        ['settings', '⚙️'],
      ]
    : [
        ['login', 'Anmelden'],
        ['register', 'Registrieren'],
      ];
  sheet.innerHTML = `<div class="acct-box">
      <div class="acct-top"><b>${icon('user')} ${me ? 'Account' : 'Account – Fortschritt auf allen Geräten'}</b><button class="icon-btn" id="acct-close" aria-label="Schließen">${icon('x')}</button></div>
      ${tab === 'reset' || tab === 'forgot' ? '' : `<div class="acct-tabs">${tabs.map(([t, l]) => `<button data-tab="${t}" class="${t === tab && !viewing ? 'on' : ''}">${l}</button>`).join('')}</div>`}
      <div class="acct-body" tabindex="0"><div class="loading"><div class="spinner"></div></div></div></div>`;
  sheet.querySelector('#acct-close')!.addEventListener('click', close);
  const box = sheet.querySelector<HTMLElement>('.acct-body')!;
  let html: string;
  try {
    html = await body();
  } catch (e) {
    html = `<p class="err">${esc((e as Error).message)}</p>`;
  }
  if (gen !== renderGen) return;
  box.innerHTML = html;
  bind();
  (sheet.querySelector<HTMLInputElement>('.acct-form input:not([value]), .acct-form input[value=""], #people-q') ?? sheet.querySelector<HTMLInputElement>('.acct-form input'))?.focus();
}

function bind() {
  sheet.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab as Tab;
      viewing = null;
      void render();
    }),
  );
  sheet.querySelector('[data-back]')?.addEventListener('click', () => {
    viewing = null;
    void render();
  });
  sheet.querySelectorAll<HTMLElement>('[data-profile]').forEach((b) =>
    b.addEventListener('click', () => {
      viewing = b.dataset.profile!;
      void render();
    }),
  );
  const act = (sel: string, fn: (name: string) => Promise<unknown>, msg: (n: string) => string) =>
    sheet.querySelectorAll<HTMLButtonElement>(sel).forEach((b) =>
      b.addEventListener('click', async () => {
        const n = b.dataset.befriend ?? b.dataset.unfriend!;
        try {
          await fn(n);
          toast(msg(n), 'info');
          await refreshMe();
          void render();
        } catch (e) {
          toast((e as Error).message);
        }
      }),
    );
  act('[data-befriend]', (n) => accountApi.befriend(n), (n) => `Freundschaft mit ${n} angefragt bzw. angenommen`);
  act('[data-unfriend]', (n) => accountApi.unfriend(n), (n) => `${n}: Freundschaft/Anfrage entfernt`);
  const q = sheet.querySelector<HTMLInputElement>('#people-q');
  let t: ReturnType<typeof setTimeout>;
  q?.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      // inzwischen anderer Reiter oder ein Profil offen: nicht dazwischenfunken (sonst wären z.B. Eingaben weg)
      if (!q.isConnected || tab !== 'people' || viewing) return;
      peopleQuery = q.value;
      void render().then(() => {
        const n = sheet.querySelector<HTMLInputElement>('#people-q');
        n?.setSelectionRange(n.value.length, n.value.length);
      });
    }, 250);
  });
  sheet.querySelector('#logout')?.addEventListener('click', () => void signOut());
  sheet.querySelectorAll<HTMLFormElement>('form[data-form]').forEach((f) =>
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (k: string) => (f.elements.namedItem(k) as HTMLInputElement | null)?.value ?? '';
      const btn = f.querySelector<HTMLButtonElement>('button:not([type=button])');
      if (btn) btn.disabled = true;
      try {
        switch (f.dataset.form) {
          case 'login':
            await welcome(await accountApi.login(v('name'), v('password')));
            break;
          case 'register':
            await welcome(await accountApi.register(v('name'), v('password'), v('email')), true);
            break;
          case 'reset':
            await welcome(await accountApi.reset(resetToken ?? '', v('password')));
            resetToken = null;
            break;
          case 'forgot':
            await accountApi.forgot(v('email'));
            f.innerHTML = `<p class="good">📬 Wenn <b>${esc(v('email'))}</b> bei einem Account eingetragen ist, ist jetzt eine E-Mail mit Link unterwegs (gilt 1 Stunde).</p>
              <p class="muted">Nichts da? Schau im Spam-Ordner nach. Mails gehen nur an Adressen, die im Account unter ⚙️ eingetragen sind.</p>`;
            break;
          case 'email':
            account.me = await accountApi.setEmail(v('email'));
            toast('E-Mail gespeichert', 'info');
            break;
          case 'delete':
            if (!confirm(`Account „${account.me?.name}“ wirklich endgültig löschen?`)) break;
            await deleteAccount(v('password'));
            break;
          case 'password':
            await accountApi.password(v('old'), v('password'));
            f.reset();
            toast('Passwort geändert', 'info');
            break;
        }
      } catch (err) {
        toast((err as Error).message);
      } finally {
        if (btn?.isConnected) btn.disabled = false;
      }
    }),
  );
}

async function welcome(me: Parameters<typeof signedIn>[0], fresh = false) {
  // Name in diesem Browser = Account-Name (Beitreten, Lobby)
  app.prefs.name = me.name;
  savePrefs();
  toast(fresh ? `Willkommen, ${me.name}! 🎉` : `Hallo ${me.name}!`, 'info');
  tab = 'profile';
  await signedIn(me);
  void render();
}

async function refreshMe() {
  const { user } = await accountApi.me();
  account.me = user;
  account.listeners.forEach((fn) => fn());
}

// ---------------------------------------------------------------- Kopfzeile, Banner, Einladen

export function accountButton(): string {
  const me = account.me;
  if (!me) return `<button class="acct-btn" id="acct-btn" title="Anmelden oder Account erstellen">${icon('user', 16)} <span>Anmelden</span></button>`;
  const n = me.friendRequests;
  return `<button class="acct-btn on" id="acct-btn" title="Dein Account"><span class="lvl-badge small">Lv ${me.level.level}</span> <span>${esc(me.name)}</span>${n ? `<span class="badge">${n}</span>` : ''}</button>`;
}

/** Einladungen von Freunden: oben als Banner, „Beitreten“ führt direkt in die Lobby */
export function renderInvites(host: HTMLElement) {
  const list = (account.me?.invites ?? []).filter((i) => i.code !== app.session?.code).slice(0, 2);
  host.innerHTML = list
    .map(
      (i) =>
        `<div class="invite-banner" role="alert"><span>📨 <b>${esc(i.from)}</b> lädt dich ${i.mode === 'quiz' ? 'ins 🧠 Quiz' : 'in die 🏁 Routenjagd'} ein</span>
          <button class="btn btn-primary btn-sm" data-join-invite="${i.id}">Beitreten</button><button class="icon-btn" data-drop-invite="${i.id}" aria-label="Einladung ablehnen">✕</button></div>`,
    )
    .join('');
  host.querySelectorAll<HTMLButtonElement>('[data-drop-invite]').forEach((b) =>
    b.addEventListener('click', async () => {
      await accountApi.dropInvite(Number(b.dataset.dropInvite)).catch(() => {});
      if (account.me) account.me.invites = account.me.invites.filter((i) => i.id !== Number(b.dataset.dropInvite));
      renderInvites(host);
    }),
  );
  host.querySelectorAll<HTMLButtonElement>('[data-join-invite]').forEach((b) =>
    b.addEventListener('click', async () => {
      const inv = account.me?.invites.find((i) => i.id === Number(b.dataset.joinInvite));
      if (!inv) return;
      if (app.session && !confirm('Deine aktuelle Lobby verlassen und beitreten?')) return;
      try {
        if (app.session) {
          await api.leave(app.session).catch(() => {});
          endSession();
        }
        const res = await api.join(inv.code, account.me!.name);
        await accountApi.dropInvite(inv.id).catch(() => {});
        account.me!.invites = account.me!.invites.filter((i) => i.id !== inv.id);
        startSession({ code: res.state.id, playerId: res.playerId, token: res.token }, res.state);
      } catch (e) {
        toast((e as Error).message);
        await accountApi.dropInvite(inv.id).catch(() => {});
      }
      renderInvites(host);
    }),
  );
}

/** „📨 Freunde einladen“ in der Lobby (nur angemeldet) */
export const inviteButton = () => (account.me ? `<button class="btn btn-ghost btn-icon" data-invite-friends>${icon('userPlus')}<span>Freunde einladen</span></button>` : '');

async function inviteDialog() {
  const s = app.session;
  if (!s) return;
  let friends: UserListItem[];
  try {
    friends = (await accountApi.friends()).friends;
  } catch (e) {
    return toast((e as Error).message);
  }
  if (!friends.length) {
    toast('Du hast noch keine Freunde – unter 👥 Leute findest du andere.', 'info', { label: '👥 Leute', run: () => openAccount('people') });
    return;
  }
  const dlg = h(
    'div',
    { class: 'acct-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Freunde einladen' },
    `<div class="acct-box"><div class="acct-top"><b>📨 Freunde einladen</b><button class="icon-btn" data-x aria-label="Schließen">✕</button></div>
      <div class="acct-body"><p class="muted">Sie sehen die Einladung sofort, wenn sie BimGuesser offen haben – sonst beim nächsten Öffnen.</p>
      <ul class="users pick">${friends
        .map((f) => `<li><label><input type="checkbox" value="${esc(f.name)}" ${f.online ? 'checked' : ''}> <span class="online-dot ${f.online ? 'on' : ''}"></span>${esc(f.name)}</label><span class="lvl-badge small">Lv ${f.level}</span></li>`)
        .join('')}</ul>
      <div class="learn-actions"><button class="btn btn-primary" data-send>Einladen</button><button class="btn btn-ghost" data-all>Alle ${friends.length} einladen</button></div></div></div>`,
  );
  document.body.append(dlg);
  const done = () => dlg.remove();
  dlg.addEventListener('click', (e) => e.target === dlg && done());
  dlg.querySelector('[data-x]')!.addEventListener('click', done);
  const send = async (to: 'all' | string[]) => {
    try {
      const r = await accountApi.invite(s.code, s.token, to);
      toast(`${r.invited} ${r.invited === 1 ? 'Freund' : 'Freunde'} eingeladen`, 'info');
      done();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  dlg.querySelector('[data-send]')!.addEventListener('click', () => send([...dlg.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value)));
  dlg.querySelector('[data-all]')!.addEventListener('click', () => send('all'));
}

// Klicks überall: Profil öffnen (👤 neben Spielernamen), Freunde einladen
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const prof = t.closest<HTMLElement>('[data-profile]');
  if (prof && !sheet.contains(prof)) return openAccount('profile', prof.dataset.profile!);
  if (t.closest('[data-invite-friends]')) void inviteDialog();
});

/** neue Medaillen melden */
export function announceMedals() {
  if (!account.me) return;
  for (const m of newMedals(account.me)) toast(`${m.icon} Neue Medaille: ${m.title} – ${m.text}`, 'info');
}

/** ?reset=… aus der Mail: Fenster „Neues Passwort“ */
export function takeResetLink() {
  const p = new URLSearchParams(location.search);
  const t = p.get('reset');
  if (!t) return;
  resetToken = t;
  p.delete('reset');
  history.replaceState(null, '', `${location.pathname}${p.size ? `?${p}` : ''}`);
  openAccount('reset');
}
