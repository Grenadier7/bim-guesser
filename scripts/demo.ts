// Lokale Demo: erfundene Accounts, Gäste und 90 Tage Nutzung, damit man die Grafiken der Admin-Seite sieht und testen
// kann. Nur lokal: eigener State-Ordner data/demo/ (in .gitignore) – die echte Datenbank in data/ bleibt unberührt,
// ins Image kommt nichts davon.
//
//   npm run demo             Demo-Daten neu erzeugen, dann Server + Vite starten → http://localhost:5173
//   npm run demo -- --keep   vorhandene Demo-Daten behalten (nur starten)
//   npm run demo -- --seed   nur erzeugen, nicht starten
//
// Anmelden (nur in der Demo): Admin „demo-admin“ / „demo-admin-passwort“, Spieler z.B. „lena“ / „demo-passwort“.
// Die Zufallszahlen sind fest (gleicher Startwert) – jeder Lauf ergibt dasselbe Bild, verschoben auf heute.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'data', 'demo');
export const DEMO_ADMIN = { name: 'demo-admin', password: 'demo-admin-passwort' };
export const DEMO_PASSWORD = 'demo-passwort';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const seedOnly = args.includes('--seed');

if (process.env.NODE_ENV === 'production') {
  console.error('✖ Die Demo ist nur für lokal gedacht.');
  process.exit(1);
}

// erst den State-Ordner festlegen, dann die Server-Module laden (sie lesen STATE_DIR beim Import)
process.env.STATE_DIR = STATE;

if (!keep || !existsSync(path.join(STATE, 'accounts.db'))) await seed();
if (!seedOnly) start();

// ---------------------------------------------------------------- Erzeugen

