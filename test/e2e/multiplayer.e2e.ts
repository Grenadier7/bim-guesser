// Testmatrix (Phase 2a), Teil 2: Mehrspieler und Grenzfälle im Browser – Beitreten/Verlassen, Host geht,
// Verbindungsabbruch, gleiche Namen, lange Namen/Sonderzeichen/Emojis, Doppelklicks, Neuladen, Zurück-Taste,
// zwei Tabs, gleichzeitige Antworten. Ohne Routenjagd-Runden (die bräuchten die Auskunft) – Abläufe über das Quiz.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Page } from 'playwright-core';
import type { QuizState } from '../../shared/types.ts';
import { setName, startApp, type App, type TestPage } from './harness.ts';

let app: App;
before(async () => (app = await startApp({ RATE_LIMIT_SCALE: '1000' })));
after(async () => app?.close());

interface Sess {
  code: string;
  playerId: string;
  token: string;
}
const session = (p: Page) => p.evaluate(() => JSON.parse(sessionStorage.getItem('oeffi-guesser-session') ?? 'null')) as Promise<Sess | null>;
const state = async (s: Sess) => (await (await fetch(`${app.base}/api/games/${s.code}?token=${s.token}`)).json()).state as QuizState;
const names = (p: Page) => p.locator('ul.players li').allInnerTexts();
/** einzelne Hälfte eines Surrogatpaars = kaputtes Zeichen */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

async function host(name: string, mode: 'route' | 'quiz' = 'quiz') {
  const t = await app.page();
  await t.page.goto(app.base);
  await setName(t.page, name);
  await t.page.locator(`.mode-${mode}`).click();
  await t.page.locator('#start').waitFor();
  return { t, s: (await session(t.page))! };
}

async function joinByCode(code: string, name: string, viewport: 'desktop' | 'phone' = 'desktop') {
  const t = await app.page({ viewport });
  await t.page.goto(app.base);
  await setName(t.page, name);
  await t.page.locator('#code').fill(code);
  await t.page.locator('#join').click();
  await t.page.locator('#leave').waitFor();
  return { t, s: (await session(t.page))! };
}

const noErrors = (...ts: TestPage[]) => assert.deepEqual(ts.flatMap((t) => t.errors), []);
const closeAll = (...ts: TestPage[]) => Promise.all(ts.map((t) => t.context.close()));

test('gleiche Namen: drei „Max“ heißen Max, Max 2, Max 3 – überall gleich angezeigt', async () => {
  const a = await host('Max');
  const b = await joinByCode(a.s.code, 'Max');
  const c = await joinByCode(a.s.code, 'Max');
  await a.t.page.locator('ul.players li').nth(2).waitFor();
  for (const t of [a.t, b.t, c.t]) {
    const n = (await names(t.page)).join(' | ');
    assert.match(n, /Max/);
    assert.match(n, /Max 2/);
    assert.match(n, /Max 3/);
  }
  noErrors(a.t, b.t, c.t);
  await closeAll(a.t, b.t, c.t);
});

test('Einladungslink (?code=): Name eingeben, beitreten', async () => {
  const a = await host('Host');
  const t = await app.page({ viewport: 'phone' });
  await t.page.goto(`${app.base}/?code=${a.s.code}`);
  await t.page.locator('#inviteName').fill('Gast');
  await t.page.locator('#joinInvite').click();
  await t.page.locator('#leave').waitFor();
  await a.t.page.locator('ul.players li', { hasText: 'Gast' }).waitFor();
  noErrors(a.t, t);
  await closeAll(a.t, t);
});

test('falscher und zu kurzer Code: verständliche Meldung, kein Absturz', async () => {
  const t = await app.page();
  await t.page.goto(app.base);
  await t.page.locator('#code').fill('ZZZZZ');
  await t.page.locator('#join').click();
  await t.page.locator('.toast').first().waitFor();
  const msg = await t.page.locator('.toast').first().innerText();
  assert.ok(msg.length > 5, msg);
  await t.page.locator('#code').fill('AB');
  await t.page.locator('#join').click();
  await t.page.getByText('5-stelligen').waitFor();
  noErrors(t);
  await t.context.close();
});

