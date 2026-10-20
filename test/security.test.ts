// Sicherheit & Robustheit (Analyse Phase 2d): Eingaben, Autorisierung, Lösung im öffentlichen Zustand,
// Ressourcen-Limits, Fehlerbehandlung. Tests, die eine bekannte Schwachstelle nachweisen, sind als
// `todo` markiert (Befund-ID siehe docs/analysis/raw/2d-sicherheit.md) – sie laufen, brechen die Suite aber nicht.
//
// Die Wiener-Linien-Auskunft wird NIE echt abgefragt: Tests mit Spielstart der Routenjagd starten diese Datei
// selbst als Server-Prozess (BIMGUESSER_MOCK_EFA=1), der `globalThis.fetch` durch eine Attrappe ersetzt.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

if (process.env.BIMGUESSER_MOCK_EFA === '1') await runMockServer();
else defineTests();

// ================================================================ Server mit Auskunfts-Attrappe

/** Läuft im Kindprozess: Express-App mit gefälschter Auskunft; /__mock/fail schaltet auf „Auskunft weg“ */
async function runMockServer() {
  const { Network } = await import('../server/network.ts');
  const { createApp } = await import('../server/app.ts');
  const { naiveMinutes } = await import('../server/efa.ts');
  const net = Network.load();
  const efa2st = new Map<string, string>();
  for (const [sid, ids] of Object.entries(net.data.efaIds)) for (const id of ids) efa2st.set(id, sid);
  let fail = false;
  let slowMs = 0;
  let calls = 0;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const point = (sid: string, min: number) => {
    const d = new Date(min * 60000);
    const s = net.station(sid);
    return {
      name: s.name,
      ref: { id: net.data.efaIds[sid][0], coords: `${s.lon},${s.lat}` },
      dateTime: { date: `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`, time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` },
    };
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls++;
    if (fail) throw new TypeError('fetch failed (Attrappe: Auskunft nicht erreichbar)');
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    const url = new URL(input instanceof Request ? input.url : String(input));
    const q = url.searchParams;
    if (!url.pathname.endsWith('XML_TRIP_REQUEST2')) return new Response(JSON.stringify({ departureList: [] }));
    const o = efa2st.get(q.get('name_origin') ?? '');
    const d = efa2st.get(q.get('name_destination') ?? '');
    if (!o || !d) return new Response(JSON.stringify({ trips: [] }));
    const dt = q.get('itdDate')!;
    const tm = q.get('itdTime')!;
    const T = naiveMinutes(+dt.slice(0, 4), +dt.slice(4, 6), +dt.slice(6, 8), +tm.slice(0, 2), +tm.slice(2, 4));
    const trips = Array.from({ length: Number(q.get('calcNumberOfTrips') ?? 5) }, (_, i) => ({
      legs: [{ points: [point(o, T + 1 + i * 5), point(d, T + 21 + i * 5)], mode: { code: 2, number: 'U6' }, stopSeq: [], path: '' }],
    }));
    return new Response(JSON.stringify({ trips }));
  }) as typeof fetch;

  const { app } = createApp({ net, version: 'mock' });
  const server = http.createServer((req, res) => {
    if (req.url === '/__mock/fail') return void ((fail = true), res.end('fail'));
    if (req.url === '/__mock/calls') return void res.end(String(calls));
    if (req.url === '/__mock/slow') return void ((slowMs = 400), res.end('slow'));
    app(req, res);
  });
  server.listen(Number(process.env.PORT));
}

// ================================================================ Hilfen

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

interface Res {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

interface Srv {
  base: string;
  port: number;
  stateDir: string;
  proc: ChildProcess;
  /** stdout + stderr des Servers */
  log(): string;
  exitCode(): number | null | undefined;
  call(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  /** Anfrage mit unverändertem Pfad (fetch würde ../ und %2e normalisieren) */
  raw(method: string, rawPath: string, headers?: Record<string, string>): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>;
  stop(): Promise<void>;
}

async function spawnServer(opts: { env?: Record<string, string>; mock?: boolean } = {}): Promise<Srv> {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bimguesser-sec-'));
  const entry = opts.mock ? import.meta.filename : 'server/index.ts';
  const proc = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), STATE_DIR: stateDir, RATE_LIMIT_SCALE: '1000', BIMGUESSER_MOCK_EFA: opts.mock ? '1' : '', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let code: number | null | undefined;
  proc.stdout?.on('data', (d) => (out += String(d)));
  proc.stderr?.on('data', (d) => (out += String(d)));
  proc.on('exit', (c) => (code = c));
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* startet noch */
    }
    if (i > 120 || code !== undefined) {
      proc.kill();
      throw new Error(`Server startet nicht: ${out.slice(0, 800)}`);
    }
    await sleep(100);
  }
  return {
    base,
    port,
    stateDir,
    proc,
    log: () => out,
    exitCode: () => code,
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
      return { status: res.status, body: parsed, text, headers: res.headers };
    },
    raw(method, rawPath, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port, method, path: rawPath, headers }, (res) => {
          let text = '';
          res.on('data', (d) => (text += String(d)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
      });
    },
    async stop() {
      if (code === undefined) {
        proc.kill();
        await new Promise((r) => proc.once('exit', r));
      }
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alle Fragetypen auf „gar nicht“, nur `type` auf „sehr häufig“ */
function onlyType(type: string) {
  const all = ['locate', 'stopLines', 'lineShape', 'nextStop', 'termini', 'district', 'transfer', 'direct', 'draw', 'uCross', 'uLink', 'towards', 'busArea'];
  return Object.fromEntries(all.map((t) => [t, t === type ? 7 : 1]));
}

// ================================================================ Tests

function defineTests() {
  describe('Eingaben', () => {
    let s: Srv;
    before(async () => (s = await spawnServer()));
    after(async () => s?.stop());

    test('Prototype Pollution: __proto__/constructor in Einstellungen werden ignoriert', async () => {
      const raw = '{"mode":"route","playerName":"P","settings":{"__proto__":{"rounds":9,"polluted":1},"constructor":{"prototype":{"polluted":1}},"rounds":3}}';
      const r = await s.call('POST', '/api/games', raw);
      assert.equal(r.status, 200);
      assert.equal(r.body.state.settings.rounds, 3);
      assert.equal(r.body.state.settings.polluted, undefined);
      const q = await s.call('POST', '/api/games', '{"mode":"quiz","settings":{"weights":{"__proto__":{"draw":7}},"__proto__":{"questions":20}}}');
      assert.equal(q.status, 200);
      assert.notEqual(q.body.state.settings.questions, 20);
      // ein frischer Zustand danach ist nicht „verschmutzt“
      const fresh = await s.call('POST', '/api/games', { mode: 'route' });
      assert.equal(fresh.body.state.settings.polluted, undefined);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
    });

    test('Regression M-08: Objekte mit kaputtem toString führen nicht zu 500/Stacktrace', async () => {
      const { body } = await s.call('POST', '/api/games', { mode: 'quiz', playerName: 'H' });
      const code = body.state.id;
      const bad = { toString: 1 };
      const cases: [string, string, unknown][] = [
        ['PUT', `/api/games/${code}/settings`, { token: bad }],
        ['POST', '/api/games', { playerName: bad }],
        ['POST', `/api/games/${code}/join`, { playerName: bad }],
        ['POST', '/api/games', { mode: 'route', settings: { focus: { lat: bad, lon: 16.3 } } }],
        ['POST', `/api/games/${code}/quiz/answer`, { token: body.token, index: bad }],
      ];
      const before = s.log().length;
      const statuses = [];
      for (const [m, u, b] of cases) statuses.push((await s.call(m, u, b)).status);
      const newLog = s.log().slice(before);
      assert.deepEqual(statuses.filter((x) => x >= 500), [], `Status: ${statuses.join(', ')}`);
      assert.doesNotMatch(newLog, /TypeError/, 'Stacktrace im Server-Log');
    });

    test('500-Antworten verraten keinen Stacktrace an den Client', async () => {
      const r = await s.call('PUT', '/api/games/ABCDE/settings', { token: { toString: 1 } });
      assert.ok(!/at |TypeError|\.ts:/.test(r.text), r.text);
      assert.equal(typeof r.body.error, 'string');
    });

    test('JSON über 20 kb → 413, tief verschachteltes JSON → kein Absturz', async () => {
      const big = await s.call('POST', '/api/games', { mode: 'quiz', playerName: 'x'.repeat(25_000) });
      assert.equal(big.status, 413);
      const deep = '{"mode":"quiz","settings":' + '['.repeat(9000) + ']'.repeat(9000) + '}';
      const t0 = Date.now();
      const r = await s.call('POST', '/api/games', deep);
      assert.ok(r.status < 500, String(r.status));
      assert.ok(Date.now() - t0 < 2000);
      assert.equal((await s.call('GET', '/api/health')).status, 200);
    });

    test('falscher Content-Type: Body wird nicht ausgewertet (Lobby mit Standardwerten), kein Fehler', async () => {
      const r = await s.call('POST', '/api/games', '{"mode":"quiz","playerName":"T"}', { 'Content-Type': 'text/plain' });
      assert.equal(r.status, 200);
      assert.equal(r.body.state.mode, 'route');
      assert.equal(r.body.state.players[0].name, 'Spieler 1');
    });

    test('Namen: Steuerzeichen, RTL-Override, Null-Bytes, nur Leerzeichen', async () => {
      const name = async (n: string) => (await s.call('POST', '/api/games', { mode: 'quiz', playerName: n })).body.state.players[0].name as string;
      assert.equal(await name('‮evil\u0000x'), 'evilx');
      assert.equal(await name('   \t  '), 'Spieler 1');
      assert.equal(await name('a​b'), 'ab');
    });

    test('Regression L-06: 20-Zeichen-Schnitt zerteilt kein Emoji, unsichtbare/Zalgo-Namen werden abgefangen', async () => {
      const name = async (n: string) => (await s.call('POST', '/api/games', { mode: 'quiz', playerName: n })).body.state.players[0].name as string;
      const emoji = await name('a' + '🚇'.repeat(15));
      assert.ok(emoji.isWellFormed(), `einzelnes Surrogat am Ende: ${JSON.stringify(emoji)}`);
      const invisible = await name('ㅤㅤ');
      assert.notEqual(invisible.trim().replace(/ㅤ/g, ''), '', 'unsichtbarer Name (Hangul Filler) wird angenommen');
      const zalgo = await name('a' + '́'.repeat(19));
      assert.ok(zalgo.normalize('NFC').replace(/\p{M}/gu, '').length >= zalgo.length / 2, 'Zalgo-Name');
    });

    test('Pfad-Traversal bei statischen Dateien und SPA-Fallback liefert keine Projektdateien', async () => {
      if (!existsSync(path.join(ROOT, 'dist/index.html'))) return;
      const paths = [
        '/..%2f..%2fpackage.json',
        '/%2e%2e/%2e%2e/package.json',
        '/api/../package.json',
        '/assets/..%2f..%2fpackage.json',
        '/assets/..%5c..%5cpackage.json',
        '/..%5cserver%5cindex.ts',
        '/../server/index.ts',
        '/.env',
        '/%2e%65nv',
      ];
      for (const p of paths) {
        const r = await s.raw('GET', p);
        assert.ok(r.status < 500, `${p} → ${r.status}`);
        assert.doesNotMatch(r.text, /"name": "bimguesser"|createApp|NGROK_AUTHTOKEN/, p);
      }
    });

    test('HTTP-Methoden: unbekannte Methoden auf API → 404 JSON, kein CORS', async () => {
      for (const m of ['DELETE', 'PATCH', 'PUT']) {
        const r = await s.call(m, '/api/games');
        assert.equal(r.status, 404, m);
      }
      const o = await s.raw('OPTIONS', '/api/games', { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' });
      assert.equal(o.headers['access-control-allow-origin'], undefined);
      const tr = await s.raw('TRACE', '/');
      assert.ok(tr.status >= 400 && tr.status < 500, String(tr.status));
    });
  });

  describe('Autorisierung', () => {
    let s: Srv;
    before(async () => (s = await spawnServer()));
    after(async () => s?.stop());

    test('Mitspieler- und fremde Tokens können nichts steuern', async () => {
      const host = await s.call('POST', '/api/games', { mode: 'quiz', playerName: 'H' });
      const code = host.body.state.id;
      const guest = await s.call('POST', `/api/games/${code}/join`, { playerName: 'G' });
      const other = await s.call('POST', '/api/games', { mode: 'quiz', playerName: 'O' });
      for (const tok of [guest.body.token, other.body.token, '', 'x'.repeat(64)]) {
        for (const [m, u, b] of [
          ['PUT', 'settings', { settings: { questions: 20 } }],
          ['POST', 'start', {}],
          ['POST', 'pause', {}],
          ['POST', 'resume', {}],
          ['POST', 'cancel', {}],
          ['POST', 'lobby', {}],
          ['POST', 'next', {}],
          ['POST', 'quiz/reveal', {}],
        ] as const) {
          const r = await s.call(m, `/api/games/${code}/${u}`, { ...b, token: tok });
          assert.equal(r.status, 403, `${u} mit ${tok.slice(0, 6)}… → ${r.status}`);
        }
      }
      // Host kann; danach ist der Gast weiterhin kein Host
      assert.equal((await s.call('POST', `/api/games/${code}/start`, { token: host.body.token })).status, 200);
      assert.equal((await s.call('POST', `/api/games/${code}/quiz/reveal`, { token: guest.body.token })).status, 403);
      // Mitgliedschaft: SSE/Zustand nur mit Token dieser Lobby
      assert.equal((await s.call('GET', `/api/games/${code}?token=${other.body.token}`)).status, 403);
      assert.equal((await s.call('GET', `/api/games/${code}/events?token=${other.body.token}`)).status, 403);
    });

    test('Regression L-07: Lobby-Codes lassen sich nicht über 404/403 auskundschaften', async () => {
      const { body } = await s.call('POST', '/api/games', { mode: 'quiz' });
      const exists = await s.call('GET', `/api/games/${body.state.id}?token=falsch`);
      const missing = await s.call('GET', `/api/games/ZZZZZ?token=falsch`);
      assert.equal(exists.status, missing.status);
    });

    test('Quiz „Linie erkennen“: öffentlicher Zustand enthält die Lösung nicht', { skip: 'H-06 ⏸ bewusst: die Linie muss gezeichnet werden – der Client kennt das Netz, die Form verrät sie ohnehin (siehe 02-befunde.md)' }, async () => {
      const h = await s.call('POST', '/api/games', { mode: 'quiz', settings: { questions: 5, weights: onlyType('lineShape') } });
      const st = await s.call('POST', `/api/games/${h.body.state.id}/start`, { token: h.body.token });
      const q = st.body.question;
      assert.equal(q.type, 'lineShape');
      const rev = await s.call('POST', `/api/games/${h.body.state.id}/quiz/reveal`, { token: h.body.token });
      assert.notEqual(q.drawLineId, rev.body.reveal.correct, 'Lösung steht in question.drawLineId');
    });

    test('Regression H-06: Quiz „Querverbindung“: öffentlicher Zustand enthält die Lösung nicht', async () => {
      const h = await s.call('POST', '/api/games', { mode: 'quiz', settings: { questions: 5, weights: onlyType('uLink') } });
      const st = await s.call('POST', `/api/games/${h.body.state.id}/start`, { token: h.body.token });
      const q = st.body.question;
      assert.equal(q.type, 'uLink');
      const rev = await s.call('POST', `/api/games/${h.body.state.id}/quiz/reveal`, { token: h.body.token });
      assert.ok(!(q.drawLines ?? []).includes(rev.body.reveal.correct), `Lösung ${rev.body.reveal.correct} steht in question.drawLines ${q.drawLines}`);
      // in der Auflösung werden die Linien gezeichnet
      assert.ok(rev.body.reveal.drawLines.includes(rev.body.reveal.correct));
    });
  });

  describe('Ressourcen', () => {
    test('Live-Verbindungen: höchstens 3 pro Spieler', async () => {
      const s = await spawnServer();
      try {
        const { body } = await s.call('POST', '/api/games', { mode: 'quiz' });
        const url = `${s.base}/api/games/${body.state.id}/events?token=${body.token}`;
        const ctrl = new AbortController();
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) statuses.push((await fetch(url, { signal: ctrl.signal })).status);
        ctrl.abort();
        assert.deepEqual(statuses, [200, 200, 200, 429]);
      } finally {
        await s.stop();
      }
    });

    test('Lobby-Limit: 100 Lobbys sperren den Server nicht für alle anderen', { todo: 'Befund D-02: 10 IPs × 10 Lobbys → 503 für alle (bis zu 20 min, verlängerbar)' }, async (t) => {
      // echte Limits (10 Lobbys / 10 min / IP); verschiedene IPs per X-Forwarded-For (trust proxy = loopback)
      const s = await spawnServer({ env: { RATE_LIMIT_SCALE: '1' } });
      try {
        const t0 = Date.now();
        const one = [];
        for (let i = 0; i < 11; i++) one.push((await s.call('POST', '/api/games', { mode: 'quiz' }, { 'X-Forwarded-For': '203.0.113.1' })).status);
        assert.equal(one.at(-1), 429, 'Rate-Limit pro IP greift');
        const res = await Promise.all(
          Array.from({ length: 100 }, (_, i) => s.call('POST', '/api/games', { mode: 'quiz' }, { 'X-Forwarded-For': `203.0.113.${10 + Math.floor(i / 10)}` })),
        );
        t.diagnostic(`${res.filter((r) => r.status === 200).length + 10} Lobbys in ${Date.now() - t0} ms aus 11 Adressen`);
        const victim = await s.call('POST', '/api/games', { mode: 'quiz' }, { 'X-Forwarded-For': '198.51.100.7' });
        assert.equal(victim.status, 200, `neue Spielerin bekommt ${victim.status}: ${victim.body.error}`);
      } finally {
        await s.stop();
      }
    });
  });

  describe('Routenjagd mit Auskunfts-Attrappe', () => {
    let s: Srv;
    before(async () => (s = await spawnServer({ mock: true })));
    after(async () => s?.stop());

    const base = { rounds: 1, minTransfers: 0, restrictions: 'never', roundTimeLimitSec: null, avgWait: false, countWait: false };

    test('X-treme „ohne Namen“: Start/Ziel-Namen stehen nicht im öffentlichen Zustand', { skip: 'H-07 ⏸ bewusst: der Routen-Baukasten im Browser braucht die Start-Station (ID → Name/Lage aus den Netzdaten) – siehe 02-befunde.md' }, async (t) => {
      const h = await s.call('POST', '/api/games', { mode: 'route', settings: { ...base, xtreme: 'noNames' } });
      const before = Number((await s.call('GET', '/__mock/calls')).text);
      const st = await s.call('POST', `/api/games/${h.body.state.id}/start`, { token: h.body.token });
      t.diagnostic(`Auskunfts-Abfragen für 1 Runde: ${Number((await s.call('GET', '/__mock/calls')).text) - before}`);
      assert.equal(st.status, 200, st.text);
      assert.equal(st.body.settings.xtreme, 'noNames');
      assert.equal(st.body.rounds[0].status, 'open');
      assert.equal(st.body.rounds[0].from.name, '', `Name im Zustand: ${st.body.rounds[0].from.name}`);
    });

    test('„Wo liegt das?“: Koordinaten von Start/Ziel stehen nicht vor der Auflösung im Zustand', { skip: 'H-07 ⏸ bewusst: der Routen-Baukasten im Browser braucht die Start-Station (ID → Name/Lage aus den Netzdaten) – siehe 02-befunde.md' }, async () => {
      const h = await s.call('POST', '/api/games', { mode: 'route', settings: { ...base, locate: true } });
      const st = await s.call('POST', `/api/games/${h.body.state.id}/start`, { token: h.body.token });
      assert.equal(st.body.settings.locate, true);
      assert.equal(st.body.rounds[0].status, 'open');
      assert.equal(st.body.rounds[0].from.lat, undefined, 'from.lat im Zustand');
    });

    test('Regression M-04: „Zurück zur Lobby“ während der Auswertung → keine Punkte ins neue Spiel', async () => {
      const net = (await s.call('GET', '/api/network')).body;
      const u1 = net.lines.find((l: { id: string }) => l.id === 'U1').patterns[0] as string[];
      // mit „Wo liegt das?“: genaue Tipps bringen Punkte, egal wie die Route ausgewertet wird
      const h = await s.call('POST', '/api/games', { mode: 'route', playerName: 'A', settings: { ...base, locate: true } });
      const code = h.body.state.id;
      const b = await s.call('POST', `/api/games/${code}/join`, { playerName: 'B' });
      const st0 = await s.call('POST', `/api/games/${code}/start`, { token: h.body.token });
      assert.equal(st0.status, 200);
      const at = (ref: { name: string }) => {
        const x = net.stations.find((y: { name: string }) => y.name === ref.name);
        return [x.lat, x.lon];
      };
      const guesses = { from: at(st0.body.rounds[0].from), to: at(st0.body.rounds[0].to) };
      await s.call('POST', `/api/games/${code}/rounds/0/submit`, { token: h.body.token, legs: [{ line: 'U1', from: u1[2], to: u1[6] }], guesses });
      await s.call('GET', '/__mock/slow');
      // B geht → Auswertung läuft (langsam); währenddessen schickt der Host alle zurück in die Lobby
      await s.call('POST', `/api/games/${code}/leave`, { token: b.body.token });
      await sleep(200);
      const mid = await s.call('GET', `/api/games/${code}?token=${h.body.token}`);
      assert.equal(mid.body.state.rounds[0].status, 'open', 'Auswertung schon fertig – Test prüft nichts');
      const lob = await s.call('POST', `/api/games/${code}/lobby`, { token: h.body.token });
      assert.equal(lob.status, 200, lob.text);
      // warten, bis die Auswertung im Hintergrund fertig ist (keine neuen Auskunfts-Abfragen mehr)
      for (let i = 0, last = -1; i < 60; i++) {
        const n = Number((await s.call('GET', '/__mock/calls')).text);
        if (n === last) break;
        last = n;
        await sleep(1500);
      }
      const st = await s.call('GET', `/api/games/${code}?token=${h.body.token}`);
      assert.equal(st.body.state.phase, 'lobby');
      assert.equal(st.body.state.players[0].score, 0, 'Punkte der abgebrochenen Runde im neuen Spiel');
    });

    // muss der letzte Test sein: schaltet die Attrappe auf „Auskunft weg“
    test('Regression K-01: Auskunft fällt während der Auflösung aus → Server läuft weiter, Runde wird aufgelöst', async () => {
      const net = (await s.call('GET', '/api/network')).body;
      const u1 = net.lines.find((l: { id: string }) => l.id === 'U1').patterns[0] as string[];
      const h = await s.call('POST', '/api/games', { mode: 'route', playerName: 'A', settings: base });
      const code = h.body.state.id;
      const b = await s.call('POST', `/api/games/${code}/join`, { playerName: 'B' });
      assert.equal((await s.call('POST', `/api/games/${code}/start`, { token: h.body.token })).status, 200);
      // A gibt eine Route ab, die keiner Top-Verbindung entspricht (muss nachgerechnet werden); B fehlt noch
      const sub = await s.call('POST', `/api/games/${code}/rounds/0/submit`, { token: h.body.token, legs: [{ line: 'U1', from: u1[1], to: u1[4] }] });
      assert.equal(sub.status, 200, sub.text);
      assert.equal(sub.body.reveal, null);
      await s.call('GET', '/__mock/fail');
      // B verlässt die Lobby → Auflösung startet im Hintergrund (wie beim Ablauf des Zeitlimits)
      assert.equal((await s.call('POST', `/api/games/${code}/leave`, { token: b.body.token })).status, 200);
      for (let i = 0; i < 40 && s.exitCode() === undefined; i++) await sleep(100);
      assert.equal(s.exitCode(), undefined, `Server beendet (Exit ${s.exitCode()}):\n${s.log().slice(-600)}`);
      // Runde ist aufgelöst; die nicht nachrechenbare Route bekommt eine Erklärung statt eines Absturzes
      let st = await s.call('GET', `/api/games/${code}?token=${h.body.token}`);
      for (let i = 0; i < 40 && st.body.state.rounds[0].status !== 'revealed'; i++) {
        await sleep(100);
        st = await s.call('GET', `/api/games/${code}?token=${h.body.token}`);
      }
      assert.equal(st.body.state.rounds[0].status, 'revealed');
      const rev = await s.call('GET', `/api/games/${code}/rounds/0/reveal?token=${h.body.token}`);
      const a = rev.body.evaluations.find((e: { playerName: string }) => e.playerName === 'A');
      assert.match(a.error, /nicht nachgerechnet/);
    });
  });
}
