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

/**
 * Schlüssel, die in echtem JSON nie sinnvoll sind, aber String()/Number() zum Absturz bringen
 * (`{"token":{"toString":1}}` → TypeError → 500, Befund M-08) oder Prototypen verschmutzen könnten.
 */
const DANGEROUS_KEYS = ['toString', 'valueOf', 'toJSON', 'toLocaleString', '__proto__', 'constructor', 'prototype'];

/** entfernt solche Schlüssel aus dem JSON-Body – iterativ, damit auch tief verschachtelter Body keinen Stack-Überlauf auslöst */
export function stripDangerousKeys(req: Request, _res: Response, next: NextFunction) {
  const stack: unknown[] = [req.body];
  for (let n = 0; stack.length && n < 50_000; n++) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (!Array.isArray(v)) for (const k of DANGEROUS_KEYS) if (Object.hasOwn(v, k)) delete (v as Record<string, unknown>)[k];
    for (const x of Object.values(v)) if (x && typeof x === 'object') stack.push(x);
  }
  next();
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // GameError: eigene Meldung; Fehler von express.json (kaputtes JSON, zu groß) haben einen 4xx-Status
  const status = err instanceof GameError ? err.status : Number((err as { status?: number })?.status) || 500;
  // erwartbare Fehler (z.B. Auskunft nicht erreichbar) als kurze Zeile, echte Fehler mit Stack
  if (err instanceof GameError && status >= 500) console.warn(`[${new Date().toLocaleTimeString('de-AT')}] ${err.message}`);
  else if (status >= 500) console.error(err);
  const msg = err instanceof GameError ? err.message : status < 500 ? 'Ungültige Anfrage' : 'Interner Fehler';
  res.status(status).json({ error: msg });
}
