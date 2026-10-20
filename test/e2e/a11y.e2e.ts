// Barrierefreiheit & Layout (Phase 2c): axe-core (WCAG 2 A/AA) auf allen Hauptbildschirmen, Handy und Desktop,
// dazu horizontales Scrollen und zu kleine Touch-Ziele. Ergebnis: test/e2e/artifacts/a11y.json + Screenshots.
// Harte Prüfung nur für „keine kritischen axe-Verstöße“ und „kein horizontales Scrollen“ – der Rest ist Messwert.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Page } from 'playwright-core';
import { ARTIFACTS, VIEWPORTS, setName, startApp, type App } from './harness.ts';

const AXE = readFileSync(path.resolve(import.meta.dirname, '../../node_modules/axe-core/axe.min.js'), 'utf8');

let app: App;
const report: Record<string, unknown> = {};
before(async () => (app = await startApp({ RATE_LIMIT_SCALE: '1000' })));
after(async () => {
  writeFileSync(path.join(ARTIFACTS, 'a11y.json'), JSON.stringify(report, null, 2));
  await app?.close();
});

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[]; failureSummary?: string }[];
}

async function audit(p: Page, name: string) {
  // CSP verbietet Inline-Skripte – über das DevTools-Protokoll einspielen
  await p.evaluate(AXE);
  const v = (await p.evaluate(async () => {
    // @ts-expect-error axe wird zur Laufzeit eingespielt
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] });
    return r.violations.map((x: Violation) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.slice(0, 5).map((n) => ({ target: n.target, failureSummary: n.failureSummary })) }));
  })) as Violation[];
  const layout = await p.evaluate(() => {
    const scrollX = document.scrollingElement!.scrollWidth - innerWidth;
    const small = [...document.querySelectorAll<HTMLElement>('button, a, input, select, [role=button]')]
      .filter((e) => e.offsetParent && !e.closest('.leaflet-control-attribution'))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 24 || r.height < 24))
      .map(({ e, r }) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : ''} ${Math.round(r.width)}×${Math.round(r.height)}`);
    const tiny = [...document.querySelectorAll<HTMLElement>('body *')].filter(
      (e) => e.offsetParent && e.childNodes.length && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12,
    ).length;
    return { scrollX, smallTargets: [...new Set(small)].slice(0, 15), tinyTextElements: tiny };
  });
  report[name] = { violations: v, ...layout };
  return { v, layout };
}

const SCREENS: { name: string; go: (p: Page) => Promise<void> }[] = [
  { name: 'start', go: async (p) => void (await p.locator('.mode-learn').waitFor()) },
  {
    name: 'routenjagd-lobby',
    go: async (p) => {
      await setName(p, 'A11y');
      await p.locator('.mode-route').click();
      await p.locator('#start').waitFor();
      await p.locator('details.advanced summary').click();
    },
  },
  {
    name: 'quiz-lobby',
    go: async (p) => {
      await p.locator('.mode-quiz').click();
      await p.locator('#start').waitFor();
    },
  },
  {
    name: 'quiz-frage',
    go: async (p) => {
      await p.locator('.mode-quiz').click();
      await p.locator('#start').click();
      await p.locator('.quiz-q h2').waitFor();
    },
  },
  {
    name: 'training',
    go: async (p) => {
      await p.locator('.mode-training').click();
      await p.locator('#start').waitFor();
    },
  },
  {
    name: 'lernen',
    go: async (p) => {
      await p.locator('.mode-learn').click();
      await p.locator('.learn-hub').waitFor();
    },
  },
  {
    name: 'steckbrief',
    go: async (p) => {
      await p.locator('.mode-learn').click();
      await p.locator('#hub-search').fill('U6');
      await p.locator('#atlas-search').press('Enter');
      await p.locator('.atlas-card').waitFor();
    },
  },
];

for (const vp of ['phone', 'desktop'] as const)
  for (const s of SCREENS)
    test(`${s.name} (${vp} ${VIEWPORTS[vp].width}px)`, { todo: s.name === 'quiz-lobby' ? 'Befund U-01: Bezirksauswahl ohne Beschriftung' : undefined }, async () => {
      const t = await app.page({ viewport: vp });
      await t.page.goto(app.base);
      await s.go(t.page);
      await t.page.waitForTimeout(400);
      await t.shot(`a11y-${s.name}-${vp}`);
      const { v, layout } = await audit(t.page, `${s.name}-${vp}`);
      assert.deepEqual(t.errors, []);
      await t.context.close();
      assert.ok(layout.scrollX <= 1, `horizontales Scrollen: ${layout.scrollX}px`);
      const critical = v.filter((x) => x.impact === 'critical');
      assert.deepEqual(critical.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`), []);
    });
