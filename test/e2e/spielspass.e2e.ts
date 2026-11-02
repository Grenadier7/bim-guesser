// Neues für Spielspaß: Route nur mit der Tastatur, Strecke des Tages (spielen, teilen, Bestenliste), Mein Wien,
// Dunkelmodus, Bestätigungsdialog und „Spiel beenden“ mit Endstand.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp, type App, type TestPage } from './harness.ts';

let app: App;
before(async () => (app = await startApp({ RATE_LIMIT_SCALE: '1000' })));
after(async () => app?.close());

const noErrors = (t: TestPage) => assert.deepEqual(t.errors, []);

test('Route nur mit der Tastatur: ← → zwischen Vorschlägen, Enter klappt den Ausstieg auf, ↓ + Enter übernimmt', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.locator('[data-mode=training]').click();
  await p.locator('#start').click();
  const input = p.locator('.line-input');
  await input.waitFor({ timeout: 120_000 });
  await input.focus();
  await p.keyboard.type('U');
  const opts = await p.locator('.line-results .line-opt').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.line));
  assert.ok(opts.length >= 3, opts.join());
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  assert.equal(await p.locator('.line-results .line-opt.active').getAttribute('data-line'), opts[2]);
  await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('Enter');
  await p.locator('.picked .chip', { hasText: opts[1]! }).waitFor();
  const sel = p.locator('.leg-form .alight-select');
  assert.ok(await sel.evaluate((s) => s === document.activeElement && s.classList.contains('expanded')), 'Ausstieg aufgeklappt und im Fokus');
  // ↓ wählt nur aus – noch keine Teilstrecke
  await p.keyboard.press('ArrowDown');
  if (!(await sel.inputValue())) await p.keyboard.press('ArrowUp'), await p.keyboard.press('ArrowUp');
  assert.ok(await sel.inputValue(), 'ein Halt gewählt');
  assert.equal(await p.locator('ol.legs li.leg').count(), 0);
  await p.keyboard.press('Enter');
  await p.locator('ol.legs li.leg').first().waitFor();
  assert.ok(await p.locator('.line-input').evaluate((i) => i === document.activeElement), 'Fokus zurück im Linienfeld');
  // Escape im Ausstieg = andere Linie
  await p.keyboard.type(opts[0]!);
  await p.keyboard.press('Enter');
  await p.locator('.leg-form .alight-select.expanded').waitFor();
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
  await p.locator('.line-input').waitFor();
  noErrors(t);
});

test('Strecke des Tages: spielen, Ergebnis zum Teilen, Bestenliste; danach Startseite „gespielt“, Mein Wien zählt mit', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(`${app.base}/#daily`);
  await p.locator('.daily h2', { hasText: 'Strecke des Tages' }).waitFor({ timeout: 120_000 });
  await p.locator('#go').click();
  await p.locator('.line-input').fill('U');
  await p.locator('.line-input').press('Enter');
  await p.keyboard.press('ArrowDown');
  if (!(await p.locator('.leg-form .alight-select').inputValue())) await p.keyboard.press('ArrowUp'), await p.keyboard.press('ArrowUp');
  await p.keyboard.press('Enter');
  await p.locator('[data-act=submit]').click();
  await p.locator('#share').waitFor({ timeout: 60_000 });
  const share = await p.locator('.share-preview').innerText();
  assert.match(share, /Strecke des Tages #\d+/);
  assert.match(share, /Punkte/);
  await p.locator('#board').filter({ hasText: /Einträge|Freunden|\d/ }).waitFor();
  await t.shot('daily-result');
  // Startseite: Strecke des Tages als gespielt, Serie läuft
  await p.locator('#back').click();
  await p.locator('.daily-card', { hasText: 'Heute gespielt' }).waitFor();
  await p.locator('.progress-strip', { hasText: '1 Tag' }).waitFor();
  await p.locator('.progress-strip').click();
  await p.locator('.me h3', { hasText: 'Sammelkarte' }).waitFor();
  assert.match(await p.locator('.me').innerText(), /Stationen und \d+ von \d+ Linien/);
  await t.shot('mein-wien');
  noErrors(t);
});

test('Dunkelmodus: Knopf schaltet um, Einstellung bleibt nach Neuladen', async () => {
  const t = await app.page();
  const p = t.page;
  await p.emulateMedia({ colorScheme: 'light' });
  await p.goto(app.base);
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'light');
  await p.locator('.theme-btn').click(); // automatisch → dunkel
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'dark');
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(bg, 'rgb(238, 240, 243)', 'Hintergrund dunkel');
  await p.reload();
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await t.shot('dark-home');
  noErrors(t);
});

test('Spiel beenden nach einer Runde → Endstand mit Hinweis und Revanche (eigener Dialog statt Browser-Popup)', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  await fetch(`${app.base}/api/games/${s.code}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.token, settings: { rounds: 3, locate: false, restrictions: 'never', difficulty: 'easy' } }),
  });
  await p.locator('#start').click();
  await p.locator('.hb-cancel').click({ timeout: 120_000 });
  await p.locator('.ask-dlg').waitFor();
  await p.locator('.ask-dlg [data-v="1"]').click();
  await p.locator('.reveal-title').waitFor();
  await p.locator('.hb-end').click();
  await p.locator('.ask-dlg', { hasText: 'Endstand' }).waitFor();
  await p.locator('.ask-dlg [data-v="1"]').click();
  await p.locator('.final .early-end', { hasText: 'nach Runde 1 von 3' }).waitFor();
  await p.locator('#rematch').waitFor();
  noErrors(t);
});
