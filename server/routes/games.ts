// Lobbys (Routenjagd und Quiz): erstellen, beitreten, Einstellungen, Spielablauf, Live-Events
import type { Express, Request } from 'express';
import type { CreateGameRequest, GameEvent, JoinResponse, SubmitRequest, SubmitResponse, TipKind } from '../../shared/types.ts';
import { Game } from '../game.ts';
import { h, MIN, param, token } from '../http.ts';
import { GameError } from '../lobby.ts';
import type { GameManager } from '../manager.ts';
import { QuizGame } from '../quiz.ts';
import { closeStream, openStream, rateLimit } from '../security.ts';

export function gameRoutes(app: Express, games: GameManager) {
  const limitCreate = rateLimit('create', 10, 10 * MIN, 'Zu viele neue Lobbys – bitte in ein paar Minuten nochmal.');
  const limitJoin = rateLimit('join', 30, 10 * MIN, 'Zu viele Beitrittsversuche – bitte kurz warten.');
  // jeder Start fragt die Wiener-Linien-API dutzende Male ab
  const limitStart = rateLimit('start', 12, 10 * MIN, 'Zu viele Spielstarts – bitte kurz warten.');
  const limitEvents = rateLimit('events', 60, MIN);

  // fehlende Lobby antwortet wie ein fremder Token (403) – sonst ließen sich Codes ausprobieren (Befund L-07).
  // Nur „Beitreten“ sagt ausdrücklich „Lobby nicht gefunden“ (dort mit eigenem Rate-Limit).
  const game = (req: Request) => {
    if (!games.has(param(req, 'code'))) throw new GameError('Du bist nicht in dieser Lobby.', 403);
    return games.get(param(req, 'code'));
  };
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
  const roundIdx = (req: Request) => {
    const n = Number(param(req, 'round'));
    if (!Number.isInteger(n) || n < 0 || n > 20) throw new GameError('Ungültige Runde');
    return n;
  };

  // Lobby erstellen (Ersteller = Host) – auch fürs Alleinspielen
  app.post(
    '/api/games',
    limitCreate,
    h((req): JoinResponse => {
      const body = req.body as CreateGameRequest;
      const g = games.create(body?.mode === 'quiz' ? 'quiz' : 'route', body?.settings, req.ip ?? '');
      const p = g.addPlayer(body?.playerName);
      return { playerId: p.id, token: p.token, state: g.state() };
    }),
  );

  // Mit Code beitreten
  app.post(
    '/api/games/:code/join',
    limitJoin,
    h((req): JoinResponse => {
      const g = games.get(param(req, 'code'));
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
}
