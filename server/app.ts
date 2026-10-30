// Express-App ohne listen(): Middleware, alle API-Routen, gebauter Client – testbar ohne Netzwerk-Port
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Accounts } from './accounts.ts';
import { errorHandler, MIN, stripDangerousKeys } from './http.ts';
import { smtpMailer, type SendMail } from './mail.ts';
import { GameManager } from './manager.ts';
import type { Network } from './network.ts';
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
  const games = new GameManager(net);
  const accounts = new Accounts(net, { file: accountsDb, mail });
  games.onCreate = (g) => accounts.watch(g);
  setInterval(() => accounts.cleanup(), 3600_000).unref();
  const training = new TrainingService(net);
  const networkJson = JSON.stringify(net.publicData());

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

  app.get('/api/network', (_req, res) => {
    res.type('json').set('Cache-Control', 'public, max-age=3600').send(networkJson);
  });

  const { optionalUser } = accountRoutes(app, accounts, (code) => games.has(code));
  gameRoutes(app, games, { accounts, optionalUser });
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