test('Host verlässt die Lobby → nächster Spieler wird Host und sieht „Starten“', async () => {
  const a = await host('Erster');
  const b = await joinByCode(a.s.code, 'Zweiter');
  a.t.page.once('dialog', (d) => void d.accept());
  await a.t.page.locator('#leave').click();
  await a.t.page.locator('.mode-quiz').waitFor();
  await b.t.page.locator('#start').waitFor({ timeout: 10_000 });
  const st = await state(b.s);
  assert.equal(st.players.length, 1);
  assert.ok(st.players[0].isHost);
  noErrors(a.t, b.t);
  await closeAll(a.t, b.t);
});

test('Host schließt den Tab (Verbindungsabbruch) → offline markiert, Gast wird Host und kann starten', async () => {
  const a = await host('Weg');
  const b = await joinByCode(a.s.code, 'Bleibt');
  await a.t.context.close();
  // Abmeldung nach DISCONNECT_AFTER_MS (15 s) – solange warten wir
  let st = await state(b.s);
  for (let i = 0; i < 40 && st.players.find((p) => p.name === 'Weg')?.connected !== false; i++) {
    await new Promise((r) => setTimeout(r, 500));
    st = await state(b.s);
  }
  const gone = st.players.find((p) => p.name === 'Weg');
  assert.equal(gone?.connected, false, 'Host nach Tab-Schließen nicht als offline markiert');
  // Host geht kurz danach (Prüfung 15,5 s nach dem Abbruch) an den verbundenen Spieler
  for (let i = 0; i < 20 && st.players.find((p) => p.isHost)?.name !== 'Bleibt'; i++) {
    await new Promise((r) => setTimeout(r, 250));
    st = await state(b.s);
  }
  const hostNow = st.players.find((p) => p.isHost)?.name;
  assert.equal(hostNow, 'Bleibt', `nach Verbindungsabbruch ist weiter „${hostNow}“ Host – Gast kann nicht starten`);
  await b.t.page.locator('#start').waitFor({ timeout: 5000 });
  noErrors(b.t);
  await b.t.context.close();
});

test('lange Namen, Sonderzeichen, HTML und Emojis werden sicher und unbeschädigt angezeigt', async () => {
  const a = await host('a' + '😀'.repeat(15));
  const b = await joinByCode(a.s.code, '<img src=x onerror=alert(1)>');
  const c = await joinByCode(a.s.code, '👨‍👩‍👧 Familie Österreicher-Großmann');
  const d = await joinByCode(a.s.code, '      ');
  await a.t.page.locator('ul.players li').nth(3).waitFor();
  const shown = await names(a.t.page);
  const st = await state(a.s);
  // kein HTML ausgeführt (sonst gäbe es ein <img> in der Liste)
  assert.equal(await a.t.page.locator('ul.players img').count(), 0);
  // Leerzeichen-Name → „Spieler N“
  assert.ok(st.players.some((p) => /^Spieler \d+$/.test(p.name)), JSON.stringify(st.players.map((p) => p.name)));
  const graphemes = new Intl.Segmenter('de', { granularity: 'grapheme' });
  for (const p of st.players) assert.ok([...graphemes.segment(p.name)].length <= 20, `Name zu lang: ${p.name}`);
  noErrors(a.t, b.t, c.t, d.t);
  await closeAll(a.t, b.t, c.t, d.t);
  // Befund-Kandidaten am Ende prüfen, damit die übrigen Prüfungen oben immer laufen
  assert.ok(!st.players.some((p) => LONE_SURROGATE.test(p.name)), `kaputtes Emoji im Namen: ${JSON.stringify(st.players.map((p) => p.name))} / ${shown.join(' | ')}`);
  assert.ok(st.players.some((p) => p.name.includes('👨‍👩‍👧')), `Familien-Emoji (ZWJ) zerlegt: ${JSON.stringify(st.players.map((p) => p.name))}`);
});

