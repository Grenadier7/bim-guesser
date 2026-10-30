// Accounts im Browser: Registrieren (Lernstand wird übernommen), Name automatisch, Freunde, Einladung in eine Lobby,
// Anmelden auf einem zweiten Gerät (Stand kommt mit), Profil mit Statistik, Passwort vergessen per Mail
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Page } from 'playwright-core';
import { startApp, type App } from './harness.ts';

let app: App;
const MAIL_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'bimguesser-mail-')), 'mails.jsonl');
before(async () => (app = await startApp({ RATE_LIMIT_SCALE: '1000', MAIL_FILE })));
after(async () => app?.close());

const uniq = (p: string) => `${p}${Math.random().toString(36).slice(2, 6)}`;

async function register(p: Page, name: string, email = '') {
  await p.locator('#acct-btn').click();
  await p.locator('.acct-tabs [data-tab=register]').click();
  await p.locator('form[data-form=register] input[name=name]').fill(name);
  if (email) await p.locator('form[data-form=register] input[name=email]').fill(email);
  await p.locator('form[data-form=register] input[name=password]').fill('passwort123');
  await p.locator('form[data-form=register] button').click();
  await p.locator('#acct-btn.on', { hasText: name }).waitFor();
}

test('Registrieren übernimmt den Lernstand, Freunde, Einladung in die Lobby, zweites Gerät, Profil', async () => {
  const [na, nb] = [uniq('Anna'), uniq('Ben')];
  const a = await app.page();
  await a.page.goto(app.base);
  // Spielstand vor dem Registrieren: Tutorial gemacht, eine Linie gemerkt
  await a.page.evaluate(() => {
    localStorage.setItem('oeffi-progress-v1', JSON.stringify({ tutorialDone: true, played: 3 }));
    localStorage.setItem('oeffi-my-lines-v1', JSON.stringify(['U4']));
  });
  await a.page.reload();
  await register(a.page, na, `${na.toLowerCase()}@example.org`);
  await a.shot('account-profile-new');
  // Tutorial-Medaille, Name im Spiel = Account-Name
  await a.page.locator('.medal.on', { hasText: 'Angekommen' }).waitFor();
  await a.page.locator('#acct-close').click();
  assert.equal(await a.page.locator('#name').inputValue(), na);

  // Ben registriert sich und schickt Anna eine Freundschaftsanfrage
  const b = await app.page();
  await b.page.goto(app.base);
  await register(b.page, nb);
  await b.page.locator('.acct-tabs [data-tab=people]').click();
  await b.page.locator('#people-q').fill(na);
  await b.page.locator(`[data-befriend="${na}"]`).click();
  await b.page.locator(`[data-unfriend="${na}"]`, { hasText: 'Angefragt' }).waitFor();
  await b.page.locator('#acct-close').click();

  // Anna sieht die Anfrage (Badge) und nimmt an
  await a.page.reload();
  await a.page.locator('#acct-btn .badge', { hasText: '1' }).waitFor({ timeout: 30_000 });
  await a.page.locator('#acct-btn').click();
  await a.page.locator('.acct-tabs [data-tab=friends]').click();
  await a.page.locator(`[data-befriend="${nb}"]`).click();
  await a.page.locator(`[data-unfriend="${nb}"]`, { hasText: 'Freunde' }).waitFor();
  await a.page.locator('#acct-close').click();

  // Anna macht eine Quiz-Lobby auf und lädt Ben ein
  await a.page.locator('.mode-quiz').click();
  await a.page.locator('[data-invite-friends]').click();
  await a.page.locator('.acct-sheet [data-all]').click();
  await a.page.locator('.toast', { hasText: '1 Freund eingeladen' }).waitFor();
  // Ben öffnet die Seite → Einladung → Beitreten
  await b.page.reload();
  await b.page.locator('.invite-banner', { hasText: na }).waitFor();
  await b.shot('account-invite');
  await b.page.locator('[data-join-invite]').click();
  await b.page.locator('.player-list, .players', { hasText: na }).first().waitFor();
  // beide mit 👤 (Account) in der Lobby
  assert.equal(await b.page.locator('.acct-tag').count(), 2);
  await b.page.locator(`.acct-tag[data-profile="${na}"]`).click();
  await b.page.locator('.acct-body h4', { hasText: 'Statistik' }).waitFor();
  await b.shot('account-friend-profile');

  // zweites Gerät: Anna meldet sich an → gemerkte Linie und Tutorial-Stand kommen mit
  const a2 = await app.page({ viewport: 'phone' });
  await a2.page.goto(app.base);
  await a2.page.locator('#acct-btn').click();
  await a2.page.locator('form[data-form=login] input[name=name]').fill(na);
  await a2.page.locator('form[data-form=login] input[name=password]').fill('passwort123');
  await a2.page.locator('form[data-form=login] button.btn-primary').click();
  await a2.page.locator('#acct-btn.on').waitFor();
  const synced = await a2.page.evaluate(() => [localStorage.getItem('oeffi-my-lines-v1'), localStorage.getItem('oeffi-progress-v1')]);
  assert.deepEqual(JSON.parse(synced[0]!), ['U4']);
  assert.equal(JSON.parse(synced[1]!).tutorialDone, true);
  assert.equal(await a2.page.locator('.tut-card').count(), 0, 'Tutorial ist am zweiten Gerät auch erledigt');
  await a2.shot('account-phone');

  for (const t of [a, b, a2]) {
    assert.deepEqual(t.errors, []);
    await t.context.close();
  }
});

