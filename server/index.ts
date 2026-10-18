import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { CreateGameRequest, GameEvent, JoinResponse, SubmitRequest, SubmitResponse, TipKind } from '../shared/types.ts';
import { Game } from './game.ts';
import { GameError } from './lobby.ts';
import { GameManager } from './manager.ts';
import { QuizGame } from './quiz.ts';
import { Network } from './network.ts';
import { closeStream, openStream, rateLimit, securityHeaders } from './security.ts';
import { TrainingService } from './training.ts';

const PORT = Number(process.env.PORT ?? 3000);
const VERSION = process.env.APP_VERSION ?? 'dev';
const STARTED = Date.now();
const DIST = path.resolve(import.meta.dirname, '../dist');

const net = Network.load();
const games = new GameManager(net);
const training = new TrainingService(net);
const networkJson = JSON.stringify(net.publicData());

const app = express();
app.disable('x-powered-by');
// Proxys, deren X-Forwarded-For wir glauben (dort steht die echte IP – wichtig für die Rate-Limits):
// lokal ngrok über localhost; im Container ngrok/Caddy aus dem Docker-Netz → TRUST_PROXY="loopback, uniquelocal"
app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
app.use(securityHeaders);

// ---------------------------------------------------------------- Rate-Limits pro IP

const MIN = 60_000;
app.use('/api', rateLimit('api', 600, MIN));
const limitCreate = rateLimit('create', 10, 10 * MIN, 'Zu viele neue Lobbys – bitte in ein paar Minuten nochmal.');
const limitJoin = rateLimit('join', 30, 10 * MIN, 'Zu viele Beitrittsversuche – bitte kurz warten.');
// jeder Start fragt die Wiener-Linien-API dutzende Male ab
const limitStart = rateLimit('start', 12, 10 * MIN, 'Zu viele Spielstarts – bitte kurz warten.');
const limitEvents = rateLimit('events', 60, MIN);
// jede Trainingsstrecke fragt die Wiener-Linien-API ~6× ab, jede Auswertung evtl. mehrfach
const limitTraining = rateLimit('training', 40, 10 * MIN, 'Viele Trainingsstrecken in kurzer Zeit – bitte kurz warten.');
const limitTrainingEval = rateLimit('training-eval', 80, 10 * MIN);

app.use(express.json({ limit: '20kb' }));

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res))
    .then((body) => body !== undefined && !res.headersSent && res.json(body))
    .catch(next);
};
const param = (req: Request, k: string) => String(req.params[k]);
const game = (req: Request) => games.get(param(req, 'code'));
/** Nur Routenjagd bzw. nur Quiz */
const routeGame = (req: Request) => {
  const g = game(req);
  if (!(g instanceof Game)) throw new GameError('Das geht nur in der Routenjagd.');
  return g;
};
const quizGame = (req: Request) => {
  const g = game(req);
  if (!(g instanceof QuizGame)) throw new GameError('Das geht nur im Quiz.');
  return g;
};
/** Geheimer Spieler-Token: im Body, bei GET/SSE als Query-Parameter */
const token = (req: Request) => String(req.body?.token ?? req.query.token ?? '').slice(0, 64);
const roundIdx = (req: Request) => {
  const n = Number(param(req, 'round'));
  if (!Number.isInteger(n) || n < 0 || n > 20) throw new GameError('Ungültige Runde');
  return n;
};

// Für Docker-Healthcheck und Update-Skript: läuft der Server, und laufen gerade Spiele?
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, uptimeSec: Math.round((Date.now() - STARTED) / 1000), lobbies: games.lobbyCount, activeGames: games.activeGames() });
});

app.get('/api/network', (_req, res) => {
  res.type('json').set('Cache-Control', 'public, max-age=3600').send(networkJson);
});

// Lobby erstellen (Ersteller = Host) – auch fürs Alleinspielen
app.post(
  '/api/games',
  limitCreate,
  h((req): JoinResponse => {
    const body = req.body as CreateGameRequest;
    const g = games.create(body?.mode === 'quiz' ? 'quiz' : 'route', body?.settings);
    const p = g.addPlayer(body?.playerName);
    return { playerId: p.id, token: p.token, state: g.state() };
  }),
);

// Mit Code beitreten
app.post(
  '/api/games/:code/join',
  limitJoin,
  h((req): JoinResponse => {
    const g = game(req);
    const p = g.addPlayer(req.body?.playerName);
    return { playerId: p.id, token: p.token, state: g.state() };
  }),
);

/** Nur für Mitglieder der Lobby */
const member = (req: Request) => {
  const g = game(req);
  if (!g.isMember(token(req))) throw new GameError('Du bist nicht in dieser Lobby.', 403);
  return g;
};

