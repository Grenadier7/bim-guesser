// E2E-Gerüst: startet den gebauten Server auf einem freien Port und einen echten Browser (installierter Edge/Chrome
// über playwright-core – kein Browser-Download). Jede Seite sammelt JavaScript- und Konsolenfehler; Screenshots
// landen in test/e2e/artifacts (nicht versioniert).
//
// Voraussetzung: `npm run build` (dist/). `npm run e2e` erledigt das.
// Der Auskunfts-Cache liegt in test/e2e/.state und bleibt zwischen den Läufen erhalten – sonst würde jede
// Routenjagd-Runde die Wiener-Linien-Auskunft neu abfragen.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const ARTIFACTS = path.join(ROOT, 'test/e2e/artifacts');
const STATE = path.join(ROOT, 'test/e2e/.state');

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface App {
  base: string;
  browser: Browser;
  /** neue Seite (eigener Kontext = eigener localStorage), Fehler werden in `errors` gesammelt */
  page(opts?: { viewport?: keyof typeof VIEWPORTS }): Promise<TestPage>;
  close(): Promise<void>;
}

export interface TestPage {
  page: Page;
  context: BrowserContext;
  errors: string[];
  shot(name: string): Promise<string>;
}

export async function startApp(env: Record<string, string> = {}): Promise<App> {
  if (!existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('dist/ fehlt – erst `npm run build`');
  mkdirSync(STATE, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server: ChildProcess = spawn(process.execPath, ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), STATE_DIR: STATE, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr?.on('data', (d) => (serverErr += String(d)));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* startet noch */
    }
    if (i > 80) {
      server.kill();
      throw new Error(`Testserver startet nicht: ${serverErr.slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  let browser: Browser | null = null;
  for (const channel of ['msedge', 'chrome']) {
    try {
      browser = await chromium.launch({ channel, headless: !process.env.HEADED });
      break;
    } catch {
      /* nächsten Browser probieren */
    }
  }
  if (!browser) {
    server.kill();
    throw new Error('Weder Edge noch Chrome gefunden');
  }
  const b = browser;
  return {
    base,
    browser: b,
    async page(opts = {}) {
      const context = await b.newContext({ viewport: VIEWPORTS[opts.viewport ?? 'desktop'] });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
      });
      page.on('response', (r) => {
        // 4xx sind oft gewollt (z.B. falscher Lobby-Code) – nur Serverfehler zählen
        if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`);
      });
      return {
        page,
        context,
        errors,
        async shot(name: string) {
          const file = path.join(ARTIFACTS, `${name}.png`);
          await page.screenshot({ path: file, fullPage: false });
          return file;
        },
      };
    },
    async close() {
      await b.close();
      server.kill();
    },
  };
}

/** Name eingeben (Startseite) – Lobby-Erstellung braucht keinen, aber Mitspieler sollen unterscheidbar sein */
export async function setName(p: Page, name: string) {
  await p.locator('#name').fill(name);
}
