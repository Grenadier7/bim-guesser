// Admin-Seite: Accounts verwalten, Lobbys sehen/beenden, Routenberechnung einstellen, Protokoll.
// Nur für Accounts mit Admin-Recht (vergeben über server/admin-cli.ts); geprüft bei jeder Anfrage in der Datenbank –
// wer die Rechte verliert, verliert sie sofort. Jede Änderung steht im Protokoll.
import type { Express, Request } from 'express';
import type { AdminOverview, RoutingAdminState, RoutingOverrides, RoutingParams } from '../../shared/types.ts';
import type { AccountAdmin, AccountUser, Accounts } from '../accounts.ts';
import { h, param } from '../http.ts';
import { GameError } from '../lobby.ts';
import type { GameManager } from '../manager.ts';
import type { Network } from '../network.ts';
import { DEFAULT_PARAMS, overrides, sanitizeOverrides, saveOverrides } from '../overrides.ts';
import { topRoutes } from '../routing.ts';
import { slotTime } from '../timeslots.ts';
import { timetableInfo } from '../timetable.ts';
import { jsonOnly, resetBase, sessionToken } from './accounts.ts';

export interface AdminDeps {
  accounts: Accounts;
  admin: AccountAdmin;
  games: GameManager;
  net: Network;
  version: string;
  started: number;
  /** Linien-Änderungen und Parameter neu anwenden (Fahrplan + Netz); liefert den Bericht */
  applyRouting: () => string[];
}

const PARAM_NAMES: Record<keyof RoutingParams, string> = {
  changeMin: 'Umsteigezeit',
  transferWalkM: 'Umsteige-Fußweg',
  accessWalkM: 'Fußweg Adressen',
  walkOnlyM: 'ganz zu Fuß bis',
  maxRides: 'Fahrten höchstens',
  firstWaitFactor: 'erste Wartezeit',
};

