// Express-App ohne listen(): Middleware, alle API-Routen, gebauter Client – testbar ohne Netzwerk-Port
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { AccountAdmin, Accounts } from './accounts.ts';
import { errorHandler, MIN, stripDangerousKeys } from './http.ts';
import { smtpMailer, type SendMail } from './mail.ts';
import { GameManager } from './manager.ts';
import type { Network } from './network.ts';
import { GameConfigStore } from './gameconfig.ts';
import { PlanRuntime } from './planruntime.ts';
import { planStore } from './plans.ts';
import { adminRoutes } from './routes/admin.ts';
import { accountRoutes } from './routes/accounts.ts';
import { gameRoutes } from './routes/games.ts';
import { trainingRoutes } from './routes/training.ts';
import { rateLimit, securityHeaders } from './security.ts';
import { TrainingService } from './training.ts';

const DIST = path.resolve(import.meta.dirname, '../dist');

export interface AppOptions {
  net: Network;
  version?: string;
  /** Account-Datenbank: Pfad oder ':memory:' (Tests); Standard STATE_DIR/accounts.db */
  accountsDb?: string;
  /** Mailversand (Passwort-Reset); Standard: SMTP_URL */
  mail?: SendMail;
}

export function createApp({ net, version = 'dev', accountsDb, mail = smtpMailer() }: AppOptions) {
  const started = Date.now();
  // Netzpläne und Spiel-Konfiguration der Admin-Seite (Standard = Werte im Code)
  const plans = planStore();
  let config: GameConfigStore | null = null;
  const runtime = new PlanRuntime(net, plans, () => config!.effective().addresses);
  config = new GameConfigStore(net, () => plans.menu());
  config.apply();
  const cfg = config;
  if (plans.get('regular')?.edits.length || cfg.stored().addresses) runtime.apply('regular');
  const games = new GameManager(net, (mode) => runtime.net(mode));
  // Änderungen: Quiz-Netz neu, Netz-Auswahl (Namen der Netzpläne) neu, Adressen in alle Netze
  runtime.onChange = () => {
    games.refreshNet();
    cfg.apply();
  };
  cfg.onChange = (section) => {
    if (section === 'addresses' || section === null) runtime.refreshAddresses();
    if (section === 'pools' || section === null) games.refreshNet();
  };
  const accounts = new Accounts(net, { file: accountsDb, mail });
  const adminAcc = new AccountAdmin(accounts);
  games.onCreate = (g) => {
    accounts.watch(g);
    // Statistik der Admin-Seite: jedes fertige Spiel (auch ohne Accounts)
    g.on('lines', (lines: string[]) => {
      try {
        adminAcc.countLines(lines);
      } catch (e) {
        console.warn('Statistik:', (e as Error).message);
      }
    });
    g.on('finished', () => {
      try {
        const info = g.adminInfo();
        adminAcc.recordGame(g.mode, info.players.length, info.players.filter((p) => p.account).length);
      } catch (e) {
        console.warn('Statistik:', (e as Error).message);
      }
    });
  };
  // Besucher: zufällige Kennung je Browser (kein Bezug zur Person), Meldung jede Minute, solange die Seite offen ist
  const visitors = new Map<string, { at: number; account: boolean }>();
  const visitorsNow = () => {
    const cut = Date.now() - 2.5 * 60_000;
    let all = 0;
    let anon = 0;
    for (const [id, v] of visitors) {
      if (v.at < cut) visitors.delete(id);
      else (all++, v.account || anon++);
    }
    return { all, anon };
  };
  // Momentaufnahme für die Grafiken: alle 5 min
  setInterval(() => {
    try {
      const all = games.list();
      const v = visitorsNow();
      adminAcc.sample(all.length, games.activeGames(), all.reduce((n, g) => n + g.adminInfo().players.filter((p) => p.connected).length, 0), v.all, v.anon);
    } catch (e) {
      console.warn('Statistik:', (e as Error).message);
    }
  }, 5 * 60_000).unref();
  setInterval(() => accounts.cleanup(), 3600_000).unref();
  const training = new TrainingService(net);
  training.onLines = (lines) => adminAcc.countLines(lines);

  const app = express();
  app.disable('x-powered-by');
  // Proxys, deren X-Forwarded-For wir glauben (dort steht die echte IP – wichtig für die Rate-Limits):
  // lokal ngrok über localhost; im Container ngrok/Caddy aus dem Docker-Netz → TRUST_PROXY="loopback, uniquelocal"
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.use(securityHeaders);
  app.use('/api', rateLimit('api', 600, MIN));
  app.use(express.json({ limit: '20kb' }));
  app.use(stripDangerousKeys);

  // Für Docker-Healthcheck und Update-Skript: läuft der Server, und laufen gerade Spiele?
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version, uptimeSec: Math.round((Date.now() - started) / 1000), lobbies: games.lobbyCount, activeGames: games.activeGames(), warnings: net.referenceWarnings() });
  });

  // Netz (Standard oder ?plan=… für einen Netzplan). no-cache + ETag: Browser fragen jedes Mal kurz nach (304) –
  // Änderungen der Admin-Seite sind sofort sichtbar
  app.get('/api/network', (req, res) => {
    const plan = req.query.plan === undefined ? 'regular' : String(req.query.plan);
    const json = /^[a-z0-9-]{1,24}$/.test(plan) ? runtime.networkJson(plan) : null;
    if (!json) return void res.status(404).json({ error: 'Diesen Netzplan gibt es nicht.' });
    res.type('json').set('Cache-Control', 'no-cache').send(json);
  });
  app.post('/api/ping', (req, res) => {
    const id = String(req.body?.v ?? '');
    if (!/^[a-z0-9]{12,40}$/.test(id)) return void res.status(400).json({ error: 'Ungültig' });
    const account = !!optionalUser(req);
    visitors.set(id, { at: Date.now(), account });
    if (visitors.size > 50_000) visitorsNow();
    try {
      adminAcc.visit(id, account);
    } catch {
      /* Statistik darf nie stören */
    }
    res.json({ ok: true });
  });
  // Spiel-Konfiguration (Uhrzeiten, Wertungen, Standard-Einstellungen …) – der Browser wendet sie vor dem Start an
  app.get('/api/config', (_req, res) => {
    res.set('Cache-Control', 'no-cache').json(cfg.public());
  });

  const { optionalUser } = accountRoutes(app, accounts, (code) => games.has(code));
  gameRoutes(app, games, { accounts, optionalUser });
  adminRoutes(app, { accounts, admin: adminAcc, games, net, version, started, plans, runtime, config: cfg });
  trainingRoutes(app, training, { accounts, optionalUser });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Nicht gefunden' });
  });

  if (existsSync(DIST)) {
    app.use(express.static(DIST, { index: 'index.html', dotfiles: 'deny' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  }

  app.use(errorHandler);
  return { app, games, accounts };
}
