// Startet den Server (ohne Browser) auf einem freien Port – für API-Tests.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

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

export interface TestServer {
  base: string;
  stateDir: string;
  /** JSON-Anfrage; liefert Status und geparsten Body */
  call<T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Headers }>;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bimguesser-test-'));
  const proc = spawn(process.execPath, ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), STATE_DIR: stateDir, RATE_LIMIT_SCALE: '1000', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  proc.stderr?.on('data', (d) => (err += String(d)));
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* startet noch */
    }
    if (i > 80) {
      proc.kill();
      throw new Error(`Server startet nicht: ${err.slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    base,
    stateDir,
    async call(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      const text = await res.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* kein JSON */
      }
      return { status: res.status, body: parsed, headers: res.headers };
    },
    async stop() {
      const exited = new Promise((r) => (proc.exitCode != null ? r(null) : proc.once('exit', r)));
      proc.kill();
      await exited;
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