export function adminRoutes(app: Express, d: AdminDeps) {
  let lastReport: string[] = [];
  const st = (id: string) => d.net.stations.get(id)?.name ?? id;
  /** fürs Protokoll in Worten statt JSON */
  const describeOverrides = (o: RoutingOverrides): string => {
    const params = (Object.entries(o.params) as [keyof RoutingParams, number][]).map(([k, v]) => `${PARAM_NAMES[k]} ${v} (Standard ${DEFAULT_PARAMS[k]})`);
    const edits = o.edits.map((e) =>
      e.kind === 'extend'
        ? `${e.line} über ${st(e.at)} hinaus: ${e.stops.map((s) => `${st(s.station)} +${s.min}`).join(', ')}`
        : e.kind === 'cut'
          ? `${e.line} endet bei ${st(e.at)} (ohne Richtung ${st(e.beyond)})`
          : `${e.line} ${st(e.from)} ↔ ${st(e.to)}: ${e.min} min`,
    );
    return [...params, ...edits].join(' · ') || 'alles auf Standard';
  };

  const admin = (req: Request): AccountUser => {
    const u = d.accounts.userFor(sessionToken(req));
    if (!u) throw new GameError('Bitte zuerst anmelden.', 401);
    if (!d.admin.isAdmin(u.id)) throw new GameError('Nur für Admins.', 403);
    return u;
  };
  const name = (req: Request) => param(req, 'name');

  app.use('/api/admin', jsonOnly);

  app.get(
    '/api/admin/overview',
    h((req): AdminOverview => {
      admin(req);
      return {
        version: d.version,
        uptimeSec: Math.round((Date.now() - d.started) / 1000),
        memoryMb: Math.round(process.memoryUsage().rss / 1e6),
        users: d.admin.counts(),
        lobbies: d.games
          .list()
          .map((g) => g.adminInfo())
          .sort((a, b) => b.lastActivity - a.lastActivity),
        activeGames: d.games.activeGames(),
        mail: !!d.accounts.mail,
        warnings: d.net.referenceWarnings(),
        timetable: timetableInfo(),
      };
    }),
  );
  // alles, was ein Host kann – im Auftrag des Admins (Schlüssel bleibt im Server)
  const lobbyAction = (path: string, label: string, act: (g: ReturnType<GameManager['get']>, req: Request) => unknown) =>
    app.post(
      `/api/admin/lobbies/:code/${path}`,
      h(async (req) => {
        const u = admin(req);
        const g = d.games.get(param(req, 'code'));
        // Name vorher merken – nach „entfernen“ ist der Spieler weg
        const who = req.body?.playerId ? g.adminInfo().players.find((p) => p.id === req.body.playerId)?.name : null;
        await act(g, req);
        d.admin.log(u.name, label, g.id, who ? `Spieler ${who}` : null);
        return g.adminInfo();
      }),
    );
  lobbyAction('start', 'Lobby: Spiel gestartet', (g) => g.start(g.adminKey));
  lobbyAction('next', 'Lobby: weiter', (g) => g.next(g.adminKey));
  lobbyAction('pause', 'Lobby: pausiert', (g) => g.pause(g.adminKey));
  lobbyAction('resume', 'Lobby: fortgesetzt', (g) => g.resume(g.adminKey));
  lobbyAction('cancel', 'Lobby: Runde abgebrochen', (g) => g.cancelRound(g.adminKey));
  lobbyAction('lobby', 'Lobby: zurück in die Lobby', (g) => g.backToLobby(g.adminKey));
  lobbyAction('kick', 'Lobby: Spieler entfernt', (g, req) => g.kick(g.adminKey, String(req.body?.playerId ?? '')));
  lobbyAction('host', 'Lobby: Host geändert', (g, req) => g.setHost(g.adminKey, String(req.body?.playerId ?? ''), req.body?.on !== false));
  app.post(
    '/api/admin/lobbies/:code/chat',
    h((req) => {
      admin(req);
      const g = d.games.get(param(req, 'code'));
      g.adminSay(req.body?.text);
      return g.adminInfo();
    }),
  );
  app.get('/api/admin/lobbies/:code', h((req) => (admin(req), d.games.get(param(req, 'code')).adminInfo())));
  app.post(
    '/api/admin/lobbies/:code/close',
    h((req) => {
      const u = admin(req);
      const g = d.games.get(param(req, 'code'));
      g.close('Vom Admin beendet');
      d.admin.log(u.name, 'Lobby beendet', g.id, `${g.mode}, ${g.playerCount} Spieler`);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------------- Accounts
  app.get('/api/admin/users', h((req) => (admin(req), d.admin.users(req.query.q, Number(req.query.offset) || 0))));
  app.get('/api/admin/users/:name', h((req) => (admin(req), d.admin.user(name(req)))));
  app.delete('/api/admin/users/:name', h((req) => (d.admin.remove(admin(req).name, name(req)), { ok: true })));
  app.post('/api/admin/users/:name/password', h(async (req) => (await d.admin.setPassword(admin(req).name, name(req), req.body?.password), { ok: true })));
  app.post(
    '/api/admin/users/:name/reset-link',
    h((req) => {
      const u = admin(req);
      const base = resetBase(req);
      if (!base) throw new GameError('Ohne öffentliche Adresse (PUBLIC_URL) kann kein Link erzeugt werden.', 503);
      return { link: d.admin.resetLink(u.name, name(req), base) };
    }),
  );
  app.post('/api/admin/users/:name/logout', h((req) => ({ sessions: d.admin.logout(admin(req).name, name(req)) })));
  app.post('/api/admin/users/:name/reset-stats', h((req) => (d.admin.resetStats(admin(req).name, name(req)), { ok: true })));
  app.put('/api/admin/users/:name/name', h((req) => ({ name: d.admin.rename(admin(req).name, name(req), req.body?.name) })));
  app.put('/api/admin/users/:name/email', h((req) => (d.admin.setEmail(admin(req).name, name(req), req.body?.email), { ok: true })));

  app.get('/api/admin/log', h((req) => (admin(req), d.admin.logEntries())));

  // ---------------------------------------------------------------- Routenberechnung
  const routingState = (): RoutingAdminState => ({ overrides: overrides(), defaults: DEFAULT_PARAMS, report: lastReport });
  app.get('/api/admin/routing', h((req) => (admin(req), routingState())));
  app.put(
    '/api/admin/routing',
    h((req) => {
      const u = admin(req);
      const next: RoutingOverrides = sanitizeOverrides({ params: req.body?.params, edits: req.body?.edits });
      // Linien und Stationen müssen im Netz existieren – Tippfehler sofort melden statt still zu ignorieren
      for (const e of next.edits) {
        if (!d.net.lines.has(e.line)) throw new GameError(`Linie ${e.line} gibt es nicht.`);
        const ids = e.kind === 'extend' ? [e.at, ...e.stops.map((s) => s.station)] : e.kind === 'cut' ? [e.at, e.beyond] : [e.from, e.to];
        for (const id of ids) if (!d.net.stations.has(id)) throw new GameError(`Station ${id} gibt es nicht.`);
      }
      next.updatedAt = Date.now();
      next.updatedBy = u.name;
      saveOverrides(next);
      lastReport = d.applyRouting();
      d.admin.log(u.name, 'Routenberechnung geändert', null, describeOverrides(next).slice(0, 2000));
      return routingState();
    }),
  );
  // Probe: schnellste Verbindungen für ein Paar mit den aktuellen Einstellungen (wie im Spiel, regulärer Werktag)
  app.post(
    '/api/admin/routing/test',
    h(async (req) => {
      admin(req);
      const from = String(req.body?.from ?? '');
      const to = String(req.body?.to ?? '');
      if (!d.net.stations.has(from) || !d.net.stations.has(to) || from === to) throw new GameError('Start und Ziel wählen (zwei verschiedene Stationen).');
      const slot = ['wd12', 'wd17', 'sa02', 'su12'].includes(req.body?.slot) ? req.body.slot : 'wd12';
      const time = slotTime(slot, 'regular', d.net.data.regularDays);
      return topRoutes(d.net, from, to, time, { countWait: true, avgWait: true, restriction: null });
    }),
  );
}
