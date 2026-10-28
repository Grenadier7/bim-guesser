// Punkt 18: inaktive Lobby – Nachfrage beim Host, ohne Antwort übernimmt der nächste Spieler, dann wird gelöscht
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setName, startApp, type App } from './harness.ts';

let app: App;
before(async () => (app = await startApp({ RATE_LIMIT_SCALE: '1000', LOBBY_IDLE_MS: '3000', LOBBY_IDLE_ANSWER_MS: '3000' })));
after(async () => app?.close());

async function lobby(name: string, code?: string) {
  const t = await app.page();
  await t.page.goto(app.base);
  await setName(t.page, name);
  if (code) {
    await t.page.locator('#code').fill(code);
    await t.page.locator('#join').click();
  } else await t.page.locator('.mode-quiz').click();
  await t.page.locator('#leave').waitFor();
  return t;
}

test('Host bekommt „Lobby behalten?“, behält sie – später antwortet niemand: Gast wird gefragt, Lobby wird gelöscht', async () => {
  const a = await lobby('Host');
  const code = await a.page.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!).code as string);
  const b = await lobby('Gast', code);
  // 1) Host behält die Lobby
  await a.page.locator('.idle-box').waitFor({ timeout: 10_000 });
  assert.equal(await b.page.locator('.idle-box').count(), 0, 'Gast wird noch nicht gefragt');
  await a.page.locator('#idle-keep').click();
  await a.page.locator('.idle-box').waitFor({ state: 'detached' });
  // 2) nächstes Mal antwortet der Host nicht → Gast wird Host und gefragt; Gast antwortet auch nicht → gelöscht
  await a.page.locator('.idle-box').waitFor({ timeout: 10_000 });
  await b.page.locator('.idle-box').waitFor({ timeout: 10_000 });
  await b.page.locator('.toast', { hasText: 'Inaktivität' }).waitFor({ timeout: 10_000 });
  await b.page.locator('.mode-quiz').waitFor();
  await a.page.locator('.mode-quiz').waitFor({ timeout: 10_000 });
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.context.close();
  await b.context.close();
});
