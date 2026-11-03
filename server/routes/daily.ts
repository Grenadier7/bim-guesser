// Strecke des Tages: Strecke holen, Route abgeben, Rangliste (Tag/Woche, alle/Freunde)
import type { Express, Request } from 'express';
import type { AccountUser } from '../accounts.ts';
import type { DailyService } from '../daily.ts';
import { h, MIN } from '../http.ts';
import { rateLimit } from '../security.ts';

export function dailyRoutes(app: Express, daily: DailyService, optionalUser: (req: Request) => AccountUser | null) {
  const limitSubmit = rateLimit('daily-submit', 30, 10 * MIN, 'Viele Versuche in kurzer Zeit – nächste {wait}.');
  app.get('/api/daily', h((req) => daily.round(optionalUser(req)?.id ?? null)));
  app.post('/api/daily/submit', limitSubmit, h((req) => daily.submit(req.body?.legs, optionalUser(req)?.id ?? null)));
  app.get(
    '/api/daily/board',
    h((req) => daily.board(req.query.scope === 'week' ? 'week' : 'day', req.query.friends === '1', optionalUser(req)?.id ?? null)),
  );
}
