// Hilfen für Express-Routen: async Handler, Parameter, Spieler-Token, einheitliche Fehlerantworten
import type { NextFunction, Request, Response } from 'express';
import { GameError } from './lobby.ts';

export const MIN = 60_000;

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
/** Rückgabewert des Handlers wird als JSON gesendet, Fehler gehen an errorHandler */
export const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res))
    .then((body) => body !== undefined && !res.headersSent && res.json(body))
    .catch(next);
};
export const param = (req: Request, k: string) => String(req.params[k]);
/** Geheimer Spieler-Token: im Body, bei GET/SSE als Query-Parameter */
export const token = (req: Request) => String(req.body?.token ?? req.query.token ?? '').slice(0, 64);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // GameError: eigene Meldung; Fehler von express.json (kaputtes JSON, zu groß) haben einen 4xx-Status
  const status = err instanceof GameError ? err.status : Number((err as { status?: number })?.status) || 500;
  // erwartbare Fehler (z.B. Auskunft nicht erreichbar) als kurze Zeile, echte Fehler mit Stack
  if (err instanceof GameError && status >= 500) console.warn(`[${new Date().toLocaleTimeString('de-AT')}] ${err.message}`);
  else if (status >= 500) console.error(err);
  const msg = err instanceof GameError ? err.message : status < 500 ? 'Ungültige Anfrage' : 'Interner Fehler';
  res.status(status).json({ error: msg });
}