test('Regression M-09: mehrfach Enter + Klick auf „Beitreten“: nur EIN Spieler kommt dazu', async () => {
  const a = await host('Host');
  const t = await app.page();
  await t.page.goto(app.base);
  await setName(t.page, 'Doppelt');
  await t.page.locator('#code').fill(a.s.code);
  // dreimal Enter schnell hintereinander + Klick, bevor die erste Antwort da ist
  await t.page.route(/\/join$/, async (r) => {
    await new Promise((x) => setTimeout(x, 400));
    await r.continue();
  });
  for (let i = 0; i < 3; i++) await t.page.locator('#code').press('Enter');
  await t.page.locator('#join').click({ force: true, timeout: 500 }).catch(() => {});
  await t.page.waitForTimeout(1500);
  const st = await state(a.s);
  noErrors(a.t, t);
  await closeAll(a.t, t);
  assert.equal(st.players.length, 2, `Spieler in der Lobby: ${st.players.map((p) => p.name).join(', ')}`);
});

test('Doppelklick „Starten“ und „Nächste Frage“: kein Fehler, keine übersprungene Frage', async () => {
  const a = await host('Schnell');
  await a.t.page.locator('[data-k="questions"][data-v="5"]').click();
  await a.t.page.locator('#start').dblclick();
  await a.t.page.locator('.quiz-q h2').waitFor();
  let st = await state(a.s);
  assert.equal(st.current, 0);
  await a.t.page.locator('.quiz-options button[data-o], .pick-lines button[data-o]').first().waitFor({ timeout: 5000 }).catch(() => {});
  // irgendeine Antwort; bei Karten-Fragen auflösen lassen
  if (await a.t.page.locator('.quiz-options button[data-o]').count()) await a.t.page.locator('.quiz-options button[data-o]').first().click();
  else {
    a.t.page.once('dialog', (d) => void d.accept());
    await a.t.page.locator('.hb-cancel').click();
  }
  // beantwortet → Ergebnis-Karte; übersprungen → „Frage übersprungen“ (ohne Karte)
  await a.t.page.locator('.result-card, .cancelled').first().waitFor({ timeout: 30_000 });
  await a.t.page.locator('.btn-big', { hasText: 'Nächste Frage' }).dblclick();
  await a.t.page.locator('.quiz-q h2').waitFor();
  await a.t.page.waitForTimeout(800);
  st = await state(a.s);
  noErrors(a.t);
  await a.t.context.close();
  assert.equal(st.current, 1, `nach Doppelklick bei Frage ${st.current + 1} statt 2`);
});

test('Neuladen mitten in der Quizfrage: gleiche Frage, gleicher Spieler', async () => {
  const a = await host('Reload');
  await a.t.page.locator('#start').click();
  const q1 = await a.t.page.locator('.quiz-q h2').innerText();
  await a.t.page.reload();
  await a.t.page.locator('.quiz-q h2').waitFor();
  assert.equal(await a.t.page.locator('.quiz-q h2').innerText(), q1);
  const s2 = await session(a.t.page);
  assert.equal(s2?.playerId, a.s.playerId);
  noErrors(a.t);
  await a.t.context.close();
});

test('Zurück-Taste in der Lobby: kein Fehler, Lobby bleibt erreichbar', async () => {
  const a = await host('Zurueck');
  await a.t.page.goBack().catch(() => {});
  await a.t.page.waitForTimeout(800);
  // entweder noch in der Lobby oder auf der Startseite – beides ohne Fehler; Lobby muss wieder erreichbar sein
  if (!(await a.t.page.locator('#leave').count())) {
    await a.t.page.goForward().catch(() => {});
    await a.t.page.waitForTimeout(800);
  }
  const where = (await a.t.page.locator('#leave').count()) ? 'Lobby' : 'Startseite';
  noErrors(a.t);
  await a.t.context.close();
  assert.equal(where, 'Lobby', 'nach Zurück/Vor ist die Lobby weg');
});

test('zweiter Tab mit dem Einladungslink im selben Browser: eigener Spieler, kein Durcheinander', async () => {
  const a = await host('TabEins');
  const p2 = await a.t.context.newPage();
  const errs: string[] = [];
  p2.on('pageerror', (e) => errs.push(e.message));
  await p2.goto(`${app.base}/?code=${a.s.code}`);
  await p2.locator('#inviteName').fill('TabZwei');
  await p2.locator('#joinInvite').click();
  await p2.locator('#leave').waitFor();
  const s2 = (await session(p2))!;
  assert.notEqual(s2.playerId, a.s.playerId);
  // Tab 1 ist weiterhin Host, beide in der Liste
  await a.t.page.locator('ul.players li', { hasText: 'TabZwei' }).waitFor();
  assert.equal((await session(a.t.page))?.playerId, a.s.playerId);
  assert.deepEqual(errs, []);
  noErrors(a.t);
  await a.t.context.close();
});

