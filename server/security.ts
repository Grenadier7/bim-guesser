// Schutzmaßnahmen für den öffentlichen Betrieb (z.B. über ngrok).
import type { NextFunction, Request, Response } from 'express';

/** Sicherheits-Header für alle Antworten */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      // Leaflet & Linien-Chips setzen Inline-Styles
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://server.arcgisonline.com",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

// ---------------------------------------------------------------- Rate-Limits

interface Bucket {
  hits: number[];
}
const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (!b.hits.length || now - b.hits[b.hits.length - 1] > 3600_000) buckets.delete(k);
}, 600_000).unref();

/** Höchstens `max` Anfragen pro `windowMs` und IP für diesen Bereich */
export function rateLimit(name: string, max: number, windowMs: number, message = 'Zu viele Anfragen – bitte kurz warten.') {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const b = buckets.get(key) ?? { hits: [] };
    b.hits = b.hits.filter((t) => now - t < windowMs);
    if (b.hits.length >= max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - b.hits[0])) / 1000)));
      res.status(429).json({ error: message });
      return;
    }
    b.hits.push(now);
    buckets.set(key, b);
    next();
  };
}

// ---------------------------------------------------------------- Live-Verbindungen

const streamsPerIp = new Map<string, number>();
export const MAX_STREAMS_PER_IP = 20;

export function openStream(ip: string): boolean {
  const n = streamsPerIp.get(ip) ?? 0;
  if (n >= MAX_STREAMS_PER_IP) return false;
  streamsPerIp.set(ip, n + 1);
  return true;
}

export function closeStream(ip: string) {
  const n = (streamsPerIp.get(ip) ?? 1) - 1;
  if (n <= 0) streamsPerIp.delete(ip);
  else streamsPerIp.set(ip, n);
}

// ---------------------------------------------------------------- Eingaben

/** Spielername: keine Steuerzeichen, kein HTML, max. 20 Zeichen */
export function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFC')
    .replace(/[\p{C}<>"'`&\\]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}
