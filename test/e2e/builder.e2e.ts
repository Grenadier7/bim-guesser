// Routen-Baukasten: frühere Ausstiege ändern (Punkt 3), Fußwege deutlich, aber nicht nervig (Punkt 4)
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

test('Ausstieg einer früheren Teilstrecke ändern → nächste Teilstrecke startet dort; weite Linie → deutlicher Hinweis', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'Bau');
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  await fetch(`${app.base}/api/games/${s.code}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.token, settings: { rounds: 1, locate: false, restrictions: 'never', stations: ['U'], minTransfers: 0, distance: 'long', roundTimeLimitSec: null } }),
  });
  await p.locator('#start').click();
  await p.locator('.line-input').waitFor({ timeout: 180_000 });
  const st = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  const start = net.stations.find((x) => x.id === st.rounds[0].from.id)!;
  const name = (id: string) => net.stations.find((x) => x.id === id)!.name;

  // Punkt 4: Linie, deren nächster Halt weit weg ist → deutlicher Hinweis, aber Eingabe geht weiter
  const far = ['S45', '62', 'BB', '10A', 'S80', 'U6', 'U4']
    .map((id) => net.lines.find((l) => l.id === id)!)
    .find((l) => Math.min(...l.patterns.flat().map((sid) => distM(net.stations.find((x) => x.id === sid)!, start))) > 1500)!;
  await p.locator('.line-input').fill(far.id);
  await p.locator('.line-input').press('Enter');
  await p.locator('.walk-alert.walk-loud', { hasText: 'fährt nicht bei' }).waitFor();
  await t.shot('builder-walk-loud');
  await p.locator('[data-act=change]').click();

  // Punkt 3: zwei Teilstrecken mit derselben U-Bahn, dann den ersten Ausstieg früher setzen
  const line = net.lines.find((l) => l.mode === 'U' && l.patterns.some((pt) => pt.indexOf(start.id) >= 0 && pt.indexOf(start.id) + 5 < pt.length))!;
  const pat = line.patterns.find((pt) => pt.indexOf(start.id) >= 0 && pt.indexOf(start.id) + 5 < pt.length)!;
  const k = pat.indexOf(start.id);
  const [x2, x, y] = [pat[k + 2], pat[k + 3], pat[k + 5]];
  const pickLeg = async (to: string) => {
    await p.locator('.line-input').fill(line.id);
    await p.locator('.line-input').press('Enter');
    const value = await p.locator('.leg-form .alight-select option').evaluateAll((os, id) => os.map((o) => (o as HTMLOptionElement).value).find((v) => v === id || v.endsWith(`>${id}`))!, to);
    await p.locator('.leg-form .alight-select').selectOption(value);
  };
  await pickLeg(x);
  await pickLeg(y);
  assert.equal(await p.locator('ol.legs li.leg:not(.walk-leg)').count(), 2);
  // erster Ausstieg: x → x2 (früher) – zweite Teilstrecke startet jetzt bei x2
  const first = p.locator('ol.legs li.leg:not(.walk-leg)').first().locator('.leg-alight');
  const v2 = await first.locator('option').evaluateAll((os, id) => os.map((o) => (o as HTMLOptionElement).value).find((v) => v === id || v.endsWith(`>${id}`))!, x2);
  await first.selectOption(v2);
  const second = await p.locator('ol.legs li.leg:not(.walk-leg)').nth(1).locator('.leg-text').innerText();
  assert.ok(second.startsWith(name(x2)), `zweite Teilstrecke beginnt bei „${second.split('→')[0].trim()}“ statt ${name(x2)}`);
  await t.shot('builder-reflow');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});