async function seed() {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  const { Accounts, AccountAdmin } = await import('../server/accounts.ts');
  const { Network } = await import('../server/network.ts');
  const { COURSE_IDS } = await import('../shared/career.ts');
  const { CHALLENGES } = await import('../shared/challenges.ts');
  const net = Network.load();
  const acc = new Accounts(net, { file: path.join(STATE, 'accounts.db') });
  const admin = new AccountAdmin(acc);
  const db = (acc as unknown as { db: import('node:sqlite').DatabaseSync }).db;
  const run = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);

  // feste Zufallszahlen (mulberry32)
  let s = 20261109;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)];
  const chance = (p: number) => rnd() < p;
  const hex = (n: number) => Array.from({ length: n }, () => int(16).toString(16)).join('');

  const DAYS = 90;
  const DAY = 86400_000;
  const now = Date.now();
  const dayOf = (t: number) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' });
  const noon = Date.parse(`${dayOf(now)}T12:00:00Z`);
  /** Tag d (0 = vor 89 Tagen … 89 = heute) */
  const dayKey = (d: number) => new Date(noon - (DAYS - 1 - d) * DAY).toISOString().slice(0, 10);
  /** Zeitpunkt an Tag d um Stunde h (Wiener Zeit, ungefähr) – heute nie in der Zukunft, sondern irgendwann bis jetzt */
  const at = (d: number, h: number) => {
    const start = Date.parse(`${dayKey(d)}T00:00:00Z`) - 3600_000;
    const t = start + h * 3600_000 + int(3600_000);
    return t < now - 5 * 60_000 ? t : start + Math.floor(rnd() * Math.max(1, now - 5 * 60_000 - start));
  };
  /** Wochenende etwas mehr, und es wird über die Zeit mehr */
  const weekday = (d: number) => new Date(`${dayKey(d)}T12:00:00Z`).getUTCDay();
  const busy = (d: number) => (0.35 + 0.65 * (d / (DAYS - 1))) * ([0, 6].includes(weekday(d)) ? 1.4 : 1) * (0.8 + 0.4 * rnd());
  /** Abends am meisten los */
  const HOUR = [0.2, 0.1, 0.05, 0.05, 0.05, 0.1, 0.3, 0.6, 0.7, 0.6, 0.6, 0.7, 0.9, 0.8, 0.7, 0.8, 1, 1.2, 1.5, 1.7, 1.8, 1.5, 1, 0.5];
  const playHour = () => {
    for (;;) {
      const h = int(24);
      if (rnd() * 1.8 < HOUR[h]) return h;
    }
  };

  // beliebte Linien (Gewicht) – für Routen, Lieblingslinien und „Meistgewählte Linien“
  const LINES: [string, number][] = [
    ['U1', 10], ['U2', 6], ['U3', 9], ['U4', 9], ['U6', 8], ['S45', 5], ['S1', 3], ['S7', 2], ['S80', 2], ['D', 5], ['O', 3],
    ['1', 3], ['2', 3], ['5', 2], ['6', 4], ['18', 4], ['43', 4], ['49', 2], ['13A', 5], ['48A', 3], ['10A', 2], ['26', 2], ['25', 2], ['N25', 1],
  ];
  const lineTotal = LINES.reduce((a, [, w]) => a + w, 0);
  const someLine = () => {
    let r = rnd() * lineTotal;
    for (const [l, w] of LINES) if ((r -= w) <= 0) return l;
    return 'U1';
  };
  const lineUsage = new Map<string, number>();
  const useLines = (d: number, n: number, mine?: Map<string, number>) => {
    for (let i = 0; i < n; i++) {
      const l = someLine();
      const k = `${dayKey(d)}|${l}`;
      lineUsage.set(k, (lineUsage.get(k) ?? 0) + 1);
      mine?.set(l, (mine.get(l) ?? 0) + 1);
    }
  };

  const NAMES = [
    'lena', 'maxi', 'sophie_w', 'jonas.k', 'hannah', 'felix99', 'lea-marie', 'paul', 'anna_b', 'lukas', 'emilia', 'david.r',
    'mia', 'tobias', 'laura_s', 'simon', 'clara', 'fabian', 'nina', 'julian', 'sarah.m', 'elias', 'valentina', 'moritz',
    'lisa_k', 'niklas', 'theresa', 'raphael', 'katharina', 'leon', 'marie_h', 'benedikt', 'johanna', 'stefan', 'eva', 'oskar',
  ];
  const GUEST_NAMES = ['Alex', 'Kim', 'Sam', 'Bimfan', 'Toni', 'Chris', 'Robin', 'Pendler', 'Luca', 'Mo', 'Jo', 'Vici', 'Ö-Fan', 'Kai', 'Nico', 'Flo', 'Bim-Bim', 'Charlie', 'Jules', 'Mika'];

  const visits = new Map<string, Map<string, number>>(); // Tag → Browser → mit Account
  const visit = (d: number, id: string, account: boolean) => {
    const m = visits.get(dayKey(d)) ?? visits.set(dayKey(d), new Map()).get(dayKey(d))!;
    m.set(id, Math.max(m.get(id) ?? 0, account ? 1 : 0));
  };
  const gameLog: [number, string, number, number][] = [];
  const courses = new Map<number, Record<string, { done: boolean; mastered: boolean }>>();

  db.exec('BEGIN');
  try {
    // ------------------------------------------------ Admin
    const boss = (await acc.register(DEMO_ADMIN.name, DEMO_ADMIN.password, 'demo-admin@example.com')).user;
    admin.setAdmin(DEMO_ADMIN.name, true);
    run('UPDATE users SET created = ?, last_seen = ? WHERE id = ?', at(0, 10), now, boss.id);

    // ------------------------------------------------ Accounts: angelegt über die Zeit (später mehr), manche hören auf
    type Player = { id: number; name: string; created: number; until: number; p: number; skill: number; browser: string; guestBefore: number; lines: Map<string, number> };
    const players: Player[] = [];
    for (const name of NAMES) {
      const created = Math.min(DAYS - 1, Math.floor(Math.sqrt(rnd()) * DAYS));
      const until = chance(0.25) ? Math.min(DAYS - 1, created + 3 + int(25)) : DAYS - 1;
      const u = (await acc.register(name, DEMO_PASSWORD, chance(0.6) ? `${name.replace(/[^a-z]/g, '')}@example.com` : '')).user;
      const p: Player = { id: u.id, name, created, until, p: 0.12 + rnd() * 0.5, skill: 450 + int(450), browser: hex(32), guestBefore: chance(0.35) ? 1 + int(10) : 0, lines: new Map() };
      players.push(p);
      const t0 = at(created, playHour());
      run('UPDATE users SET created = ?, last_seen = ? WHERE id = ?', t0, t0, u.id);
    }

    // ------------------------------------------------ Gäste: Browser ohne Account (mit zuletzt verwendetem Namen)
    type Guest = { id: string; name: string | null; first: number; last: number; p: number };
    const guests: Guest[] = [];
    for (let i = 0; i < 260; i++) {
      const first = Math.floor(Math.sqrt(rnd()) * DAYS);
      // viele kommen nur einmal
      const last = chance(0.55) ? first : Math.min(DAYS - 1, first + int(40));
      guests.push({ id: hex(32), name: chance(0.85) ? `${pick(GUEST_NAMES)}${chance(0.3) ? int(99) : ''}` : null, first, last, p: 0.15 + rnd() * 0.5 });
    }

    // ------------------------------------------------ Tag für Tag
    const xp = new Map<number, number>();
    const addXp = (id: number, n: number) => xp.set(id, (xp.get(id) ?? 0) + n);
    for (let d = 0; d < DAYS; d++) {
      const b = busy(d);
      // Gäste
      for (const g of guests) {
        if (d < g.first || d > g.last || !(d === g.first || d === g.last || chance(g.p * b))) continue;
        visit(d, g.id, false);
        // manche spielen als Gast: Lobby-Spiel, Strecke des Tages oder Training
        if (chance(0.45)) gameLog.push([at(d, playHour()), pick(['route', 'route', 'quiz', 'challenge']), 1 + int(3), 0]);
        if (chance(0.25)) gameLog.push([at(d, playHour()), 'daily', 1, 0]);
        if (chance(0.3)) for (let k = 1 + int(3); k > 0; k--) gameLog.push([at(d, playHour()), 'training', 1, 0]), useLines(d, 2);
        useLines(d, int(8));
      }
      // Accounts
      for (const p of players) {
        // vor dem Anlegen manchmal schon als Gast da (→ „haben inzwischen einen Account“)
        if (p.guestBefore && d >= p.created - p.guestBefore && d < p.created && chance(0.5)) visit(d, p.browser, false);
        if (d < p.created || d > p.until) continue;
        if (!(d === p.created || chance(p.p * b))) continue;
        visit(d, p.browser, true);
        const lastSeen = at(d, playHour());
        run('UPDATE users SET last_seen = MAX(last_seen, ?) WHERE id = ?', lastSeen, p.id);
        const skill = Math.min(1150, p.skill + (d - p.created) * 3);
        const route = () => Math.max(0, Math.min(1300, Math.round(skill + (rnd() - 0.5) * 500)));
        // Routenjagd (manchmal als Tages-Challenge)
        for (let g = chance(0.7) ? 1 + int(2) : 0; g > 0; g--) {
          const t = at(d, playHour());
          const multi = chance(0.4);
          const n = multi ? 2 + int(3) : 1;
          const challenge = !multi && chance(0.35) ? pick(CHALLENGES).id : null;
          let total = 0;
          for (let r = 0; r < 5; r++) {
            const pts = route();
            total += pts + int(150);
            run("INSERT INTO results (user_id, kind, at, points, route, minutes) VALUES (?, 'round', ?, ?, ?, ?)", p.id, t, pts, pts, 15 + int(40));
            addXp(p.id, 5 + pts / 20);
            useLines(d, 2, p.lines);
          }
          const rank = multi ? 1 + int(n) : 1;
          run("INSERT INTO results (user_id, kind, at, points, rank, players) VALUES (?, 'game', ?, ?, ?, ?)", p.id, t, total, rank, n);
          addXp(p.id, 20 + (multi && rank === 1 ? 30 : 0));
          if (challenge) run('INSERT OR IGNORE INTO challenge_days (user_id, day, challenge, run) VALUES (?, ?, ?, ?)', p.id, dayKey(d), challenge, hex(12));
          gameLog.push([t, challenge ? 'challenge' : 'route', n, multi ? 1 + int(n) : 1]);
        }
        // Quiz
        if (chance(0.15)) {
          const t = at(d, playHour());
          const n = 1 + int(4);
          const rank = 1 + int(n);
          run("INSERT INTO results (user_id, kind, at, points, rank, players, extra) VALUES (?, 'quiz', ?, ?, ?, ?, ?)", p.id, t, 300 + int(700), rank, n, chance(0.1) ? 'ace' : null);
          addXp(p.id, 25);
          gameLog.push([t, 'quiz', n, 1 + int(n)]);
        }
        // Strecke des Tages (einmal am Tag)
        if (chance(0.4)) {
          const t = at(d, playHour());
          const pts = route();
          run("INSERT INTO results (user_id, kind, at, points, minutes, extra) VALUES (?, 'daily', ?, ?, ?, ?)", p.id, t, pts, 18 + int(35), JSON.stringify({ day: dayKey(d), route: null, matchedRank: null, error: null }));
          addXp(p.id, 3 * (15 + pts / 20));
          useLines(d, 2, p.lines);
          gameLog.push([t, 'daily', 1, 1]);
        }
        // Training
        for (let k = chance(0.3) ? 1 + int(3) : 0; k > 0; k--) {
          const t = at(d, playHour());
          const good = chance(0.6);
          run("INSERT INTO results (user_id, kind, at, points, minutes) VALUES (?, 'training', ?, ?, ?)", p.id, t, good ? 1 : 0, 15 + int(35));
          addXp(p.id, good ? 20 : 10);
          useLines(d, 2, p.lines);
          gameLog.push([t, 'training', 1, 1]);
        }
      }
    }

    // ------------------------------------------------ Gesamtwerte je Account
    for (const p of players) {
      run('UPDATE users SET game_xp = ? WHERE id = ?', Math.round(xp.get(p.id) ?? 0), p.id);
      for (const [l, n] of p.lines) {
        const mode = net.lines.get(l)?.mode ?? 'B';
        run('INSERT INTO usage (user_id, kind, key, weight, count) VALUES (?, ?, ?, ?, ?)', p.id, `line:${mode}`, l, n * (0.5 + rnd()), n);
      }
      // Lernpfad: wer viel spielt, macht eher Kurse
      const active = (p.until - p.created + 1) * p.p;
      const done = Math.min(COURSE_IDS.length, Math.floor(active / 4 + rnd() * 2));
      if (done) courses.set(p.id, Object.fromEntries(COURSE_IDS.slice(0, done).map((id, k) => [id, { done: true, mastered: k < done / 3 }])));
    }
    // gerade online: ein paar, die heute spielen
    for (const p of players.filter((x) => x.until === DAYS - 1).slice(0, 4)) run('UPDATE users SET last_seen = ? WHERE id = ?', now - int(60_000), p.id);
    // Freundschaften
    for (let i = 0; i < 30; i++) {
      const [a, b] = [pick(players), pick(players)];
      if (a === b) continue;
      run('INSERT OR IGNORE INTO friends (a, b, requester, accepted, created) VALUES (?, ?, ?, ?, ?)', Math.min(a.id, b.id), Math.max(a.id, b.id), a.id, chance(0.8) ? 1 : 0, now - int(60) * DAY);
    }

    // ------------------------------------------------ Admin-Statistik
    for (const [t, mode, n, accounts] of gameLog) run('INSERT INTO game_log (at, mode, players, accounts) VALUES (?, ?, ?, ?)', t, mode, n, accounts);
    for (const [k, n] of lineUsage) {
      const [day, line] = k.split('|');
      run('INSERT INTO line_usage (day, line, n) VALUES (?, ?, ?)', day, line, n);
    }
    for (const [day, m] of visits) for (const [id, a] of m) run('INSERT INTO visits (day, id, account) VALUES (?, ?, ?)', day, id, a);
    for (const g of guests) if (g.name) run('INSERT INTO visitor_names (id, name, at) VALUES (?, ?, ?)', g.id, g.name, at(g.last, 20));
    // Momentaufnahmen alle 5 min – aus der Besucherzahl des Tages und der Tageszeit; an einem Tag war der Server 6 h aus
    const perDay = new Map([...visits].map(([day, m]) => [day, { all: m.size, anon: [...m.values()].filter((a) => !a).length }]));
    const off = [Date.parse(`${dayKey(40)}T08:00:00Z`), Date.parse(`${dayKey(40)}T14:00:00Z`)];
    const sample = db.prepare('INSERT INTO metrics (at, online, lobbies, playing, players, visitors, anon) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let t = Math.floor((now - DAYS * DAY) / 300_000) * 300_000; t < now; t += 300_000) {
      if (t >= off[0] && t < off[1]) continue;
      const v = perDay.get(dayOf(t));
      if (!v) continue;
      const h = Number(new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/Vienna', hour: '2-digit', hour12: false })) % 24;
      const f = (HOUR[h] / 10) * (0.6 + 0.8 * rnd());
      const visitors = Math.round(v.all * f);
      const anon = Math.min(visitors, Math.round(visitors * (v.anon / Math.max(1, v.all))));
      const lobbies = Math.round(visitors * 0.3 * rnd());
      const playing = Math.min(lobbies, Math.round(lobbies * rnd()));
      sample.run(t, visitors - anon, lobbies, playing, playing ? playing + int(playing * 3) : 0, visitors, anon);
    }
    // Protokoll
    admin.log(DEMO_ADMIN.name, 'Admin-Bereich entsperrt');
    admin.log(DEMO_ADMIN.name, 'Einstellungen: Uhrzeiten geändert');
    admin.log(DEMO_ADMIN.name, 'Link zum Zurücksetzen erzeugt', players[3].name);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Lernstand (wie vom Browser synchronisiert) und Medaillen aus den Ergebnissen
  for (const [id, c] of courses) acc.saveData(id, { 'oeffi-courses-v1': c });
  for (const id of (db.prepare('SELECT id FROM users').all() as { id: number }[]).map((r) => r.id)) acc.checkMedals(id);
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  console.log(
    `✔ Demo-Daten in ${path.relative(ROOT, STATE)}: ${n('SELECT COUNT(*) AS n FROM users')} Accounts, ${n('SELECT COUNT(DISTINCT id) AS n FROM visits')} Browser, ` +
      `${n('SELECT COUNT(*) AS n FROM game_log')} Spiele, ${n('SELECT COUNT(*) AS n FROM metrics')} Momentaufnahmen (90 Tage)`,
  );
  acc.close();
}

// ---------------------------------------------------------------- Starten

function start() {
  console.log(`\nDemo läuft gleich auf http://localhost:5173 (Daten: data/demo, nicht die echte Datenbank)`);
  console.log(`Admin: ${DEMO_ADMIN.name} / ${DEMO_ADMIN.password} · Spieler z.B.: lena / ${DEMO_PASSWORD}\n`);
  // Server immer auf 3000 (dorthin leitet Vite /api weiter) – auch wenn von außen ein anderer PORT gesetzt ist
  const child = spawn('npm run dev', { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, STATE_DIR: STATE, PORT: '3000' } });
  child.on('exit', (code) => process.exit(code ?? 0));
}