test('zwei Spieler antworten gleichzeitig → beide gewertet, Auflösung kommt automatisch', async () => {
  const a = await host('Anna');
  const b = await joinByCode(a.s.code, 'Ben', 'phone');
  await a.t.page.locator('ul.players li', { hasText: 'Ben' }).waitFor();
  // nur Auswahlfragen, damit beide gleichzeitig klicken können
  const weights = { locate: 1, direct: 7, towards: 7, transfer: 7, uCross: 1, uLink: 1, stopLines: 1, termini: 7, lineShape: 1, draw: 1, district: 7, nextStop: 7, busArea: 1 };
  await fetch(`${app.base}/api/games/${a.s.code}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: a.s.token, settings: { questions: 5, weights } }) });
  await a.t.page.locator('#start').click();
  for (const t of [a.t, b.t]) await t.page.locator('.quiz-q h2').waitFor();
  const opts = (t: TestPage) => t.page.locator('.quiz-options button[data-o], .pick-lines button[data-o]').first();
  await Promise.all([opts(a.t).click(), opts(b.t).click()]);
  for (const t of [a.t, b.t])
    if (await t.page.getByRole('button', { name: 'Antworten' }).count()) await t.page.getByRole('button', { name: 'Antworten' }).click();
  for (const t of [a.t, b.t]) await t.page.locator('.result-card').waitFor({ timeout: 30_000 });
  const st = await state(a.s);
  assert.equal(st.status, 'revealed');
  assert.equal(st.reveal?.results.length, 2);
  noErrors(a.t, b.t);
  await closeAll(a.t, b.t);
});

test('Gast verlässt das laufende Quiz → Quiz läuft für den Rest weiter', async () => {
  const a = await host('Bleiber');
  const b = await joinByCode(a.s.code, 'Geher');
  await a.t.page.locator('#start').click();
  await b.t.page.locator('.quiz-q h2').waitFor();
  // Gast geht über „Verlassen“, falls vorhanden, sonst Tab schließen
  await b.t.context.close();
  // Host beantwortet → Auflösung darf nicht auf den Gast warten (spätestens nach Zeitablauf)
  await a.t.page.waitForTimeout(300);
  if (await a.t.page.locator('.quiz-options button[data-o]').count()) await a.t.page.locator('.quiz-options button[data-o]').first().click();
  else {
    a.t.page.once('dialog', (d) => void d.accept());
    await a.t.page.locator('.hb-cancel').click();
  }
  await a.t.page.locator('.result-card, .cancelled').first().waitFor({ timeout: 70_000 });
  noErrors(a.t);
  await a.t.context.close();
});

test('Regression M-10: schnell hintereinander geänderte Einstellungen kommen alle an (langsamer Server)', async () => {
  const a = await host('Schnell', 'route');
  await a.t.page.route(/\/settings$/, async (r) => {
    await new Promise((x) => setTimeout(x, 300));
    await r.continue();
  });
  await a.t.page.locator('[data-k="rounds"][data-v="3"]').click();
  await a.t.page.locator('[data-k="limit"][data-v="600"]').click();
  await a.t.page.locator('[data-k="rounds"][data-v="10"]').click();
  await a.t.page.waitForTimeout(1500);
  const st = (await (await fetch(`${app.base}/api/games/${a.s.code}?token=${a.s.token}`)).json()).state;
  assert.deepEqual([st.settings.rounds, st.settings.roundTimeLimitSec], [10, 600]);
  noErrors(a.t);
  await a.t.context.close();
});

test('Regression M-10: während der Host einen Regler zieht, zeichnet ein Beitritt die Lobby nicht neu – danach schon', async () => {
  const a = await host('Zieher', 'route');
  const p = a.t.page;
  await p.locator('details.advanced summary').click();
  const range = p.locator('input[data-k="minTransfers"]');
  await p.waitForTimeout(500);
  await range.scrollIntoViewIfNeeded();
  const box = (await range.boundingBox())!;
  await p.mouse.move(box.x + 2, box.y + box.height / 2);
  await p.mouse.down();
  // erst jetzt festhalten: ab dem Drücken darf der Regler nicht mehr ersetzt werden
  const handle = await range.elementHandle();
  await fetch(`${app.base}/api/games/${a.s.code}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: 'Gast' }) });
  await p.waitForTimeout(800);
  assert.equal(await handle!.evaluate((el) => el.isConnected), true, 'Regler wurde während des Ziehens neu gezeichnet');
  await p.mouse.up();
  await p.locator('ul.players li', { hasText: 'Gast' }).waitFor({ timeout: 3000 });
  noErrors(a.t);
  await a.t.context.close();
});

