// Fehlerfälle im Browser: Netzfehler bei der Abgabe – Spieler darf nicht auf „Abgegeben“ hängen bleiben (H-05).
// Die erste Abgabe wird im Browser abgefangen und mit 503 beantwortet; danach muss eine zweite Abgabe klappen.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Page } from 'playwright-core';
import type { NetworkPublic } from '../../shared/types.ts';
import { setName, startApp, type App } from './harness.ts';

let app: App;
let net: NetworkPublic;
before(async () => {
  app = await startApp({ RATE_LIMIT_SCALE: '1000' });
  net = (await (await fetch(`${app.base}/api/network`)).json()) as NetworkPublic;
});
after(async () => app?.close());

/** erste Anfrage auf `pattern` scheitert mit 503 */
async function failOnce(p: Page, pattern: RegExp) {
  let failed = false;
  await p.route(pattern, (r) => {
    if (failed) return r.continue();
    failed = true;
    return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Server kurz nicht erreichbar (Test)' }) });
  });
}

test('Regression H-05: Quiz – Antwort scheitert einmal → Antwort nochmal möglich', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'Fehler');
  await p.locator('.mode-quiz').click();
  await p.locator('#start').waitFor();
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  // nur Auswahlfragen
  const weights = { locate: 1, direct: 7, towards: 7, transfer: 7, uCross: 1, uLink: 1, stopLines: 1, termini: 7, lineShape: 1, draw: 1, district: 7, nextStop: 7, busArea: 1 };
  await fetch(`${app.base}/api/games/${s.code}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: s.token, settings: { questions: 5, weights } }) });
  await p.locator('#start').click();
  await p.locator('.quiz-q h2').waitFor();
  await failOnce(p, /\/quiz\/answer$/);
  const opt = p.locator('.quiz-options button[data-o], .pick-lines button[data-o]').first();
  await opt.click();
  if (await p.getByRole('button', { name: 'Antworten' }).count()) await p.getByRole('button', { name: 'Antworten' }).click();
  await p.locator('.toast', { hasText: 'nicht erreichbar' }).waitFor();
  // wieder auswählbar → zweiter Versuch geht durch
  await opt.click({ timeout: 5000 });
  if (await p.getByRole('button', { name: 'Antworten' }).count()) await p.getByRole('button', { name: 'Antworten' }).click();
  await p.locator('.result-card').waitFor({ timeout: 30_000 });
  assert.deepEqual(t.errors.filter((e) => !/503/.test(e)), []);
  await t.context.close();
});

test('Regression H-05: Routenjagd – Abgabe scheitert einmal → Route bleibt, nochmal abgeben', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'Fehler');
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  await fetch(`${app.base}/api/games/${s.code}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.token, settings: { rounds: 1, locate: false, restrictions: 'never', difficulty: 'easy' } }),
  });
  await p.locator('#start').click();
  await p.locator('.line-input').waitFor({ timeout: 180_000 });
  const st = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  const from = net.stations.find((x) => x.id === st.rounds[0].from.id)!;
  let ok = false;
  for (const id of from.lines.filter((l) => !/^N/.test(l))) {
    await p.locator('.line-input').fill(id);
    await p.locator('.line-input').press('Enter');
    if (await p.locator('.leg-form .alight-select').isVisible({ timeout: 800 }).catch(() => false)) {
      const values = await p.locator('.leg-form .alight-select option:not([disabled])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      await p.locator('.leg-form .alight-select').selectOption(values[values.length - 1]);
      ok = true;
      break;
    }
  }
  assert.ok(ok);
  await failOnce(p, /\/rounds\/0\/submit$/);
  await p.locator('[data-act=submit]').click();
  await p.locator('.toast', { hasText: 'nicht erreichbar' }).waitFor();
  // Route ist noch da und der Knopf wieder aktiv
  await p.locator('[data-act=submit]:not([disabled])').click({ timeout: 5000 });
  await p.locator('.btn-big', { hasText: 'Zum Endergebnis' }).waitFor({ timeout: 120_000 });
  assert.deepEqual(t.errors.filter((e) => !/503/.test(e)), []);
  await t.context.close();
});
