// Punkt 13: zufällige Adressen als Start/Ziel – Runde spielen (zu Fuß zur Haltestelle, fahren, abgeben, Auflösung)
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { NetworkPublic } from '../../shared/types.ts';
import { distM } from '../../shared/geo.ts';
import { setName, startApp, type App } from './harness.ts';

let app: App;
let net: NetworkPublic;
before(async () => {
  app = await startApp({ RATE_LIMIT_SCALE: '1000' });
  net = (await (await fetch(`${app.base}/api/network`)).json()) as NetworkPublic;
});
after(async () => app?.close());

test('Routenjagd mit Adressen: Start/Ziel sind Adressen, Route über die nächste Haltestelle, Auflösung mit Fußwegen', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'Adresse');
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  // über die Oberfläche einstellen
  await p.locator('details.advanced summary').click();
  await p.locator('[data-k="endpoints"][data-v="addresses"]').click();
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  await fetch(`${app.base}/api/games/${s.code}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.token, settings: { rounds: 1, locate: false, restrictions: 'never', minTransfers: 0 } }),
  });
  const st0 = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  assert.equal(st0.settings.endpoints, 'addresses');
  await p.locator('#start').click();
  await p.locator('.line-input').waitFor({ timeout: 180_000 });
  const st = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  const from = st.rounds[0].from;
  assert.match(from.id, /^a:/, 'Start ist eine Adresse');
  assert.match(from.name, /\d/, `Adresse mit Hausnummer: ${from.name}`);
  // Linie einer Haltestelle in der Nähe der Adresse wählen
  const near = net.stations.filter((x) => distM(x, from) < 800).sort((a, b) => distM(a, from) - distM(b, from));
  let ok = false;
  for (const id of [...new Set(near.flatMap((x) => x.lines))].filter((l) => !/^N/.test(l))) {
    await p.locator('.line-input').fill(id);
    await p.locator('.line-input').press('Enter');
    if (await p.locator('.leg-form .alight-select').isVisible({ timeout: 800 }).catch(() => false)) {
      const v = await p.locator('.leg-form .alight-select option:not([disabled])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      await p.locator('.leg-form .alight-select').selectOption(v[v.length - 1]);
      ok = true;
      break;
    }
    await p.locator('[data-act=change]').click().catch(() => {});
  }
  assert.ok(ok, 'keine Linie in der Nähe wählbar');
  await t.shot('addresses-round');
  await p.locator('[data-act=submit]').click();
  await p.locator('.btn-big', { hasText: 'Zum Endergebnis' }).waitFor({ timeout: 180_000 });
  await t.shot('addresses-reveal');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});
