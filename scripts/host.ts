// npm start: Client bauen, Server starten und (falls NGROK_URL gesetzt) den ngrok-Tunnel öffnen.
//   npm start -- --no-build    ohne neu zu bauen
//   npm start -- --local       ohne ngrok
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* keine .env – dann eben ohne */
}

const PORT = process.env.PORT ?? '3000';
const NGROK_URL = args.includes('--local') ? '' : (process.env.NGROK_URL ?? '').trim();

// ---------------------------------------------------------------- 1. Client bauen

if (!args.includes('--no-build')) {
  console.log('▶ Baue Client …');
  const vite = path.join(ROOT, 'node_modules/vite/bin/vite.js');
  const res = spawnSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------- 2. Server

const children: ChildProcess[] = [];
const server = spawn(process.execPath, ['server/index.ts'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT } });
children.push(server);
server.on('exit', (code) => {
  for (const c of children) if (c !== server) c.kill();
  process.exit(code ?? 0);
});

// ---------------------------------------------------------------- 3. ngrok

function findNgrok(): string | null {
  const exe = process.platform === 'win32' ? 'ngrok.exe' : 'ngrok';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  // per winget installiert, aber Terminal noch nicht neu gestartet
  const winget = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages');
  if (process.platform === 'win32' && existsSync(winget)) {
    const dir = readdirSync(winget).find((d) => d.toLowerCase().startsWith('ngrok.ngrok'));
    if (dir && existsSync(path.join(winget, dir, exe))) return path.join(winget, dir, exe);
  }
  return null;
}

function startNgrok() {
  const bin = findNgrok();
  if (!bin) {
    console.log('⚠ ngrok nicht gefunden – installieren mit: winget install ngrok.ngrok  (Spiel läuft nur lokal)');
    return;
  }
  const url = NGROK_URL.startsWith('http') ? NGROK_URL : `https://${NGROK_URL}`;
  const ngArgs = ['http', PORT, '--url', url, '--log', 'stdout', '--log-format', 'json'];
  // optionaler Passwortschutz: Browser fragt beim ersten Aufruf nach Benutzer/Passwort
  const password = (process.env.NGROK_PASSWORD ?? '').trim();
  if (password) {
    if (password.length < 8) {
      console.log('⚠ NGROK_PASSWORD muss mindestens 8 Zeichen haben – Passwortschutz ist AUS.');
    } else {
      const user = (process.env.NGROK_USER ?? 'wien').trim() || 'wien';
      const policy = path.join(os.tmpdir(), `oeffi-guesser-ngrok-${process.pid}.json`);
      const rules = { on_http_request: [{ actions: [{ type: 'basic-auth', config: { credentials: [`${user}:${password}`] } }] }] };
      writeFileSync(policy, JSON.stringify(rules), { mode: 0o600 });
      process.on('exit', () => rmSync(policy, { force: true }));
      ngArgs.push('--traffic-policy-file', policy);
      console.log(`🔒 Passwortschutz aktiv – Benutzer: ${user}`);
    }
  }
  const ng = spawn(bin, ngArgs, { cwd: ROOT });
  children.push(ng);
  const reported = new Set<string>();
  let buf = '';
  ng.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      let e: { msg?: string; lvl?: string; err?: string; url?: string };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.msg === 'started tunnel' && e.url) {
        console.log(`\n🌍 Öffentlich erreichbar: ${e.url}\n   (Besucher klicken beim ersten Mal auf der ngrok-Seite „Visit Site“)\n`);
      } else if (e.err && e.err !== '<nil>' && (e.lvl === 'eror' || e.lvl === 'crit' || /failed/i.test(e.err))) {
        const msg = e.err.split('\r\n')[0].slice(0, 300);
        if (!reported.has(msg)) {
          reported.add(msg);
          console.log(`⚠ ngrok: ${msg}`);
          if (/ERR_NGROK_334|already online/i.test(e.err)) console.log('   → Läuft ngrok schon in einem anderen Fenster? Dort beenden.');
          if (/too old/i.test(e.err)) console.log('   → ngrok aktualisieren mit: ngrok update');
        }
      }
    }
  });
  ng.on('exit', (code) => {
    if (code) console.log(`⚠ ngrok wurde beendet (Code ${code}) – das Spiel läuft weiter nur lokal auf http://localhost:${PORT}`);
  });
}

if (NGROK_URL) startNgrok();
else console.log(`ℹ Kein NGROK_URL in .env – das Spiel läuft nur lokal auf http://localhost:${PORT}`);

// ---------------------------------------------------------------- Beenden (Strg+C)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const c of children) c.kill();
    process.exit(0);
  });
}