app.get('/api/games/:code', h((req) => ({ playerId: member(req).playerIdFor(token(req)), state: member(req).state() })));

app.put('/api/games/:code/settings', h((req) => (game(req).updateSettings(token(req), req.body?.settings ?? {}), game(req).state())));
app.post('/api/games/:code/start', limitStart, h(async (req) => (await game(req).start(token(req)), game(req).state())));
app.post('/api/games/:code/next', h(async (req) => (await game(req).next(token(req)), game(req).state())));
app.post('/api/games/:code/lobby', h((req) => (game(req).backToLobby(token(req)), game(req).state())));
app.post('/api/games/:code/leave', h((req) => (game(req).leave(token(req)), { ok: true })));
// Host-Steuerung während einer Runde
app.post('/api/games/:code/pause', h((req) => (game(req).pause(token(req)), game(req).state())));
app.post('/api/games/:code/resume', h((req) => (game(req).resume(token(req)), game(req).state())));
app.post('/api/games/:code/cancel', h((req) => (game(req).cancelRound(token(req)), game(req).state())));

app.post(
  '/api/games/:code/rounds/:round/tips',
  h((req) => routeGame(req).tip(token(req), roundIdx(req), req.body?.kind as TipKind)),
);
app.get('/api/games/:code/rounds/:round/tips', h((req) => routeGame(req).tipResults(token(req), roundIdx(req))));

app.post(
  '/api/games/:code/rounds/:round/submit',
  h(async (req): Promise<SubmitResponse> => {
    const g = routeGame(req);
    const body = req.body as SubmitRequest;
    const reveal = await g.submit(token(req), roundIdx(req), body?.legs, body?.guesses ?? null);
    return { state: g.state(), reveal };
  }),
);
app.post('/api/games/:code/rounds/:round/reveal', h((req) => routeGame(req).forceReveal(token(req), roundIdx(req))));
app.get('/api/games/:code/rounds/:round/reveal', h((req) => routeGame(req).getReveal(token(req), roundIdx(req))));

// Quiz
app.post(
  '/api/games/:code/quiz/answer',
  h((req) => {
    const g = quizGame(req);
    g.answer(token(req), Number(req.body?.index), req.body?.answer);
    return g.state();
  }),
);
app.post('/api/games/:code/quiz/reveal', h((req) => (quizGame(req).forceReveal(token(req)), quizGame(req).state())));

// Live-Events (Server-Sent Events): Lobby-Updates, Abgaben, Auflösung
app.get('/api/games/:code/events', limitEvents, (req, res, next) => {
  let g;
  try {
    g = member(req);
  } catch (e) {
    return next(e);
  }
  const t = token(req);
  const ip = req.ip ?? '?';
  if (!openStream(ip)) return next(new GameError('Zu viele offene Verbindungen.', 429));
  if (!g.connect(t)) {
    closeStream(ip);
    return next(new GameError('Zu viele offene Tabs für diesen Spieler.', 429));
  }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (e: GameEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  g.on('event', send);
  send({ type: 'state', state: g.state() });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    g.off('event', send);
    g.disconnect(t);
    closeStream(ip);
  });
});

// Trainingsmodus (ohne Lobby)
app.post('/api/training/round', limitTraining, h((req) => training.create(req.body?.settings, req.body?.pair)));
app.post('/api/training/:id/evaluate', limitTrainingEval, h((req) => training.evaluate(param(req, 'id'), req.body?.legs)));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Nicht gefunden' });
});

if (existsSync(DIST)) {
  app.use(express.static(DIST, { index: 'index.html', dotfiles: 'deny' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // GameError: eigene Meldung; Fehler von express.json (kaputtes JSON, zu groß) haben einen 4xx-Status
  const status = err instanceof GameError ? err.status : Number((err as { status?: number })?.status) || 500;
  // erwartbare Fehler (z.B. Auskunft nicht erreichbar) als kurze Zeile, echte Fehler mit Stack
  if (err instanceof GameError && status >= 500) console.warn(`[${new Date().toLocaleTimeString('de-AT')}] ${err.message}`);
  else if (status >= 500) console.error(err);
  const msg = err instanceof GameError ? err.message : status < 500 ? 'Ungültige Anfrage' : 'Interner Fehler';
  res.status(status).json({ error: msg });
});

app.listen(PORT, () => {
  const days = Object.entries(net.data.regularDays).map(([k, v]) => `${k}=${v.date}`).join(', ');
  console.log(`BimGuesser läuft auf http://localhost:${PORT}  (${net.data.stations.length} Stationen, Referenztage: ${days})`);
});
