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
  await t.page.locator('.acct-body .good', { hasText: 'E-Mail unterwegs' }).waitFor();
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