test('Passwort vergessen: Mail mit Link → neues Passwort → angemeldet', async () => {
  const name = uniq('Cleo');
  const t = await app.page();
  await t.page.goto(app.base);
  await register(t.page, name, `${name.toLowerCase()}@example.org`);
  await t.page.locator('.acct-tabs [data-tab=settings]').click();
  await t.page.locator('#logout').click();
  // Abmelden lädt neu, der Spielstand bleibt im Account
  await t.page.locator('#acct-btn:not(.on)').waitFor();
  await t.page.locator('#acct-btn').click();
  await t.page.locator('[data-tab=forgot]').click();
  await t.page.locator('form[data-form=forgot] input[name=email]').fill(`${name.toLowerCase()}@example.org`);
  await t.page.locator('form[data-form=forgot] button').click();
  await t.page.locator('.acct-body .good', { hasText: 'E-Mail mit Link unterwegs' }).waitFor();
  const mail = readFileSync(MAIL_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).findLast((m) => m.to === `${name.toLowerCase()}@example.org`);
  const link = /http\S+\?reset=\S+/.exec(mail.text)![0];
  await t.page.goto(link);
  await t.page.locator('form[data-form=reset] input[name=password]').fill('ganzneu12345');
  await t.page.locator('form[data-form=reset] button').click();
  await t.page.locator('#acct-btn.on', { hasText: name }).waitFor();
  assert.ok(!t.page.url().includes('reset='), 'Token aus der Adresszeile entfernt');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

/** Account direkt über die API (zweiter „Mensch“ ohne Browser) – liefert einen Aufrufer mit eigenem Cookie */
async function apiUser(name: string) {
  let cookie = '';
  const call = async (method: string, url: string, body: unknown = {}) => {
    const r = await fetch(app.base + url, {
      method,
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: method !== 'GET' ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r.json();
  };
  await call('POST', '/api/auth/register', { name, password: 'passwort123' });
  return call;
}

/** Account-Stand am Server, aus der Seite heraus (Cookie der Seite) */
const serverData = (p: Page) => p.evaluate(async () => (await (await fetch('/api/me')).json()).user?.data ?? null);

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`Zeit abgelaufen: ${what} – zuletzt ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

test('Sync im laufenden Betrieb, Abmelden räumt den Browser auf, Wiederanmelden holt alles zurück, kein Vermischen', async () => {
  const name = uniq('Sync');
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await register(p, name);
  await p.locator('#acct-close').click();
  // Linie merken (Netzkarte) → landet im Account
  await p.locator('.mode-learn').click();
  await p.locator('#hub-search').fill('U6');
  await p.locator('#atlas-search').press('Enter');
  await p.locator('.atlas-card [data-star="U6"]').first().click();
  await waitFor(() => serverData(p), (d) => JSON.stringify(d?.['oeffi-my-lines-v1'] ?? []).includes('U6'), 'U6 im Account');
  // Einstellung der Routenjagd (7 Runden) → landet im Account
  await p.goto(app.base);
  await p.locator('.mode-route').click();
  await p.locator('[data-k="rounds"][data-v="7"]').click();
  await waitFor(() => serverData(p), (d) => (d?.['oeffi-guesser-prefs-v2'] as { settings?: { rounds?: number } })?.settings?.rounds === 7, 'Runden im Account');
  await p.locator('#leave').click();

  // Abmelden: Spielstand weg aus dem Browser, Name bleibt
  await p.locator('#acct-btn').click();
  await p.locator('.acct-tabs [data-tab=settings]').click();
  await p.locator('#logout').click();
  await p.locator('#acct-btn:not(.on)').waitFor();
  assert.equal(await p.evaluate(() => localStorage.getItem('oeffi-my-lines-v1')), null);

  // jemand anderes meldet sich am selben Gerät an → bekommt nichts vom ersten Account
  const other = uniq('Fremd');
  await register(p, other);
  const od = await serverData(p);
  assert.equal(od['oeffi-my-lines-v1'], undefined, 'fremder Lernstand nicht übernommen');
  await p.locator('.acct-tabs [data-tab=settings]').click();
  await p.locator('#logout').click();
  await p.locator('#acct-btn:not(.on)').waitFor();

  // wieder anmelden → alles zurück
  await p.locator('#acct-btn').click();
  await p.locator('form[data-form=login] input[name=name]').fill(name);
  await p.locator('form[data-form=login] input[name=password]').fill('passwort123');
  await p.locator('form[data-form=login] button.btn-primary').click();
  await p.locator('#acct-btn.on', { hasText: name }).waitFor();
  await waitFor(() => p.evaluate(() => localStorage.getItem('oeffi-my-lines-v1')), (v) => !!v && v.includes('U6'), 'U6 lokal zurück');
  const prefs = JSON.parse((await p.evaluate(() => localStorage.getItem('oeffi-guesser-prefs-v2')))!);
  assert.equal(prefs.settings.rounds, 7);
  assert.equal(prefs.name, name);
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Profil eines Fremden, E-Mail und Passwort ändern, Einladung ablehnen, Name im Einladungslink', async () => {
  const name = uniq('Prof');
  const stranger = uniq('Fremd');
  const sCall = await apiUser(stranger);
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await register(p, name);
  // Leute → Fremder → nur Level und Medaillen
  await p.locator('.acct-tabs [data-tab=people]').click();
  await p.locator('#people-q').fill(stranger);
  await p.locator(`.user-link[data-profile="${stranger}"]`).click();
  await p.locator('.acct-body', { hasText: 'Statistik und Lieblingslinien sehen nur Freunde' }).waitFor();
  await p.locator('[data-back]').click();
  // Einstellungen: E-Mail, Passwort (falsch, dann richtig)
  await p.locator('.acct-tabs [data-tab=settings]').click();
  await p.locator('form[data-form=email] input[name=email]').fill('kaputt@');
  await p.locator('form[data-form=email] button').click();
  await p.locator('form[data-form=email] input[name=email]').fill(`${name.toLowerCase()}@example.org`);
  await p.locator('form[data-form=email] button').click();
  await p.locator('.toast', { hasText: 'E-Mail gespeichert' }).waitFor();
  await p.locator('form[data-form=password] input[name=old]').fill('falschfalsch');
  await p.locator('form[data-form=password] input[name=password]').fill('ganzneu12345');
  await p.locator('form[data-form=password] button').click();
  await p.locator('.toast', { hasText: 'bisherige Passwort stimmt nicht' }).waitFor();
  await p.locator('form[data-form=password] input[name=old]').fill('passwort123');
  await p.locator('form[data-form=password] button').click();
  await p.locator('.toast', { hasText: 'Passwort geändert' }).waitFor();
  await p.locator('#acct-close').click();

  // Fremder wird Freund und lädt ein → Banner → ablehnen → bleibt weg
  await sCall('POST', `/api/friends/${name}`);
  await p.reload();
  await p.locator('#acct-btn .badge').waitFor();
  await p.locator('#acct-btn').click();
  await p.locator('.acct-tabs [data-tab=friends]').click();
  await p.locator(`[data-befriend="${stranger}"]`).click();
  await p.locator(`[data-unfriend="${stranger}"]`, { hasText: 'Freunde' }).waitFor();
  const lobby = await sCall('POST', '/api/games', { mode: 'route', playerName: stranger, settings: {} });
  await sCall('POST', `/api/games/${lobby.state.id}/invite`, { token: lobby.token, to: [name] });
  await p.reload();
  await p.locator('.invite-banner', { hasText: stranger }).waitFor();
  await p.locator('[data-drop-invite]').click();
  await p.locator('.invite-banner').waitFor({ state: 'detached' });
  await p.reload();
  await p.waitForTimeout(800);
  assert.equal(await p.locator('.invite-banner').count(), 0, 'abgelehnt bleibt abgelehnt');
  // Einladungslink: Name ist schon eingetragen
  await p.goto(`${app.base}/?code=${lobby.state.id}`);
  assert.equal(await p.locator('#inviteName').inputValue(), name);
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Routenjagd angemeldet: Runde und Spiel zählen, Medaille wird gemeldet, Statistik im Profil', async () => {
  const name = uniq('Jagd');
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await register(p, name);
  await p.locator('#acct-close').click();
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  await fetch(`${app.base}/api/games/${s.code}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.token, settings: { rounds: 1, locate: false, restrictions: 'never', minTransfers: 0, stations: ['U'], roundTimeLimitSec: null } }),
  });
  await p.locator('#start').click();
  await p.locator('.line-input').waitFor({ timeout: 180_000 });
  const st = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  const from = st.rounds[0].from;
  const net = await (await fetch(`${app.base}/api/network`)).json();
  const line = net.stations.find((x: { id: string }) => x.id === from.id).lines.find((l: string) => /^U\d$/.test(l));
  await p.locator('.line-input').fill(line);
  await p.locator('.line-input').press('Enter');
  const v = await p.locator('.leg-form .alight-select option:not([disabled])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  await p.locator('.leg-form .alight-select').selectOption(v[0]);
  await p.locator('[data-act=submit]').click();
  await p.locator('.btn-big', { hasText: 'Zum Endergebnis' }).click({ timeout: 180_000 });
  await p.locator('.final').waitFor();
  // nachfragen (sonst alle 20 s) → neue Medaille wird gemeldet
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.locator('.toast', { hasText: 'Neue Medaille: Erstes Spiel' }).waitFor({ timeout: 15_000 });
  await p.locator('#acct-btn').click();
  await p.locator('.stat', { hasText: 'Routenjagden' }).filter({ hasText: '1' }).waitFor();
  await p.locator('.recent li', { hasText: 'Routenjagd' }).waitFor();
  await t.shot('account-after-game');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('drei Accounts: Anfrage und Einladung kommen ohne Neuladen, Wechsel aus der eigenen Lobby, Profile in der Lobby', async () => {
  const [na, nb, nc] = [uniq('Ana'), uniq('Bob'), uniq('Cid')];
  const a = await app.page();
  const b = await app.page();
  const c = await app.page();
  // B und C: Uhr im Browser steuerbar (die Seite fragt alle 20 s nach Neuigkeiten)
  await b.page.clock.install();
  await c.page.clock.install();
  for (const [t, n] of [[a, na], [b, nb], [c, nc]] as const) {
    await t.page.goto(app.base);
    await register(t.page, n);
    await t.page.locator('#acct-close').click();
  }
  // A schickt B eine Anfrage → B sieht den Hinweis ohne Neuladen
  await a.page.evaluate(async (n) => void (await fetch(`/api/friends/${n}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })), nb);
  await b.page.clock.runFor(21_000);
  await b.page.locator('#acct-btn .badge', { hasText: '1' }).waitFor();
  await b.page.locator('#acct-btn').click();
  await b.page.locator('.acct-tabs [data-tab=friends]').click();
  await b.page.locator(`[data-befriend="${na}"]`).click();
  await b.page.locator(`[data-unfriend="${na}"]`, { hasText: 'Freunde' }).waitFor();
  await b.page.locator('#acct-close').click();

  // B ist schon in einer eigenen Lobby
  await b.page.locator('.mode-quiz').click();
  await b.page.locator('#start').waitFor();
  const bOld = await b.page.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!).code);

  // A macht eine Lobby, C tritt per Code bei, A lädt B ein
  await a.page.locator('.mode-route').click();
  await a.page.locator('#start').waitFor();
  const code = await a.page.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!).code);
  await c.page.locator('#code').fill(code);
  await c.page.locator('#join').click();
  await c.page.locator('.lobby').waitFor();
  await a.page.locator('[data-invite-friends]').click();
  await a.page.locator('.acct-sheet [data-send]').click();
  await a.page.locator('.toast', { hasText: '1 Freund eingeladen' }).waitFor();

  // B: Banner ohne Neuladen, Beitreten verlässt die eigene Lobby (mit Nachfrage)
  await b.page.clock.runFor(21_000);
  await b.page.locator('.invite-banner', { hasText: na }).waitFor();
  b.page.once('dialog', (d) => void d.accept());
  await b.page.locator('[data-join-invite]').click();
  await b.page.waitForFunction((cd) => JSON.parse(sessionStorage.getItem('oeffi-guesser-session') ?? '{}').code === cd, code);
  await b.page.locator('.lobby .players li', { hasText: na }).waitFor();
  const old = await (await fetch(`${app.base}/api/games/${bOld}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"playerName":"x"}' })).json();
  assert.ok(!old.state || !old.state.players.some((p: { name: string }) => p.name === nb), 'B ist aus der alten Lobby raus');

  // alle drei mit 👤; Freund B sieht A's Statistik, Fremder C nicht
  await a.page.locator('.lobby .players .acct-tag').nth(2).waitFor();
  assert.equal(await a.page.locator('.lobby .players .acct-tag').count(), 3);
  await b.page.locator(`.lobby .acct-tag[data-profile="${na}"]`).click();
  await b.page.locator('.acct-body h4', { hasText: 'Statistik' }).waitFor();
  await c.page.locator(`.lobby .acct-tag[data-profile="${na}"]`).click();
  await c.page.locator('.acct-body', { hasText: 'sehen nur Freunde' }).waitFor();
  await c.shot('account-three-lobby');
  for (const t of [a, b, c]) {
    assert.deepEqual(t.errors, []);
    await t.context.close();
  }
});
