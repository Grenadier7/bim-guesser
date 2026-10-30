// Accounts: Registrieren/Anmelden (Cookie „angemeldet bleiben“), Passwort vergessen, Spielstand-Sync,
// Leute & Freunde, Profile, Einladungen
import type { Express, NextFunction, Request, Response } from 'express';
import { SESSION_DAYS, type AccountUser, type Accounts } from '../accounts.ts';
import { h, MIN, param } from '../http.ts';
import { GameError } from '../lobby.ts';
import { publicUrl } from '../mail.ts';
import { rateLimit } from '../security.ts';

export const COOKIE = 'bg_sid';

/** Adresse für Links zum Zurücksetzen – nie aus dem Host-Header (nur lokal in der Entwicklung unbedenklich) */
export function resetBase(req: Request): string | null {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.get('host') ?? '');
  return publicUrl() ?? (local ? `${req.protocol}://${req.get('host')}` : null);
}

/** Kontakt für Datenschutz-Fragen: CONTACT_EMAIL oder die Adresse aus MAIL_FROM („Name <adresse>“) */
export function contactEmail(): string | null {
  const raw = process.env.CONTACT_EMAIL || process.env.MAIL_FROM || '';
  const m = /<([^>]+)>/.exec(raw)?.[1] ?? raw;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(m.trim()) && !/\.local$|example\.(org|com)$/.test(m.trim()) ? m.trim() : null;
}

