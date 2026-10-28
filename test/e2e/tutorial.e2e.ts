// Tutorial (Punkt 17): auf der Startseite für Neue, zwei geführte Runden, Punkte-Erklärung, danach weg
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { NetworkPublic } from '../../shared/types.ts';
import { startApp, type App } from './harness.ts';

let app: App;
let net: NetworkPublic;
before(async () => {
  app = await startApp({ RATE_LIMIT_SCALE: '1000' });
  net = (await (await fetch(`${app.base}/api/network`)).json()) as NetworkPublic;
});
after(async () => app?.close());

test('Tutorial: Praterstern → Stephansplatz, Reumannplatz → Rathaus (U2-Falle), Punkte, danach nicht mehr angeboten', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.locator('.tut-card').waitFor();
  assert.equal(await p.locator('.tut-hint').count(), 1);
  await t.shot('tutorial-home');
  await p.locator('.tut-card').click();

  const id = (name: string, line: string) => net.stations.find((s) => s.name === name && s.lines.includes(line))!.id;
  const alight = async (stationId: string) => {
    const sel = p.locator('.leg-form .alight-select');
    const value = await sel.locator('option').evaluateAll((os, sid) => os.map((o) => (o as HTMLOptionElement).value).find((v) => v === sid || v.endsWith(`>${sid}`))!, stationId);
    await sel.selectOption(value);
  };
  const line = async (l: string) => {
    await p.locator('.line-input').fill(l);
    await p.locator('.line-input').press('Enter');
  };

  // Runde 1
  await p.locator('.tut-bubble', { hasText: 'U1' }).waitFor({ timeout: 120_000 });
  assert.equal(await p.locator('.line-input.tut-focus').count(), 1);
  await line('U1');
  await p.locator('.tut-bubble', { hasText: 'Ausstieg' }).waitFor();
  await alight(id('Stephansplatz', 'U1'));
  await p.locator('.tut-bubble', { hasText: 'Geschafft' }).waitFor();
  await p.locator('[data-act=submit]').click();
  await p.locator('#tut-next').waitFor({ timeout: 60_000 });
  await t.shot('tutorial-r1');
  await p.locator('#tut-next').click();

  // Runde 2: erst U2 (fährt dort nicht) → U1 bis Karlsplatz → U2 bis Rathaus
  await p.locator('.tut-bubble', { hasText: 'doch die U2' }).waitFor({ timeout: 120_000 });
  await line('U2');
  await p.locator('.tut-bubble', { hasText: 'fährt gar nicht beim Reumannplatz' }).waitFor();
  await p.locator('.walk-alert.walk-loud').waitFor();
  await t.shot('tutorial-u2-trap');
  await p.locator('[data-act=change]').click();
  await p.locator('.tut-bubble', { hasText: 'Karlsplatz' }).waitFor();
  await line('U1');
  await alight(id('Karlsplatz', 'U1'));
  await p.locator('.tut-bubble', { hasText: 'umsteigen' }).waitFor();
  await line('U2');
  await alight(id('Rathaus', 'U2'));
  await p.locator('[data-act=submit]').click();
  await p.locator('#tut-next').waitFor({ timeout: 60_000 });
  await p.locator('#tut-next').click();

  // Punkte-Erklärung, dann zurück – Tutorial wird nicht mehr angeboten
  await p.locator('text=bis 1000 Punkte').waitFor();
  await t.shot('tutorial-points');
  await p.locator('#tut-done').click();
  await p.locator('.mode-route').waitFor();
  assert.equal(await p.locator('.tut-card, .tut-hint').count(), 0);
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Tutorial wird nach 2 normalen Spielen nicht mehr angeboten', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.evaluate(() => localStorage.setItem('oeffi-progress-v1', JSON.stringify({ tutorialDone: false, played: 2 })));
  await p.reload();
  await p.locator('.mode-route').waitFor();
  assert.equal(await p.locator('.tut-card').count(), 0);
  await t.context.close();
});
