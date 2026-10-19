// E2E: Startseite lädt auf allen Bildschirmgrößen ohne Fehler, alle Modi sind erreichbar
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp, VIEWPORTS, type App } from './harness.ts';

let app: App;
before(async () => (app = await startApp()));
after(async () => app?.close());

for (const vp of Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])
  test(`Startseite (${vp})`, async () => {
    const t = await app.page({ viewport: vp });
    await t.page.goto(app.base);
    await t.page.locator('.mode-learn').waitFor();
    const titles = await t.page.locator('.mode-tile .mt-title').allTextContents();
    assert.deepEqual(titles, ['Routenjagd', 'Training', 'Lernen', 'Quiz']);
    await t.shot(`home-${vp}`);
    assert.deepEqual(t.errors, []);
    await t.context.close();
  });
