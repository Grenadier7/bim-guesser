// Admin-Seite: Übersicht und Statistik, Lobbys steuern, Accounts verwalten, Netzpläne und Routenberechnung,
// Spiel-Konfiguration, Protokoll.
//
// Zugang: Admin-Recht nur über die Kommandozeile (server/admin-cli.ts), geprüft bei jeder Anfrage in der Datenbank.
// Zusätzlich muss der Admin-Bereich je Sitzung mit dem Passwort entsperrt werden (30 min ab der letzten Aktion,
// höchstens 8 h) – ein Login-Cookie allein reicht nie. Ändernde Anfragen nur als JSON (CSRF), eigenes Rate-Limit.
// Admin-Accounts selbst ändert nur die Kommandozeile. Dateien (Backups, State) sind von hier aus nie erreichbar:
// keine Route nimmt einen Pfad an.
import type { Express, NextFunction, Request, Response } from 'express';
import type { GameConfigSection } from '../../shared/config.ts';
import { defaultGameConfig } from '../../shared/config.ts';
import type { AdminOverview, CurrentNetInfo, DayType, Line, LineEdit, NetworkPlan, RoutingAdminState, RoutingParams, SlotId } from '../../shared/types.ts';
import { slotOr } from '../../shared/rules.ts';
import type { AccountAdmin, AccountUser, Accounts } from '../accounts.ts';
import type { GameConfigStore } from '../gameconfig.ts';
import { SECTION_LABEL } from '../gameconfig.ts';
import { h, MIN, param } from '../http.ts';
import { GameError } from '../lobby.ts';
import type { GameManager } from '../manager.ts';
import { Network } from '../network.ts';
import type { PlanRuntime } from '../planruntime.ts';
import { DEFAULT_PARAMS, sanitizeEdits, sanitizeParams, type PlanStore } from '../plans.ts';
import { topRoutes } from '../routing.ts';
import { rateLimit } from '../security.ts';
import { nextTypicalDay, slotTime } from '../timeslots.ts';
import { timetableInfo, timetableLines, timetableView } from '../timetable.ts';
import { jsonOnly, resetBase, sessionToken } from './accounts.ts';

export interface AdminDeps {
  accounts: Accounts;
  admin: AccountAdmin;
  games: GameManager;
  net: Network;
  version: string;
  started: number;
  plans: PlanStore;
  runtime: PlanRuntime;
  config: GameConfigStore;
}

const PARAM_NAMES: Record<keyof RoutingParams, string> = {
  changeMin: 'Umsteigezeit',
  transferWalkM: 'Umsteige-Fußweg',
  accessWalkM: 'Fußweg Adressen',
  walkOnlyM: 'ganz zu Fuß bis',
  maxRides: 'Fahrten höchstens',
  firstWaitFactor: 'erste Wartezeit',
};

/**
 * Verweise der Änderungen prüfen, der Reihe nach wie beim Anwenden: Linien und Stationen müssen zum Zeitpunkt der
 * Änderung existieren (neue Stationen/Linien zählen ab ihrer eigenen Änderung). Tippfehler → klare Meldung.
 */
