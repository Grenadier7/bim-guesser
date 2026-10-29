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
  // Punkt 2 (Nachtrag): mit Adressen keine Haltestellen-Auswahl, oben steht die Zahl der Adressen
  await p.locator('.setting .hint', { hasText: `${net.addressCount!.toLocaleString('de-AT')} Adressen` }).first().waitFor();
  assert.equal(await p.locator('.station-cols').count(), 0, 'Haltestellen-Auswahl ausgeblendet');
  assert.ok(net.addressCount! > 1000);
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  await fetch(`${app.base}/api/games/${s.code}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: s.token, settings: { rounds: 3, locate: false, restrictions: 'never', minTransfers: 0 } }),
  });
  const st0 = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  assert.equal(st0.settings.endpoints, 'addresses');
  await p.locator('#start').click();
  await p.locator('.line-input').waitFor({ timeout: 180_000 });
  const st = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  const from = st.rounds[0].from;
  assert.match(from.id, /^a:/, 'Start ist eine Adresse');
  assert.match(from.name, /\d/, `Adresse mit Hausnummer: ${from.name}`);
  // Linie der nächsten Haltestelle wählen: neutraler Fußweg-Hinweis, kein „fährt/hält nicht hier“ (Nachtrag 3)
  const pickNear = async (pt: { lat: number; lon: number }) => {
    const near = net.stations.filter((x) => distM(x, pt) < 800).sort((a, b) => distM(a, pt) - distM(b, pt));
    for (const id of [...new Set(near.flatMap((x) => x.lines))].filter((l) => !/^N/.test(l))) {
      await p.locator('.line-input').fill(id);
      await p.locator('.line-input').press('Enter');
      if (await p.locator('.leg-form .alight-select').isVisible({ timeout: 800 }).catch(() => false)) {
        assert.equal(await p.locator('.walk-alert').count(), 0, `kein Warnhinweis für ${id} (nächste Haltestelle)`);
        await p.locator('.walk-note', { hasText: 'zur Haltestelle' }).waitFor();
        const v = await p.locator('.leg-form .alight-select option:not([disabled])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
        await p.locator('.leg-form .alight-select').selectOption(v[v.length - 1]);
        return true;
      }
      await p.locator('[data-act=change]').click().catch(() => {});
    }
    return false;
  };
  assert.ok(await pickNear(from), 'keine Linie in der Nähe wählbar');
  await t.shot('addresses-round');
  await p.locator('[data-act=submit]').click();
  const next = p.locator('.btn-big', { hasText: 'Nächste Runde' });
  await next.waitFor({ timeout: 180_000 });
  await t.shot('addresses-reveal');
  // Linie in der Auflösung antippen geht (ganzer Verlauf) …
  await p.locator('.route-list > li').first().click();
  await p.locator('.route-list > li.open .leg-detail [data-chip-line]').first().click();
  await p.locator('.toast', { hasText: 'ganzer Verlauf' }).waitFor();

  // … aber in der nächsten Runde reagiert nichts mehr davon (Nachtrag 3: alte Routen tauchten wieder auf)
  await next.click();
  await p.locator('.line-input').waitFor({ timeout: 180_000 });
  const st2 = (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state;
  await p.locator('.toast').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  assert.ok(await pickNear(st2.rounds[1].from), 'Runde 2: keine Linie in der Nähe');
  await p.locator('ol.legs [data-chip-line]').first().click();
  await p.waitForTimeout(400);
  assert.equal(await p.locator('.toast', { hasText: 'ganzer Verlauf' }).count(), 0, 'Klick im Baukasten löst nichts von der alten Auflösung aus');
  assert.equal(await p.locator('.rlabel-wrap').count(), 0, 'keine alten Routen auf der Karte');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Einstellungen importieren: ungültige Werte und unbekannte Felder werden gemeldet, gültiges JSON wird übernommen', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'Import');
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  await p.locator('details.advanced summary').click();
  await p.locator('#shareSettings').click();
  const json = await p.locator('.share-json').inputValue();
  // unverändert zurück → alles übernommen
  await p.locator('#share-import').click();
  await p.locator('.toast', { hasText: 'Einstellungen übernommen' }).waitFor();
  // Unsinn: Runden 99, Tipps „gratis“, unbekanntes Feld, Fokus kaputt
  await p.locator('#shareSettings').click();
  await p.locator('.share-json').fill(JSON.stringify({ ...JSON.parse(json), rounds: 99, tips: 'gratis', farbe: 'rot' }));
  await p.locator('#share-import').click();
  const box = p.locator('.import-problems');
  await box.waitFor();
  const text = await box.innerText();
  assert.match(text, /bis auf 3 Angaben/);
  assert.match(text, /„rounds“: 99 ist ungültig/);
  assert.match(text, /„tips“: "gratis" ist ungültig/);
  assert.match(text, /„farbe“ gibt es nicht/);
  // kein JSON / kein Objekt
  await p.locator('.share-json').fill('{"rounds": 5,');
  await p.locator('#share-import').click();
  await box.filter({ hasText: 'kein gültiges JSON' }).waitFor();
  await p.locator('.share-json').fill('[1,2]');
  await p.locator('#share-import').click();
  await box.filter({ hasText: 'Keine Einstellungen gefunden' }).waitFor();
  // Quiz-Einstellungen in der Routenjagd
  await p.locator('.share-json').fill(JSON.stringify({ mode: 'quiz', settings: { questions: 10, seconds: 20 } }));
  await p.locator('#share-import').click();
  await box.filter({ hasText: 'Einstellungen für das Quiz' }).waitFor();
  await t.shot('settings-import-problems');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Wertung: drei Modi, „Umstiege vermeiden“ nur bei Realistisch', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'Wertung');
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  const s = await p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session')!));
  const settings = async () => (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state.settings;
  await p.locator('details.advanced summary').click();
  await p.locator('[data-adv="rules"]').click();
  // Standard: Realistisch, ohne Umstiegs-Aufschlag
  await p.locator('[data-k="scoring"][data-v="realistic"].on').waitFor();
  assert.equal(await p.locator('input[data-k="avoidTransfers"]').isChecked(), false);
  // Umstiege vermeiden → goal 'best'
  await p.locator('label.toggle', { has: p.locator('input[data-k="avoidTransfers"]') }).click();
  await p.locator('input[data-k="avoidTransfers"]:checked').waitFor();
  assert.equal((await settings()).goal, 'best');
  // Wie die Auskunft: kein Umstiegs-Schalter, echte Abfahrten, nur Zeit
  await p.locator('[data-k="scoring"][data-v="info"]').click();
  await p.locator('[data-k="scoring"][data-v="info"].on').waitFor();
  assert.equal(await p.locator('input[data-k="avoidTransfers"]').count(), 0);
  assert.deepEqual((({ countWait, avgWait, goal }) => ({ countWait, avgWait, goal }))(await settings()), { countWait: true, avgWait: false, goal: 'fastest' });
  // Nur Fahrzeit
  await p.locator('[data-k="scoring"][data-v="ride"]').click();
  await p.locator('[data-k="scoring"][data-v="ride"].on').waitFor();
  assert.equal((await settings()).countWait, false);
  await t.shot('scoring-modes');
  // ältere Kombination aus einem Link → „eigene Kombination“
  await fetch(`${app.base}/api/games/${s.code}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: s.token, settings: { countWait: false, avgWait: true } }) });
  await p.locator('.setting .hint', { hasText: 'Eigene Kombination' }).waitFor();
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Adressen wählen → Schwierigkeit „Eigene“; Schnellwahl antippen → wieder Haltestellen', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'Schwierig');
  await p.locator('.mode-route').click();
  await p.locator('#start').waitFor();
  await p.locator('details.advanced summary').click();
  await p.locator('[data-k="endpoints"][data-v="addresses"]').click();
  await p.locator('[data-k="difficulty"][data-v="custom"].on').waitFor();
  assert.equal(await p.locator('.station-cols').count(), 0);
  await t.shot('addresses-custom');
  await p.locator('[data-k="difficulty"][data-v="hard"]').click();
  await p.locator('[data-k="endpoints"][data-v="stations"].on').waitFor();
  await p.locator('[data-k="difficulty"][data-v="hard"].on').waitFor();
  await p.locator('.station-cols').waitFor();
  assert.deepEqual(t.errors, []);
  await t.context.close();
});
