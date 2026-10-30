// Netzpläne der Admin-Seite: der Standard-Netzplan („regular“) und weitere, die in der Lobby wählbar sein können.
// Ein Netzplan = Stellschrauben der Routenberechnung + Änderungen am gebauten Netz (data/network.json) und Fahrplan
// (data/timetable.json): Linien verlängern/kürzen/neu/entfernen, Fahrzeiten, Stationen neu/umbenennen/verschieben/
// auflassen. Gespeichert in STATE_DIR/config/plans.json mit Versionen; angewendet in network.ts und timetable.ts.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DayType, LineEdit, Mode, NetworkPlan, RoutingParams, ServiceBand } from '../shared/types.ts';
import type { MenuPlan } from '../shared/config.ts';
import { GameError } from './lobby.ts';
import { STATE_DIR } from './paths.ts';
import { VersionedJson } from './versioned.ts';

export const DEFAULT_PARAMS: RoutingParams = {
  changeMin: 2,
  transferWalkM: 500,
  accessWalkM: 1500,
  walkOnlyM: 1200,
  maxRides: 5,
  firstWaitFactor: 0.7,
};

/** erlaubter Bereich je Parameter – Unsinn (−5 min Umsteigen) wird abgelehnt */
export const PARAM_LIMITS: Record<keyof RoutingParams, [number, number]> = {
  changeMin: [0, 15],
  transferWalkM: [0, 1500],
  accessWalkM: [200, 3000],
  walkOnlyM: [0, 5000],
  maxRides: [1, 8],
  firstWaitFactor: [0, 1],
};

const MODES: Mode[] = ['U', 'S', 'T', 'B', 'N'];

const str = (v: unknown, what: string, max = 60): string => {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim();
  if (!s || s.length > max) throw new GameError(`${what} fehlt oder ist zu lang.`);
  return s;
};
const minutes = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 60) throw new GameError('Fahrzeit: 0–60 Minuten.');
  return Math.round(n);
};
const coord = (v: unknown, lo: number, hi: number, what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new GameError(`${what} liegt nicht in Wien.`);
  return Math.round(n * 1e6) / 1e6;
};
const hhmm = (v: unknown): string => {
  const s = String(v ?? '');
  // bis 27:59 – Nachtfahrten nach Mitternacht gehören noch zum Betriebstag
  if (!/^([01]\d|2[0-7]):[0-5]\d$/.test(s)) throw new GameError('Uhrzeit im Format HH:MM (bis 27:59).');
  return s;
};

export function sanitizeParams(input: unknown): Partial<RoutingParams> {
  const out: Partial<RoutingParams> = {};
  for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    if (!(k in DEFAULT_PARAMS) || v == null || v === '') continue;
    const key = k as keyof RoutingParams;
    const n = Number(v);
    const [lo, hi] = PARAM_LIMITS[key];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new GameError(`${key}: erlaubt sind ${lo}–${hi}.`);
    if (n !== DEFAULT_PARAMS[key]) out[key] = key === 'firstWaitFactor' ? Math.round(n * 100) / 100 : Math.round(n);
  }
  return out;
}

