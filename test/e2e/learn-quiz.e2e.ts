// E2E: Lernen (Netzkarte, Steckbrief, Vergleich, Kurs) und ein komplettes Solo-Quiz im Browser.
// Die Zählungen der Netzkarte sind Charakterisierungswerte: Ändert ein Umbau die Darstellung, fällt es hier auf.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { NetworkPublic } from '../../shared/types.ts';
import { answerCourseStep, setName, startApp, type App, type TestPage } from './harness.ts';

let app: App;
before(async () => (app = await startApp({ RATE_LIMIT_SCALE: '1000' })));
after(async () => app?.close());

test('Netzkarte: Lernen-Startseite zeichnet das ganze Netz, Linie antippen öffnet den Steckbrief', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.locator('.mode-learn').click();
  await p.locator('.learn-hub').waitFor();
  await p.waitForTimeout(800);
  // Netzkarte: Linien (SVG-Pfade im eigenen Pane), Klickflächen, Punkte
  const counts = await p.evaluate(() => {
    const pane = document.querySelector('.leaflet-net-pane')!;
    const paths = [...pane.querySelectorAll('path')];
    return {
      paths: paths.length,
      hits: paths.filter((x) => x.getAttribute('stroke-opacity') === '0').length,
      tags: document.querySelectorAll('.leaflet-netLabels-pane .net-tags').length,
    };
  });
  assert.ok(counts.paths > 1500, `zu wenige Netz-Elemente: ${counts.paths}`);
  assert.ok(counts.hits > 300, `Linien nicht antippbar: ${counts.hits}`);
  assert.ok(counts.tags > 30, `zu wenige Liniennummern: ${counts.tags}`);
  await t.shot('learn-hub');
  // Suche → Steckbrief
  await p.locator('#hub-search').fill('U6');
  await p.locator('#atlas-search').press('Enter');
  await p.locator('.atlas-card', { hasText: 'Floridsdorf' }).waitFor();
  await p.locator('.atlas-card .learn-line', { hasText: 'U6' }).waitFor();
  // Station aus der Liste → „Von hier“
  await p.locator('.atlas-card details summary').click();
  await p.locator('.stop-list [data-st]', { hasText: 'Westbahnhof' }).first().click();
  await p.locator('.atlas-card h3', { hasText: 'Westbahnhof' }).waitFor();
  assert.ok((await p.locator('.deps li').count()) >= 5, 'zu wenige Linien am Westbahnhof');
  await t.shot('atlas-station');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

/** Kurs mit allen Aufgaben durcharbeiten, dann die Prüfung bis zum Ende; Screenshots von Karten-Aufgaben */
async function runCourse(t: TestPage, id: string) {
  const p = t.page;
  await p.goto(app.base);
  await p.locator('.mode-learn').click();
  await p.locator('.all-courses summary').click();
  await p.locator(`.all-courses .course-card[data-course="${id}"]`).click();
  const kinds = new Set<string>();
  for (let i = 0; i < 40; i++) {
    if (await p.getByText('Kurs geschafft').count()) break;
    const h3 = await p.locator('.course-step h3').first().innerText();
    if (/^(📍|🗺|✏️|🔢|☑️)/.test(h3) && !kinds.has(h3.slice(0, 2))) {
      kinds.add(h3.slice(0, 2));
      await t.shot(`course-${id}-task-${kinds.size}`);
    }
    await answerCourseStep(p);
    await p.locator('#next:not([disabled])').click();
  }
  await p.getByText('Kurs geschafft').waitFor();
  // Prüfung bis zum Ende (Antworten zufällig – Wiederholungen inklusive)
  await p.locator('#exam').click();
  for (let i = 0; i < 30; i++) {
    if (await p.locator('#exam-again').count()) break;
    await p.locator('.course-task h3').waitFor();
    await answerCourseStep(p);
    await p.locator('#next:not([disabled])').click();
  }
  await p.locator('#exam-again').waitFor();
  await t.shot(`course-${id}-exam-done`);
  return kinds;
}

test('Kurs U-Bahn: Karten-Aufgaben im Kurs und Abschlussprüfung bis zum Ende', async () => {
  const t = await app.page();
  const kinds = await runCourse(t, 'ubahn');
  assert.ok(kinds.size >= 2, `zu wenige Aufgaben-Arten: ${[...kinds].join(' ')}`);
  // Lernpfad zeigt den Kurs als erledigt (✓ oder ⭐)
  await t.page.locator('#list').click();
  await t.page.locator('.all-courses summary').click();
  await t.page.locator('.course-card[data-course="ubahn"] .cc-done').waitFor();
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Ohne Prüfung direkt zum nächsten Kurs (U-Bahn → S-Bahn)', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.locator('.mode-learn').click();
  await p.locator('.all-courses summary').click();
  await p.locator('.all-courses .course-card[data-course="ubahn"]').click();
  for (let i = 0; i < 40 && !(await p.getByText('Kurs geschafft').count()); i++) {
    await answerCourseStep(p);
    await p.locator('#next:not([disabled])').click();
  }
  await p.locator('#next-course', { hasText: 'Die S-Bahn' }).click();
  await p.locator('.course-head h2', { hasText: 'Die S-Bahn' }).waitFor();
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Kurs Busnummern: Gegend der 80er/90er auf der Karte antippen, Prüfung', async () => {
  const t = await app.page();
  const kinds = await runCourse(t, 'busnr');
  assert.ok(kinds.has('🗺'), `keine Gegend-Aufgabe: ${[...kinds].join(' ')}`);
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Quiz allein: Lobby → 5 Fragen → Endstand', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await setName(p, 'E2E-Quiz');
  await p.locator('.mode-quiz').click();
  await p.locator('[data-k="questions"][data-v="5"]').click();
  await p.locator('#start').click();
  for (let q = 0; q < 5; q++) {
    await p.locator('.quiz-q h2').waitFor();
    // Karte wird bei „Wo liegt …?“/„Linie zeichnen“ groß – Position jedes Mal neu messen
    await p.waitForTimeout(300);
    const map = (await p.locator('#map').boundingBox())!;
    // antworten – je nach Fragetyp
    if (await p.locator('.quiz-options button[data-o]').count()) await p.locator('.quiz-options button[data-o]').first().click();
    else if (await p.locator('.pick-lines button[data-o]').count()) {
      await p.locator('.pick-lines button[data-o]').first().click();
      await p.getByRole('button', { name: 'Antworten' }).click();
    } else {
      // Wo liegt …? bzw. Linie zeichnen: auf die Karte tippen
      await p.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
      await p.mouse.click(map.x + map.width / 2 + 30, map.y + map.height / 2 + 20);
      await p.locator('.quiz-q button.btn-primary').click();
    }
    await p.locator('.result-card').waitFor();
    await p.locator('.btn-big', { hasText: q === 4 ? 'Zum Endergebnis' : 'Nächste Frage' }).click();
  }
  await p.locator('.final h2', { hasText: 'Quiz-Endstand' }).waitFor();
  await t.shot('quiz-final');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('N-1/N-2/N-3: Linien einer Gegend üben, Takt im Steckbrief, U-Bahn-Farben im Vergleich', async () => {
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.locator('.mode-learn').click();
  // Gegend: 1. Bezirk, ohne Bus
  await p.locator('#area').click();
  await p.locator('#area-district').selectOption('1');
  await p.locator('.area-lines .chip').first().waitFor();
  const withBus = await p.locator('.area-lines .chip').count();
  await p.locator('[data-mode="B"]').click();
  const noBus = await p.locator('.area-lines .chip').count();
  assert.ok(withBus > noBus && noBus >= 4, `mit Bus ${withBus}, ohne ${noBus}`);
  await t.shot('learn-area');
  await p.locator('#area-practice').click();
  await p.locator('.btn-big').first().click();
  await p.locator('#go').waitFor();
  // zurück zur Gegend, dann Lernen-Start
  await p.goto(app.base);
  await p.locator('.mode-learn').click();
  await p.locator('#hub-search').fill('U6');
  await p.locator('#atlas-search').press('Enter');
  await p.locator('.atlas-card .headway', { hasText: 'Mo–Fr' }).waitFor();
  // Vergleich U6 ⇄ U3: Chips in den echten Linienfarben
  await p.locator('#compare').click();
  await p.locator('#atlas-search').fill('U3');
  await p.locator('#atlas-search').press('Enter');
  await p.locator('.compare-head').waitFor();
  const colors = await p.locator('.compare-head .chip').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  assert.deepEqual(colors, ['rgb(157, 105, 48)', 'rgb(238, 125, 0)']);
  await t.shot('learn-compare-u');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});

test('Punkt 6: Welcher Bus fährt hier? – richtig antippen, Fehler kommen nochmal, Auswertung', async () => {
  const net = (await (await fetch(`${app.base}/api/network`)).json()) as NetworkPublic;
  const t = await app.page();
  const p = t.page;
  await p.goto(app.base);
  await p.locator('.mode-learn').click();
  await p.locator('#busquiz').click();
  await p.locator('#bq-district').selectOption('13');
  await p.locator('#bq-start').click();
  // erste Station richtig: genau die Busse antippen, die dort halten
  const stId = (await p.locator('.busquiz[data-station]').getAttribute('data-station'))!;
  const opts = await p.locator('.bq-opt').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.bus!));
  const here = opts.filter((id) => net.lines.find((l) => l.id === id)!.patterns.some((pt) => pt.includes(stId)));
  assert.ok(here.length >= 1 && opts.length >= 6, `${here.length} richtige von ${opts.length} Vorschlägen`);
  for (const id of here) await p.locator(`.bq-opt[data-bus="${id}"]`).click();
  await t.shot('busquiz-question');
  await p.locator('#bq-check').click();
  await p.locator('h3', { hasText: 'Genau richtig' }).waitFor();
  await p.waitForTimeout(900);
  await t.shot('busquiz-reveal');
  // Rest: „Weiß ich nicht“ – jede Station kommt einmal nochmal, dann die Auswertung
  let asked = 1;
  while (!(await p.locator('#bq-again').count())) {
    await p.locator('#bq-next').click();
    if (await p.locator('#bq-again').count()) break;
    await p.locator('#bq-skip').click();
    asked++;
  }
  assert.ok(asked >= 18, `${asked} Fragen (10 + Wiederholungen)`);
  await p.locator('h3', { hasText: '1 von 10 Stationen' }).waitFor();
  await t.shot('busquiz-summary');
  assert.deepEqual(t.errors, []);
  await t.context.close();
});
