// Neues für Spielspaß: Route nur mit der Tastatur, Strecke des Tages (spielen, teilen, Bestenliste), Mein Wien,
// Dunkelmodus, Bestätigungsdialog und „Spiel beenden“ mit Endstand.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp, type App, type TestPage } from './harness.ts';

let app: App;
before(async () => (app = await startApp({ RATE_LIMIT_SCALE: '1000' })));
after(async () => app?.close());

const noErrors = (t: TestPage) => assert.deepEqual(t.errors, []);

test('Route nur mit der Tastatur: ← → zwischen Vorschlägen, Enter öffnet die Liste, ↑ ↓ zwischen Ein- und Ausstieg, Entf verwirft, Strg+Enter gibt ab', async () => {
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
  assert.equal(await p.locator('.line-results .line-opt.active').getAttribute('data-line'), opts[1]);
  await input.fill('');

  /** Linien, die an der aktuellen Station abfahren („Was fährt hier ab?“ im Training) */
  const depsHere = () => p.locator('.deps .line-opt').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.line!));
  const sel = p.locator('.leg-form .alight-select');

  // Linie hält hier → Fokus beim Ausstieg (Liste noch zu); ↑ springt zum Einstieg, ↓ zurück; Enter öffnet,
  // ↓ wählt nur aus, Enter übernimmt
  await p.keyboard.type((await depsHere())[0]);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(100);
  assert.ok(await sel.evaluate((s) => s === document.activeElement), 'Ausstieg im Fokus');
  assert.equal(await p.locator('.leg-form .kb-list').count(), 0, 'Liste erst nach Enter');
  await p.keyboard.press('ArrowUp');
  assert.ok(await p.locator('.leg-form .board-select').evaluate((s) => s === document.activeElement), '↑ → Einstieg');
  await p.keyboard.press('Enter');
  await p.locator('.leg-form .kb-list').waitFor();
  await p.keyboard.press('Escape');
  await p.keyboard.press('ArrowDown');
  assert.ok(await sel.evaluate((s) => s === document.activeElement), '↓ → Ausstieg');
  await p.keyboard.press('Enter');
  await p.locator('.leg-form .kb-list').waitFor();
  await p.keyboard.press('ArrowDown');
  if (!(await sel.inputValue())) await p.keyboard.press('ArrowUp'), await p.keyboard.press('ArrowUp');
  assert.ok(await sel.inputValue(), 'ein Halt gewählt');
  assert.equal(await p.locator('ol.legs li.leg').count(), 0);
  await p.keyboard.press('Enter');
  await p.locator('ol.legs li.leg').first().waitFor();
  assert.ok(await input.evaluate((i) => i === document.activeElement), 'Fokus zurück im Linienfeld');

  // Entf: angefangene Linie weg, fertige Teilstrecke bleibt
  await p.keyboard.type((await depsHere())[0]);
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  await p.locator('.leg-form .kb-list').waitFor();
  await p.keyboard.press('Delete');
  await input.waitFor();
  assert.equal(await p.locator('ol.legs li.leg:not(.walk-leg)').count(), 1);

  // Linie hält nicht hier → keine Liste, Fokus beim Einstieg (Fußweg ansehen); Entf geht auch dort
  const here = new Set(await depsHere());
  const far = ['S45', 'U4', 'U6', 'U1', '62', 'S80', '10A'].find((id) => !here.has(id))!;
  await input.focus();
  await p.keyboard.type(far);
  await p.keyboard.press('Enter');
  await p.locator('.picked .chip', { hasText: far }).waitFor();
  await p.waitForTimeout(100);
  assert.ok(await p.locator('.leg-form .board-select').evaluate((s) => s === document.activeElement), 'Einstieg im Fokus');
  assert.equal(await p.locator('.leg-form .kb-list').count(), 0);
  await p.keyboard.press('Delete');
  await input.waitFor();
  // Strg+Enter gibt die Route ab
  await input.focus();
  await p.keyboard.press('Control+Enter');
  await p.locator('.training h2', { hasText: 'Auswertung' }).waitFor({ timeout: 60_000 });
  noErrors(t);
});

test('Strecke des Tages: spielen, Ergebnis zum Teilen, Bestenliste; danach Startseite „gespielt“, Mein Wien zählt mit', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(`${app.base}/#daily`);
  await p.locator('.daily h2', { hasText: 'Strecke des Tages' }).waitFor({ timeout: 120_000 });
  await p.locator('#go').click();
  // eine Linie, die am Start hält (dann klappt die Ausstiegsliste gleich auf)
  const day = await (await fetch(`${app.base}/api/daily`)).json();
  const net = await (await fetch(`${app.base}/api/network`)).json();
  const line = net.lines.find((l: { patterns: string[][] }) => l.patterns.some((pt) => pt.slice(0, -1).includes(day.from.id))).id;
  await p.locator('.line-input').fill(line);
  await p.locator('.line-input').press('Enter');
  await p.keyboard.press('Enter');
  await p.locator('.leg-form .kb-list').waitFor();
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

test('Dunkelmodus: startet hell (auch bei dunklem System), Knopf schaltet um, Einstellung bleibt nach Neuladen', async () => {
  const t = await app.page();
  const p = t.page;
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.goto(app.base);
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'light');
  await p.locator('.theme-btn').click(); // hell → dunkel
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

test('Tages-Challenge: Banner blättern, Spielen legt die Einstellungen fest (ausgegraut), Beenden → wieder Standard', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.locator('.mode-route').click();
  await p.locator('.challenge-bar').waitFor();
  // 4 Challenges heute: ‹ › blättert durch, nach 4× wieder die erste
  const title = () => p.locator('.challenge-bar .cb-text b').innerText();
  const first = await title();
  const seen = new Set([first]);
  for (let i = 0; i < 3; i++) {
    await p.locator('[data-cb="1"]').click();
    seen.add(await title());
  }
  assert.equal(seen.size, 4);
  await p.locator('[data-cb="1"]').click();
  assert.equal(await title(), first);
  await p.locator('#cb-go').click();
  await p.locator('.lobby.challenge-on .challenge-bar.on').waitFor();
  assert.ok(await p.locator('button[data-k=rounds]').first().isDisabled(), 'Einstellungen fest');
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  const st = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  assert.ok(st.settings.challenge);
  // Einstellungen ändern geht nicht (auch nicht am Server vorbei)
  const r = await fetch(`${app.base}/api/games/${s.code}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: s.token, settings: { rounds: 10 } }) });
  assert.equal(r.status, 400);
  await p.locator('#cb-end').click();
  await p.locator('.lobby:not(.challenge-on)').waitFor();
  const st2 = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  assert.equal(st2.settings.challenge, null);
  assert.equal(st2.settings.focus, null);
  noErrors(t);
});