function checkRefs(edits: LineEdit[], base: Network, extraLines: string[] = []) {
  const stations = new Set(base.stations.keys());
  // Regionalzüge gibt es nur im Fahrplan (nicht als Linie im Netz)
  const lines = new Set([...base.lines.keys(), ...extraLines]);
  const st = (id: string) => {
    if (!stations.has(id)) throw new GameError(`Station ${id} gibt es (an dieser Stelle) nicht.`);
  };
  const ln = (id: string) => {
    if (!lines.has(id)) throw new GameError(`Linie ${id} gibt es (an dieser Stelle) nicht.`);
  };
  for (const e of edits) {
    switch (e.kind) {
      case 'extend':
        ln(e.line);
        [e.at, ...e.stops.map((s) => s.station)].forEach(st);
        break;
      case 'cut':
        ln(e.line);
        [e.at, e.beyond].forEach(st);
        if (e.at === e.beyond) throw new GameError(`${e.line}: neue Endstation und wegfallendes Ende sind gleich.`);
        break;
      case 'time':
        ln(e.line);
        [e.from, e.to].forEach(st);
        break;
      case 'addStation':
        if (stations.has(e.station) || !/^n\d+$/.test(e.station)) throw new GameError('Neue Station: ungültige Kennung.');
        stations.add(e.station);
        break;
      case 'renameStation':
      case 'moveStation':
        st(e.station);
        break;
      case 'removeStation':
        st(e.station);
        stations.delete(e.station);
        break;
      case 'addLine':
        if (lines.has(e.line)) throw new GameError(`Linie ${e.line} gibt es schon – anderer Name oder vorher „Linie entfernen“.`);
        e.stops.forEach((s) => st(s.station));
        if (new Set(e.stops.map((s) => s.station)).size !== e.stops.length) throw new GameError(`${e.line}: jede Station nur einmal.`);
        lines.add(e.line);
        break;
      case 'removeLine':
        ln(e.line);
        lines.delete(e.line);
        break;
      case 'headway':
        ln(e.line);
        break;
      case 'addVariant':
        ln(e.line);
        e.stops.forEach((s) => st(s.station));
        break;
      case 'insertStop':
        ln(e.line);
        [e.a, e.b, e.station].forEach(st);
        break;
      case 'skipStop':
        ln(e.line);
        st(e.station);
        break;
      case 'departures':
        ln(e.line);
        break;
    }
  }
}