test('Kicken und Chat: Host entfernt Gast (Gast landet auf der Startseite mit Meldung), Chat-Nachrichten kommen live an', async () => {
  const a = await host('Chef');
  const b = await joinByCode(a.s.code, 'Gast');
  const c = await joinByCode(a.s.code, 'Zweiter');
  // Chat: Gast öffnet, schreibt; Host sieht Zähler, öffnet, sieht Nachricht (HTML als Text)
  await b.t.page.locator('.chat-toggle').click();
  await b.t.page.locator('.chat-input').fill('Hallo <b>alle</b> 👋');
  await b.t.page.locator('.chat-input').press('Enter');
  await a.t.page.locator('.chat-badge', { hasText: '1' }).waitFor();
  await a.t.page.locator('.chat-toggle').click();
  await a.t.page.locator('.chat-list li', { hasText: 'Hallo <b>alle</b> 👋' }).waitFor();
  assert.equal(await a.t.page.locator('.chat-list b', { hasText: 'alle' }).count(), 0, 'HTML im Chat wurde ausgeführt');
  await a.t.shot('lobby-chat');
  // Kicken: nur der Host sieht ✕, nicht bei sich selbst
  assert.equal(await b.t.page.locator('[data-kick]').count(), 0);
  assert.equal(await a.t.page.locator('[data-kick]').count(), 2);
  a.t.page.once('dialog', (d) => void d.accept());
  await a.t.page.locator('[data-kick][data-name="Gast"]').click();
  await b.t.page.locator('.toast', { hasText: 'entfernt' }).waitFor();
  await b.t.page.locator('.mode-quiz').waitFor();
  await a.t.page.locator('.chat-list li.system', { hasText: 'Gast wurde vom Host entfernt' }).waitFor();
  await c.t.page.locator('ul.players li', { hasText: 'Gast' }).waitFor({ state: 'detached' });
  noErrors(a.t, b.t, c.t);
  await closeAll(a.t, b.t, c.t);
});

test('Punkt 1/19: im laufenden Quiz Spieler verwalten – Gast zum Host machen, anderen Gast kicken', async () => {
  const a = await host('Chefin');
  const b = await joinByCode(a.s.code, 'Bert');
  const c = await joinByCode(a.s.code, 'Cleo');
  await a.t.page.locator('ul.players li', { hasText: 'Cleo' }).waitFor();
  await a.t.page.locator('#start').click();
  await a.t.page.locator('.quiz-q h2').waitFor();
  // Host-Leiste ist auf dem Desktop offen → Spielerliste aufklappen
  await a.t.page.locator('.hb-players').click();
  await a.t.page.locator('.hb-list [data-host][data-name="Bert"]').click();
  await b.t.page.locator('details.host-bar summary', { hasText: 'Host' }).waitFor();
  a.t.page.once('dialog', (d) => void d.accept());
  await a.t.page.locator('.hb-list [data-kick][data-name="Cleo"]').click();
  await c.t.page.locator('.toast', { hasText: 'entfernt' }).waitFor();
  const st = await state(a.s);
  assert.deepEqual(st.players.map((p) => `${p.name}${p.isHost ? '👑' : ''}`).sort(), ['Bert👑', 'Chefin👑']);
  noErrors(a.t, b.t, c.t);
  await closeAll(a.t, b.t, c.t);
});
