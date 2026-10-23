// npm run smoke – automatischer Klick-Durchlauf im echten Browser (Edge/Chrome, unsichtbar) vor jedem Release.
// Baut den Client, startet einen Testserver und klickt sich durch: Startseite → Lernen (Netzkarte, Vergleich, alle
// Kurse, Üben mit Zeichnen) → Routenjagd- und Quiz-Lobby. Jeder JavaScript-Fehler auf der Seite lässt den Lauf scheitern.
// Spielrunden selbst werden nicht gestartet – die bräuchten die Wiener-Linien-Auskunft.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const headed = process.argv.includes('--headed');

const errors: string[] = [];
let step = '';
const log = (msg: string) => console.log(`  ✔ ${msg}`);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* startet noch */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Testserver startet nicht');
}

async function launch(): Promise<Browser> {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: !headed });
    } catch {
      /* nächsten Browser probieren */
    }
  }
  throw new Error('Weder Edge noch Chrome gefunden');
}

/** Kurs-Schritt beantworten: Auswahl, Mehrfachauswahl, Ordnen, Karte antippen bzw. zeichnen */
async function answerStep(page: Page) {
  if (await page.locator('.course-quiz button[data-o]:not([disabled])').count()) return page.locator('.course-quiz button[data-o]:not([disabled])').first().click();
  if (await page.locator('[data-m]:not([disabled])').count()) {
    await page.locator('[data-m]:not([disabled])').first().click();
    return page.locator('#t-ok').click();
  }
  while (await page.locator('[data-ord]').count()) await page.locator('[data-ord]').first().click();
  if (await page.locator('.course-task #t-ok').count()) {
    await page.waitForTimeout(300);
    const b = (await page.locator('#map').boundingBox())!;
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
    if (await page.locator('.course-task #t-ok[disabled]').count()) await page.mouse.click(b.x + b.width * 0.55, b.y + b.height * 0.45);
    await page.locator('.course-task #t-ok').click();
  }
}

async function run(page: Page) {
  const click = async (sel: string) => {
    step = `klicke ${sel}`;
    await page.locator(sel).first().click();
  };
  const see = async (sel: string, text?: string) => {
    step = `warte auf ${sel}${text ? ` „${text}“` : ''}`;
    const loc = text ? page.locator(sel, { hasText: text }).first() : page.locator(sel).first();
    await loc.waitFor({ timeout: 15000 });
  };

  await page.goto(BASE);
  await see('.mode-learn');
  await page.fill('#name', 'Smoke');
  log('Startseite');

  // ---- Lernen: Startseite, Netzkarte, Steckbrief, Vergleich
  await click('.mode-learn');
  await see('.learn-hub');
  await page.fill('#hub-search', '13A');
  await see('#atlas-search');
  await page.press('#atlas-search', 'Enter');
  await see('.atlas-card', '13A');
  log('Netzkarte: Suche → Steckbrief 13A');
  await click('#compare');
  await page.fill('#atlas-search', '66A');
  await page.press('#atlas-search', 'Enter');
  await see('.compare-table');
  log('Vergleich 13A ⇄ 66A');
  await page.fill('#atlas-search', 'Praterstern');
  await see('.station-opt', 'Praterstern');
  await click('.station-opt');
  await see('.atlas-card h3', 'Praterstern');
  log('Station Praterstern: „Von hier fährst du mit …“');
  await click('#overview');
  await click('#back');
  await see('.learn-hub');

  // ---- alle Kurse durchklicken (Fragen: irgendeine Antwort)
  const ids = await page.$$eval('.all-courses .course-card', (els) => els.map((e) => (e as HTMLElement).dataset.course!));
  for (const id of ids) {
    await see('.learn-hub');
    await page.locator('.all-courses summary').click();
    await click(`.all-courses .course-card[data-course="${id}"]`);
    await see('.course-step');
    // einmal eine Liniennummer im Text antippen → Steckbrief → zurück
    if (await page.locator('.course-step .chip-link').count()) {
      await click('.course-step .chip-link');
      await see('#to-course');
      await click('#to-course');
      await see('.course-step');
    }
    for (let n = 0; n < 60; n++) {
      if (await page.getByText('Kurs geschafft').count()) break;
      await answerStep(page);
      step = `Kurs ${id}: weiter`;
      await page.locator('#next:not([disabled])').click();
    }
    await see('h3', 'Kurs geschafft');
    log(`Kurs „${id}“`);
    await click('#list');
  }

  // ---- Üben: zufällige Linien, ansehen → nachzeichnen → Vergleich
  await see('.learn-hub');
  await click('#random');
  await click('.btn-big');
  await see('#go');
  await click('#go');
  await see('.pin-start');
  const box = (await page.locator('#map').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await click('#done');
  await see('.score-ring');
  log('Üben: nachzeichnen und vergleichen');
  await click('#setup');
  await click('#back');

  // ---- Lobbys anlegen (ohne Runde zu starten) und wieder verlassen
  for (const mode of ['route', 'quiz']) {
    await see(`.mode-${mode}`);
    await click(`.mode-${mode}`);
    await see('#leave');
    log(`${mode === 'route' ? 'Routenjagd' : 'Quiz'}-Lobby`);
    page.once('dialog', (d) => void d.accept());
    await click('#leave');
  }
  await see('.mode-learn');
}

async function main() {
  console.log('▶ Client bauen …');
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'], { stdio: 'inherit' });
  const state = mkdtempSync(path.join(tmpdir(), 'bimguesser-smoke-'));
  console.log('▶ Testserver starten …');
  const server = spawn(process.execPath, ['server/index.ts'], { env: { ...process.env, PORT: String(PORT), STATE_DIR: state }, stdio: 'ignore' });
  let browser: Browser | null = null;
  try {
    await waitForServer();
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (e) => errors.push(`${step}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${step}: ${m.text()}`);
    });
    console.log('▶ Klick-Durchlauf …');
    await run(page);
  } catch (e) {
    errors.push(`${step}: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    await browser?.close();
    server.kill();
    rmSync(state, { recursive: true, force: true });
  }
  if (errors.length) {
    console.error(`\n✖ Klick-Durchlauf fehlgeschlagen:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\n✔ Klick-Durchlauf ohne Fehler');
}

main();
