// Tipps in der Routenjagd: Linien aus „Linien am Start“ antippen → gleich als Teilstrecke gewählt (N-5)
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setName, startApp, type App } from './harness.ts';

let app: App;
before(async () => (app = await startApp({ RATE_LIMIT_SCALE: '1000' })));
after(async () => app?.close());

test('N-5: Linie aus dem Tipp „Linien am Start“ antippen wählt sie im Routen-Baukasten', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'Tipp');
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  await fetch(`${app.base}/api/games/${s.code}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.token, settings: { rounds: 1, locate: false, restrictions: 'never', difficulty: 'easy', tips: 'cheap' } }),
  });
  await p.locator('#start').click();
  await p.locator('[data-tip="startLines"]').click({ timeout: 180_000 });
  const first = p.locator('[data-tip-line]').first();
  await first.waitFor();
  const id = await first.getAttribute('data-tip-line');
  await first.click();
  await p.locator('.picked .chip', { hasText: id! }).waitFor({ timeout: 5000 });
  await p.locator('.leg-form .alight-select').waitFor();
  await t.shot('tip-line-picked');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});