/** Sitzungs-Token aus dem Cookie */
export function sessionToken(req: Request): string | null {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`).exec(req.headers.cookie ?? '');
  return m ? m[1] : null;
}

function setCookie(req: Request, res: Response, token: string | null) {
  const parts = [`${COOKIE}=${token ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/**
 * Schutz gegen fremde Seiten (CSRF): ändernde Anfragen mit Cookie nur als JSON – ein Formular einer anderen Seite kann
 * kein `application/json` schicken, und ein Skript dort bräuchte eine CORS-Freigabe, die es nicht gibt.
 */
export function jsonOnly(req: Request, _res: Response, next: NextFunction) {
  if (req.method !== 'GET' && !req.is('application/json')) return next(new GameError('Ungültige Anfrage', 415));
  next();
}

export function accountRoutes(app: Express, accounts: Accounts, alive: (code: string) => boolean) {
  const limitAuth = rateLimit('auth', 20, 10 * MIN, 'Zu viele Anmeldeversuche – bitte {wait} nochmal.');
  const limitRegister = rateLimit('register', 6, 30 * MIN, 'Zu viele neue Accounts von hier – bitte {wait} nochmal.');
  const limitForgot = rateLimit('forgot', 5, 30 * MIN, 'Zu oft „Passwort vergessen“ – bitte {wait} nochmal. Schau inzwischen auch im Spam-Ordner nach.');
  const limitSocial = rateLimit('social', 120, 10 * MIN);

  const user = (req: Request): AccountUser => {
    const u = accounts.userFor(sessionToken(req));
    if (!u) throw new GameError('Bitte zuerst anmelden.', 401);
    return u;
  };
  const me = (u: AccountUser) => accounts.me(u.id, alive);

  app.use(['/api/auth', '/api/me', '/api/friends', '/api/users'], jsonOnly);

  app.post(
    '/api/auth/register',
    limitRegister,
    h(async (req, res) => {
      const { user: u, token } = await accounts.register(req.body?.name, req.body?.password, req.body?.email);
      setCookie(req, res, token);
      return me(u);
    }),
  );
  app.post(
    '/api/auth/login',
    limitAuth,
    h(async (req, res) => {
      const { user: u, token } = await accounts.login(req.body?.name, req.body?.password);
      setCookie(req, res, token);
      return me(u);
    }),
  );
  app.post(
    '/api/auth/logout',
    h((req, res) => {
      const t = sessionToken(req);
      if (t) accounts.logout(t);
      setCookie(req, res, null);
      return { ok: true };
    }),
  );
  /** kann dieser Server Reset-Mails schicken? (sonst blendet die Seite „Passwort vergessen“ aus) */
  const canReset = (req: Request) => !!accounts.mail && !!resetBase(req);

  app.post(
    '/api/auth/forgot',
    limitForgot,
    h(async (req) => {
      const base = resetBase(req);
      if (!accounts.mail || !base) {
        // technische Ursache nur ins Log – Spieler bekommen eine verständliche Meldung
        console.warn(`„Passwort vergessen“ angefragt, aber ${accounts.mail ? 'PUBLIC_URL' : 'SMTP_URL'} fehlt – Reset ist aus.`);
        throw new GameError(`Passwort zurücksetzen geht hier gerade nicht.${contactEmail() ? ` Schreib an ${contactEmail()}.` : ''}`, 503);
      }
      await accounts.forgot(req.body?.email, base);
      return { ok: true };
    }),
  );
  app.post(
    '/api/auth/reset',
    limitAuth,
    h(async (req, res) => {
      const { user: u, token } = await accounts.reset(req.body?.token, req.body?.password);
      setCookie(req, res, token);
      return me(u);
    }),
  );

  // nicht angemeldet ist kein Fehler: { user: null }
  app.get(
    '/api/me',
    h((req) => {
      const u = accounts.userFor(sessionToken(req));
      return { user: u ? me(u) : null };
    }),
  );
  app.put('/api/me/data', h((req) => (accounts.saveData(user(req).id, req.body?.data), { ok: true })));
  app.put('/api/me/email', h((req) => (accounts.setEmail(user(req).id, req.body?.email), me(user(req)))));
  app.post(
    '/api/me/password',
    limitAuth,
    h(async (req) => {
      await accounts.changePassword(user(req).id, req.body?.old, req.body?.password, sessionToken(req)!);
      return { ok: true };
    }),
  );
  // Account löschen: mit Passwort bestätigen, danach ist die Sitzung weg
  app.post(
    '/api/me/delete',
    limitAuth,
    h(async (req, res) => {
      await accounts.deleteAccount(user(req).id, req.body?.password);
      setCookie(req, res, null);
      return { ok: true };
    }),
  );
  // für den Datenschutz-Hinweis: Kontaktadresse (CONTACT_EMAIL, sonst Absender der Mails) und ob Mails verschickt werden
  app.get('/api/privacy', h((req) => ({ contact: contactEmail(), mail: canReset(req) })));
  app.delete('/api/me/invites/:id', h((req) => (accounts.dropInvite(user(req).id, Number(param(req, 'id'))), { ok: true })));

  // Leute, Profile, Freunde
  app.get('/api/users', limitSocial, h((req) => accounts.list(accounts.userFor(sessionToken(req))?.id ?? null, req.query.q, Number(req.query.offset) || 0)));
  app.get('/api/users/:name', limitSocial, h((req) => accounts.profile(accounts.userFor(sessionToken(req))?.id ?? null, param(req, 'name'))));
  app.get('/api/friends', h((req) => accounts.friends(user(req).id)));
  app.post('/api/friends/:name', limitSocial, h((req) => ({ relation: accounts.befriend(user(req).id, param(req, 'name')) })));
  app.delete('/api/friends/:name', h((req) => (accounts.unfriend(user(req).id, param(req, 'name')), { ok: true })));

  // nur für automatische Tests (nie im Betrieb): Zeit vorspulen, damit Tests nicht Minuten/Stunden warten müssen
  if (process.env.TEST_HOOKS === '1')
    app.post('/api/__test/age/:name', h((req) => (accounts.testAge(param(req, 'name'), { seenMinAgo: req.body?.seenMinAgo, invitesMinOlder: req.body?.invitesMinOlder }), { ok: true })));

  return { user, optionalUser: (req: Request) => accounts.userFor(sessionToken(req)) };
}
