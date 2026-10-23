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

/** Alle Limits mit diesem Faktor (Standard 1) – Tests setzen RATE_LIMIT_SCALE hoch, damit sie nicht ausgebremst werden */
export const SCALE = Math.max(1, Number(process.env.RATE_LIMIT_SCALE) || 1);

/** Höchstens `max` Anfragen pro `windowMs` und IP für diesen Bereich */
export function rateLimit(name: string, max: number, windowMs: number, message = 'Zu viele Anfragen – bitte kurz warten.') {
  max *= SCALE;
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

const graphemes = new Intl.Segmenter('de', { granularity: 'grapheme' });
export const NAME_MAX = 20;

/** Chat-Text: wie Namen, aber länger (max. 300 sichtbare Zeichen); HTML wird beim Anzeigen escaped */
export function cleanChat(raw: unknown): string {
  const s = String(raw ?? '')
    .normalize('NFC')
    .replace(/[\u115F\u1160\u3164\uFFA0]/g, '')
    .replace(/(?!\u200D)\p{C}/gu, '')
    .replace(/(\p{M})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return [...graphemes.segment(s)]
    .slice(0, 300)
    .map((g) => g.segment)
    .join('')
    .trim();
}

/**
 * Spielername: ohne Steuer-/Formatzeichen (außer ZWJ – sonst zerfällt 👨‍👩‍👧), ohne HTML-Zeichen und unsichtbare
 * Füllzeichen, höchstens ein Zusatzzeichen je Buchstabe (gegen „Zalgo“), max. 20 sichtbare Zeichen – nie mitten
 * im Emoji gekürzt (Befund L-06).
 */
export function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .normalize('NFC')
    .replace(/[\u115F\u1160\u3164\uFFA0]/g, '')
    .replace(/(?!\u200D)[\p{C}<>"'`&\\]/gu, '')
    .replace(/(\p{M})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return [...graphemes.segment(s)]
    .slice(0, NAME_MAX)
    .map((g) => g.segment)
    .join('')
    .trim();
}