export function adminRoutes(app: Express, d: AdminDeps) {
  let lastReport: Record<string, string[]> = {};
  const limitUnlock = rateLimit('admin-unlock', 10, 10 * MIN, 'Zu viele Versuche – bitte {wait} nochmal.');
  const limitWrite = rateLimit('admin-write', 300, 10 * MIN, 'Sehr viele Änderungen in kurzer Zeit – bitte {wait} nochmal.');
  const stName = (id: string) => d.net.stations.get(id)?.name ?? id;

  /** angemeldet und Admin (ohne Entsperren – für Status und Entsperren selbst) */
  const adminUser = (req: Request): AccountUser => {
    const u = d.accounts.userFor(sessionToken(req));
    if (!u) throw new GameError('Bitte zuerst anmelden.', 401);
    if (!d.admin.isAdmin(u.id)) throw new GameError('Nur für Admins.', 403);
    return u;
  };
  /** Admin mit entsperrtem Admin-Bereich – jede weitere Admin-Route */
  const admin = (req: Request): AccountUser => {
    const u = adminUser(req);
    if (!d.accounts.adminUnlocked(sessionToken(req)!)) throw new GameError('Admin-Bereich gesperrt – bitte mit dem Passwort entsperren.', 423);
    return u;
  };
  const name = (req: Request) => param(req, 'name');

  app.use('/api/admin', jsonOnly);
  app.use('/api/admin', (req: Request, res: Response, next: NextFunction) => (req.method === 'GET' ? next() : limitWrite(req, res, next)));

  // ---------------------------------------------------------------- Zugang
  app.get('/api/admin/status', h((req) => {
    const u = d.accounts.userFor(sessionToken(req));
    const isAdmin = !!u && d.admin.isAdmin(u.id);
    return { admin: isAdmin, unlocked: isAdmin && d.accounts.adminUnlocked(sessionToken(req)!) };
  }));
  app.post(
    '/api/admin/unlock',
    limitUnlock,
    h(async (req) => {
      const u = adminUser(req);
      await d.accounts.adminUnlock(sessionToken(req)!, u.id, req.body?.password);
      d.admin.log(u.name, 'Admin-Bereich entsperrt');
      return { ok: true };
    }),
  );
  app.post('/api/admin/lock', h((req) => (adminUser(req), d.accounts.adminLock(sessionToken(req)!), { ok: true })));

  // ---------------------------------------------------------------- Übersicht, Statistik
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
  app.get('/api/admin/stats', h((req) => (admin(req), d.admin.stats(Math.min(365, Math.max(1, Number(req.query.days) || 30))))));

  // ---------------------------------------------------------------- Lobbys: alles, was ein Host kann (Schlüssel bleibt im Server)
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
      g.close('Von der Spielleitung beendet');
      d.admin.log(u.name, 'Lobby beendet', g.id, `${g.mode}, ${g.playerCount} Spieler`);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------------- Accounts (Admin-Accounts nur über die Kommandozeile)
  app.get('/api/admin/users', h((req) => (admin(req), d.admin.users(req.query.q, Number(req.query.offset) || 0))));
  app.get('/api/admin/users/:name', h((req) => (admin(req), d.admin.user(name(req)))));
  app.get('/api/admin/users/:name/stats', h((req) => (admin(req), d.admin.userStats(name(req), Math.min(365, Math.max(7, Number(req.query.days) || 90))))));
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

  // ---------------------------------------------------------------- Spiel-Konfiguration
  const isSection = (k: string): k is GameConfigSection => k in SECTION_LABEL;
  const section = (req: Request): GameConfigSection => {
    const k = param(req, 'section');
    if (!isSection(k)) throw new GameError('Unbekannter Bereich.', 404);
    return k;
  };
  const configState = () => ({ config: d.config.effective(), changed: Object.keys(d.config.stored()), defaults: defaultGameConfig(), labels: SECTION_LABEL });
  app.get('/api/admin/config', h((req) => (admin(req), configState())));
  app.put(
    '/api/admin/config/:section',
    h((req) => {
      const u = admin(req);
      const k = section(req);
      d.config.save(k, req.body?.value, u.name);
      d.admin.log(u.name, `Einstellungen: ${SECTION_LABEL[k]} geändert`);
      return configState();
    }),
  );
  app.delete(
    '/api/admin/config/:section',
    h((req) => {
      const u = admin(req);
      const k = section(req);
      d.config.reset(k, u.name);
      d.admin.log(u.name, `Einstellungen: ${SECTION_LABEL[k]} auf Standard`);
      return configState();
    }),
  );
  app.get('/api/admin/config-versions', h((req) => (admin(req), d.config.versions())));
  app.post(
    '/api/admin/config-versions/:id/restore',
    h((req) => {
      const u = admin(req);
      d.config.rollback(param(req, 'id'), u.name);
      d.admin.log(u.name, 'Einstellungen: frühere Version wiederhergestellt', null, param(req, 'id'));
      return configState();
    }),
  );
  app.get('/api/admin/addresses', h((req) => (admin(req), d.net.searchAddresses(String(req.query.q ?? '')))));
  app.get('/api/admin/addresses/all', h((req) => (admin(req), d.net.allAddresses())));

  // ---------------------------------------------------------------- Netzpläne und Routenberechnung
  const routingState = (): RoutingAdminState => ({ plans: d.plans.list(), defaults: DEFAULT_PARAMS, report: lastReport });
  /** fürs Protokoll in Worten statt JSON */
  const describe = (p: NetworkPlan): string => {
    const params = (Object.entries(p.params) as [keyof RoutingParams, number][]).map(([k, v]) => `${PARAM_NAMES[k]} ${v} (Standard ${DEFAULT_PARAMS[k]})`);
    const edits = p.edits.map((e) => {
      switch (e.kind) {
        case 'extend':
          return `${e.line} über ${stName(e.at)} hinaus: ${e.stops.map((s) => `${stName(s.station)} +${s.min}`).join(', ')}`;
        case 'cut':
          return `${e.line} endet bei ${stName(e.at)} (ohne Richtung ${stName(e.beyond)})`;
        case 'time':
          return `${e.line} ${stName(e.from)} ↔ ${stName(e.to)}: ${e.min} min`;
        case 'addStation':
          return `neue Station ${e.name}`;
        case 'renameStation':
          return `${stName(e.station)} heißt ${e.name}`;
        case 'moveStation':
          return `${stName(e.station)} verschoben`;
        case 'removeStation':
          return `${stName(e.station)} aufgelassen`;
        case 'addLine':
          return `neue Linie ${e.line} (${e.stops.length} Halte)`;
        case 'removeLine':
          return `Linie ${e.line} entfernt`;
        case 'headway':
          return `${e.line} ${e.day} ${e.from}–${e.to} alle ${e.every} min`;
        case 'addVariant':
          return `${e.line} zusätzlich ${stName(e.stops[0].station)} – ${stName(e.stops[e.stops.length - 1].station)}`;
        case 'insertStop':
          return `${e.line} hält zusätzlich in ${stName(e.station)}`;
        case 'skipStop':
          return `${e.line} hält nicht mehr in ${stName(e.station)}`;
        case 'departures':
          return `${e.line} Abfahrten ${e.day}: +${e.add.length} / −${e.remove.length}`;
      }
    });
    return [...params, ...edits].join(' · ') || 'keine Änderungen';
  };

  /** Regionalzüge des Standard-Fahrplans, die man bearbeiten kann */
  const regionalLines = () => timetableLines('__base', () => false).map((l) => l.line);
  app.get('/api/admin/routing', h((req) => (admin(req), routingState())));
  // „Aktuell“: nächster echter Tag – was im aktuellen Fahrplan anders ist als im regulären (Stand der Netzdaten)
  app.get(
    '/api/admin/routing/current',
    h((req): CurrentNetInfo => {
      admin(req);
      const n = d.runtime.planNet('__base') ?? d.net;
      const ref = (l: Line) => ({ id: l.id, mode: l.mode, color: l.color });
      const out: CurrentNetInfo = { generatedAt: n.data.generatedAt, days: { wd: '', sa: '', su: '' }, regularDays: n.data.regularDays, onlyCurrent: [], missing: [], changed: [], lobbies: 0 };
      for (const l of n.lines.values()) {
        const of = (flag: string) => l.patterns.filter((_, i) => l.nets[i].includes(flag)).map((p) => p.join(','));
        const c = of('c');
        const r = of('r');
        if (c.length && !r.length) out.onlyCurrent.push(ref(l));
        else if (r.length && !c.length) out.missing.push(ref(l));
        else if (c.length !== r.length || c.some((x) => !r.includes(x))) out.changed.push(ref(l));
      }
      for (const t of ['wd', 'sa', 'su'] as DayType[]) out.days[t] = nextTypicalDay(t).toISOString().slice(0, 10);
      out.lobbies = d.games.list().filter((g) => (g.state() as { settings?: { network?: string } }).settings?.network === 'current').length;
      return out;
    }),
  );
  // alle Linien eines Netzplans im Fahrplan (plan=__base: wie gebaut, ohne Änderungen)
  app.get(
    '/api/admin/routing/lines',
    h((req) => {
      admin(req);
      const plan = String(req.query.plan ?? 'regular');
      const n = d.runtime.planNet(plan);
      if (!n) throw new GameError('Diesen Netzplan gibt es nicht.', 404);
      return timetableLines(plan, (l) => n.lines.has(l), (efa) => n.stations.get(n.stationOfEfa(efa) ?? '')?.name ?? null);
    }),
  );
  app.put(
    '/api/admin/routing/plans/:id',
    h((req) => {
      const u = admin(req);
      const id = param(req, 'id');
      if (!/^[a-z0-9-]{1,24}$/.test(id)) throw new GameError('Kennung: 1–24 Kleinbuchstaben, Ziffern oder „-“.');
      const edits = sanitizeEdits(req.body?.edits);
      checkRefs(edits, Network.load(), regionalLines());
      const plan: NetworkPlan = {
        id,
        label: String(req.body?.label ?? (id === 'regular' ? 'Regulär' : id)),
        hint: String(req.body?.hint ?? ''),
        inMenu: id !== 'regular' && req.body?.inMenu === true,
        params: sanitizeParams(req.body?.params),
        edits,
        updatedAt: Date.now(),
        updatedBy: u.name,
      };
      const list = d.plans.list().filter((p) => p.id !== id);
      const isNew = list.length === d.plans.list().length;
      const saved = d.plans.save([...list, plan], u.name, `${isNew ? 'Netzplan angelegt' : 'Netzplan geändert'}: ${plan.label}`);
      lastReport = { ...lastReport, ...d.runtime.apply(id) };
      d.admin.log(u.name, isNew ? 'Netzplan angelegt' : 'Netzplan geändert', saved.find((p) => p.id === id)!.label, describe(saved.find((p) => p.id === id)!).slice(0, 2000));
      return routingState();
    }),
  );
  app.delete(
    '/api/admin/routing/plans/:id',
    h((req) => {
      const u = admin(req);
      const id = param(req, 'id');
      if (id === 'regular') throw new GameError('Den Standard-Netzplan kann man nicht löschen – nur seine Änderungen.');
      const plan = d.plans.get(id);
      if (!plan) throw new GameError('Diesen Netzplan gibt es nicht.', 404);
      d.plans.save(
        d.plans.list().filter((p) => p.id !== id),
        u.name,
        `Netzplan gelöscht: ${plan.label}`,
      );
      delete lastReport[id];
      d.runtime.apply(id);
      d.admin.log(u.name, 'Netzplan gelöscht', plan.label);
      return routingState();
    }),
  );
  app.get('/api/admin/routing/versions', h((req) => (admin(req), d.plans.versions())));
  app.post(
    '/api/admin/routing/versions/:id/restore',
    h((req) => {
      const u = admin(req);
      d.plans.rollback(param(req, 'id'), u.name);
      lastReport = d.runtime.apply();
      d.admin.log(u.name, 'Netzpläne: frühere Version wiederhergestellt', null, param(req, 'id'));
      return routingState();
    }),
  );
  // Fahrplan einer Linie ansehen (Haltefolgen, Fahrzeiten, Fahrten je Stunde)
  app.get(
    '/api/admin/routing/timetable',
    h((req) => {
      admin(req);
      const plan = String(req.query.plan ?? 'regular');
      const n = d.runtime.planNet(plan);
      if (!n) throw new GameError('Diesen Netzplan gibt es nicht.', 404);
      const v = timetableView(plan, String(req.query.line ?? ''), (efa) => n.stationOfEfa(efa), (efa) => n.stations.get(n.stationOfEfa(efa) ?? '')?.name ?? null);
      if (!v) throw new GameError('Diese Linie gibt es im Fahrplan nicht (oder der Fahrplan ist aus).', 404);
      return v;
    }),
  );
  // Probe: beste Verbindungen für ein Paar mit den gespeicherten Einstellungen eines Plans (wie im Spiel, „Realistisch“)
  app.post(
    '/api/admin/routing/test',
    h(async (req) => {
      admin(req);
      const plan = String(req.body?.plan ?? 'regular');
      const n = d.runtime.planNet(plan);
      if (!n) throw new GameError('Diesen Netzplan gibt es nicht.', 404);
      const from = String(req.body?.from ?? '');
      const to = String(req.body?.to ?? '');
      if (!n.stations.has(from) || !n.stations.has(to) || from === to) throw new GameError('Start und Ziel wählen (zwei verschiedene Stationen).');
      const slot: SlotId = slotOr(req.body?.slot);
      const time = slotTime(slot, 'regular', n.data.regularDays);
      return topRoutes(n, from, to, time, { countWait: true, avgWait: true, restriction: null });
    }),
  );
}