/** Änderungen prüfen (Form) – ob Linien und Stationen existieren, prüft der Server mit dem Netz des Plans */
export function sanitizeEdits(input: unknown): LineEdit[] {
  if (!Array.isArray(input)) return [];
  if (input.length > 200) throw new GameError('Höchstens 200 Änderungen je Netzplan.');
  return (input as Record<string, unknown>[]).map((e): LineEdit => {
    switch (e?.kind) {
      case 'extend': {
        const stops = Array.isArray(e.stops) ? (e.stops as Record<string, unknown>[]) : [];
        if (!stops.length || stops.length > 15) throw new GameError(`${String(e.line)}: 1–15 neue Halte angeben.`);
        return { kind: 'extend', line: str(e.line, 'Linie'), at: str(e.at, 'Bisherige Endstation'), stops: stops.map((s) => ({ station: str(s.station, 'Halt'), min: minutes(s.min) })) };
      }
      case 'cut':
        return { kind: 'cut', line: str(e.line, 'Linie'), at: str(e.at, 'Neue Endstation'), beyond: str(e.beyond, 'Wegfallendes Ende') };
      case 'time':
        return { kind: 'time', line: str(e.line, 'Linie'), from: str(e.from, 'Von'), to: str(e.to, 'Nach'), min: minutes(e.min) };
      case 'addStation':
        return {
          kind: 'addStation',
          station: str(e.station, 'Station'),
          name: str(e.name, 'Name'),
          lat: coord(e.lat, 48.1, 48.33, 'Ort'),
          lon: coord(e.lon, 16.18, 16.58, 'Ort'),
          district: Math.min(23, Math.max(0, Math.round(Number(e.district) || 0))),
        };
      case 'renameStation':
        return { kind: 'renameStation', station: str(e.station, 'Station'), name: str(e.name, 'Name') };
      case 'moveStation':
        return { kind: 'moveStation', station: str(e.station, 'Station'), lat: coord(e.lat, 48.1, 48.33, 'Ort'), lon: coord(e.lon, 16.18, 16.58, 'Ort') };
      case 'removeStation':
        return { kind: 'removeStation', station: str(e.station, 'Station') };
      case 'addLine': {
        const line = str(e.line, 'Linienname', 8);
        if (!/^[\p{L}\d]{1,8}$/u.test(line)) throw new GameError('Linienname: 1–8 Buchstaben/Ziffern (z.B. U5, 13B).');
        const mode = MODES.find((m) => m === e.mode);
        if (!mode) throw new GameError('Verkehrsmittel wählen.');
        const color = String(e.color ?? '');
        if (!/^#[0-9a-f]{6}$/i.test(color)) throw new GameError('Farbe als #rrggbb.');
        const stops = Array.isArray(e.stops) ? (e.stops as Record<string, unknown>[]) : [];
        if (stops.length < 2 || stops.length > 80) throw new GameError(`${line}: 2–80 Halte.`);
        const service = {} as Record<DayType, ServiceBand[]>;
        const sv = (e.service ?? {}) as Record<string, unknown>;
        for (const d of ['wd', 'sa', 'su'] as DayType[]) {
          const bands = Array.isArray(sv[d]) ? (sv[d] as Record<string, unknown>[]) : [];
          if (bands.length > 8) throw new GameError('Höchstens 8 Zeiträume je Tag.');
          service[d] = bands.map((b) => {
            const every = Math.round(Number(b.every));
            if (!(every >= 2 && every <= 120)) throw new GameError('Takt: alle 2–120 Minuten.');
            return { from: hhmm(b.from), to: hhmm(b.to), every };
          });
        }
        if (!Object.values(service).some((b) => b.length)) throw new GameError(`${line}: mindestens einen Betriebszeitraum angeben.`);
        return { kind: 'addLine', line, mode, color, stops: stops.map((s, i) => ({ station: str(s.station, 'Halt'), min: i ? minutes(s.min) : 0 })), service };
      }
      case 'removeLine':
        return { kind: 'removeLine', line: str(e.line, 'Linie') };
    }
    throw new GameError('Unbekannte Art von Änderung.');
  });
}

function sanitizePlan(p: Record<string, unknown>): NetworkPlan {
  const id = String(p.id ?? '');
  if (!/^[a-z0-9-]{1,24}$/.test(id)) throw new GameError('Kennung: 1–24 Kleinbuchstaben, Ziffern oder „-“.');
  return {
    id,
    label: str(p.label ?? (id === 'regular' ? 'Regulär' : id), 'Name', 24),
    hint: String(p.hint ?? '')
      .replace(/[\u0000-\u001f<>]/g, '')
      .trim()
      .slice(0, 200),
    inMenu: id !== 'regular' && p.inMenu === true,
    params: sanitizeParams(p.params),
    edits: sanitizeEdits(p.edits),
    ...(p.updatedAt ? { updatedAt: Number(p.updatedAt) } : {}),
    ...(p.updatedBy ? { updatedBy: String(p.updatedBy).slice(0, 40) } : {}),
  };
}

const REGULAR = (): NetworkPlan => ({ id: 'regular', label: 'Regulär', hint: '', inMenu: false, params: {}, edits: [] });

export function sanitizePlans(input: unknown): NetworkPlan[] {
  const list = Array.isArray((input as { plans?: unknown })?.plans) ? ((input as { plans: Record<string, unknown>[] }).plans) : [];
  if (list.length > 20) throw new GameError('Höchstens 20 Netzpläne.');
  const out = list.map(sanitizePlan);
  if (new Set(out.map((p) => p.id)).size !== out.length) throw new GameError('Jede Kennung nur einmal.');
  if (!out.some((p) => p.id === 'regular')) out.unshift(REGULAR());
  return out.sort((a, b) => Number(b.id === 'regular') - Number(a.id === 'regular'));
}

// ---------------------------------------------------------------- Speicher

export class PlanStore {
  private store: VersionedJson<{ plans: NetworkPlan[] }>;

  constructor() {
    this.store = new VersionedJson('plans', (v) => ({ plans: sanitizePlans(v) }), () => ({ plans: [migrated()] }));
  }

  list(): NetworkPlan[] {
    return this.store.get().plans;
  }

  get(id: string): NetworkPlan | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  params(id: string): RoutingParams {
    return { ...DEFAULT_PARAMS, ...(this.get(id)?.params ?? {}) };
  }

  /** Netzpläne, die in der Lobby wählbar sind */
  menu(): MenuPlan[] {
    return this.list()
      .filter((p) => p.inMenu)
      .map((p) => ({ id: `plan:${p.id}` as const, label: p.label, hint: p.hint }));
  }

  save(plans: NetworkPlan[], by: string, note: string): NetworkPlan[] {
    return this.store.save({ plans }, by, note).plans;
  }

  versions() {
    return this.store.versions();
  }

  rollback(id: string, by: string): NetworkPlan[] {
    return this.store.rollback(id, by).plans;
  }
}

/** frühere Einstellung (routing-overrides.json, nur ein Plan) übernehmen */
function migrated(): NetworkPlan {
  const old = path.join(STATE_DIR, 'routing-overrides.json');
  try {
    if (existsSync(old)) {
      const o = JSON.parse(readFileSync(old, 'utf8')) as Record<string, unknown>;
      return { ...REGULAR(), params: sanitizeParams(o.params), edits: sanitizeEdits(o.edits) };
    }
  } catch (e) {
    console.warn(`⚠ ${old} ignoriert: ${(e as Error).message}`);
  }
  return REGULAR();
}

let instance: PlanStore | null = null;
export const planStore = (): PlanStore => (instance ??= new PlanStore());

/** Stellschrauben des Netzplans, der gerade gerechnet wird (routing.ts) */
export const paramsFor = (id: string): RoutingParams => planStore().params(id);
