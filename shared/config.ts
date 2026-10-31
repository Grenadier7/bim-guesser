// ================================================================
//  Spiel-Konfiguration der Admin-Seite
//
//  Standardwerte bleiben im Code (shared/rules.ts, shared/defaults.ts, shared/pools.ts) – typgeprüft, getestet und
//  mit jedem Update aktuell. Die Admin-Seite speichert nur Abweichungen davon (STATE_DIR/config/game.json, mit
//  Versionen zum Zurückrollen). applyGameConfig überträgt die gültige Konfiguration auf genau diese Konstanten –
//  auf dem Server beim Start und nach jeder Änderung, im Browser nach dem Laden von /api/config. So lesen alle
//  bisherigen Stellen im Code automatisch die eingestellten Werte.
// ================================================================
import { DEFAULT_QUIZ_SETTINGS, DEFAULT_SETTINGS, DEFAULT_TRAINING } from './defaults.ts';
import { POOL_OVERRIDES } from './pools.ts';
import type { QuizSettings } from './quiz.ts';
import {
  AVOID_TRANSFERS,
  DIFFICULTY_PRESETS,
  DISTANCES,
  NET_MODES,
  SCORING_MODES,
  SLOT_DAYTYPE,
  SLOT_TIME,
  slotOr,
  STATION_KINDS,
  TIME_SLOTS,
  TIPS,
  TIP_LEVELS,
  TRANSFER_PENALTY,
  type ScoringMode,
} from './rules.ts';
import type { DayType, DistanceRange, GameSettings, NetMode, StationKind, TipKind, TipLevel } from './types.ts';

export type PresetId = 'easy' | 'medium' | 'hard' | 'expert';

export interface GameConfig {
  /** Uhrzeiten der Routenjagd (1–8, Reihenfolge = Reihenfolge der Knöpfe; Tag/Uhrzeit/Texte frei) */
  slots: Record<string, { short: string; label: string; day: DayType; time: string }>;
  /** Netz-Auswahl: Texte für „Regulär“ und „Aktuell“, „Aktuell“ abschaltbar */
  netModes: { regular: { label: string; hint: string }; current: { label: string; hint: string; enabled: boolean } };
  /** „Was zählt?“ */
  scoring: {
    modes: Record<ScoringMode, { icon: string; label: string; hint: string; unit: string; enabled: boolean }>;
    /** Aufschlag je Umstieg bei „Umstiege vermeiden“ (min) */
    transferPenalty: number;
    /** „Umstiege vermeiden“: Name, Erklärung, wählbar */
    avoid: { label: string; hint: string; enabled: boolean };
  };
  /** Joker: Name und Abzug (Anteil der Routenpunkte); Stufen günstig/teuer als Zu-/Abschlag */
  tips: { kinds: Record<TipKind, { label: string; share: number }>; levels: Record<Exclude<TipLevel, 'off'>, number> };
  /** Schwierigkeit: Schnellwahlen und Punkte-Faktoren */
  difficulty: {
    presets: Record<PresetId, { label: string; stations: StationKind[]; distance: DistanceRange; minTransfers: 0 | 1 | 2 }>;
    stationFactors: Record<StationKind, number>;
    distanceFactors: Record<DistanceRange, number>;
  };
  /** Standard-Einstellungen neuer Lobbys bzw. des Trainings */
  defaults: { route: GameSettings; quiz: QuizSettings; training: typeof DEFAULT_TRAINING };
  /** einzelne Stationen je Haltestellen-Art zusätzlich/ausgenommen (Station-IDs) */
  pools: { add: Partial<Record<StationKind, string[]>>; remove: Partial<Record<StationKind, string[]>> };
  /** Adressen als Start/Ziel: ausgenommene (IDs „a:…“) und eigene */
  addresses: { removed: string[]; added: { name: string; lat: number; lon: number; district: number }[] };
  /** Chat-Moderation: gesperrte Wörter (auch für Spielernamen) */
  chat: { words: string[] };
  /** Hinweis oben für alle (leer = keiner) */
  announcement: { text: string };
}

export type GameConfigSection = keyof GameConfig;

/** Netzplan im Menü (kommt aus den Netzplänen, nicht aus der Spiel-Konfiguration) */
export interface MenuPlan {
  id: NetMode;
  label: string;
  hint: string;
}

/** Was der Browser bekommt: Spiel-Konfiguration ohne Interna (Chat-Wörter bleiben am Server) */
export type PublicConfig = Omit<GameConfig, 'chat' | 'addresses'> & { plans: MenuPlan[] };

/** Standard-Wörter der Chat-Moderation – bewusst kurz; die Admin-Seite ergänzt */
export const DEFAULT_BAD_WORDS = [
  'arschloch',
  'wichser',
  'hurensohn',
  'fotze',
  'missgeburt',
  'spast',
  'schlampe',
  'hure',
  'nazi',
  'heil hitler',
  'sieg heil',
  'neger',
  'kanake',
  'schwuchtel',
  'behindert',
  'fick',
  'fuck',
  'bitch',
  'cunt',
  'nigger',
  'faggot',
  'retard',
];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const hhmm = ([h, m]: [number, number]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** Standardwerte – einmal beim Laden aus den Konstanten gelesen, bevor irgendetwas überschrieben wird */
const DEFAULTS: GameConfig = clone({
  slots: Object.fromEntries(TIME_SLOTS.map((t) => [t.id, { short: t.short, label: t.label, day: SLOT_DAYTYPE[t.id], time: hhmm(SLOT_TIME[t.id]) }])) as GameConfig['slots'],
  netModes: {
    regular: { label: NET_MODES[0].label, hint: NET_MODES[0].hint },
    current: { label: NET_MODES[1].label, hint: NET_MODES[1].hint, enabled: true },
  },
  scoring: {
    modes: Object.fromEntries(SCORING_MODES.map((m) => [m.id, { icon: m.icon, label: m.label, hint: m.hint, unit: m.unit, enabled: true }])) as GameConfig['scoring']['modes'],
    transferPenalty: TRANSFER_PENALTY.avg,
    avoid: { ...AVOID_TRANSFERS },
  },
  tips: {
    kinds: Object.fromEntries(Object.values(TIPS).map((t) => [t.kind, { label: t.label, share: t.share }])) as GameConfig['tips']['kinds'],
    levels: { cheap: TIP_LEVELS.find((l) => l.id === 'cheap')!.delta, expensive: TIP_LEVELS.find((l) => l.id === 'expensive')!.delta },
  },
  difficulty: {
    presets: Object.fromEntries(DIFFICULTY_PRESETS.map((p) => [p.id, { label: p.label, stations: p.stations, distance: p.distance, minTransfers: p.minTransfers }])) as GameConfig['difficulty']['presets'],
    stationFactors: Object.fromEntries(STATION_KINDS.map((k) => [k.id, k.factor])) as GameConfig['difficulty']['stationFactors'],
    distanceFactors: Object.fromEntries(DISTANCES.map((d) => [d.id, d.factor])) as GameConfig['difficulty']['distanceFactors'],
  },
  defaults: { route: DEFAULT_SETTINGS, quiz: DEFAULT_QUIZ_SETTINGS, training: DEFAULT_TRAINING },
  pools: { add: {}, remove: {} },
  addresses: { removed: [], added: [] },
  chat: { words: DEFAULT_BAD_WORDS },
  announcement: { text: '' },
});

export const defaultGameConfig = (): GameConfig => clone(DEFAULTS);

// ---------------------------------------------------------------- prüfen

const KIND_IDS = STATION_KINDS.map((k) => k.id);

export class ConfigError extends Error {}

const text = (v: unknown, max: number, what: string, allowEmpty = false): string => {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim();
  if ((!s && !allowEmpty) || s.length > max) throw new ConfigError(`${what}: ${allowEmpty ? '' : '1–'}${max} Zeichen.`);
  return s;
};
const num = (v: unknown, lo: number, hi: number, what: string, step = 0.01): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new ConfigError(`${what}: erlaubt sind ${lo}–${hi}.`);
  return Math.round(n / step) * step;
};
const ids = (v: unknown, max = 2000): string[] => {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x).trim()).filter((x) => /^[\w:.-]{1,40}$/.test(x)))].slice(0, max);
};

/**
 * Einen Abschnitt prüfen und vollständig machen (fehlende Werte = Standard). Wirft ConfigError mit einer Meldung,
 * die direkt auf der Admin-Seite angezeigt werden kann. Bekannte Stationen prüft der Server zusätzlich.
 */
export function sanitizeSection<K extends GameConfigSection>(key: K, input: unknown): GameConfig[K] {
  const d = DEFAULTS[key];
  const v = (input ?? {}) as Record<string, unknown>;
  switch (key) {
    case 'slots': {
      const dd = d as GameConfig['slots'];
      const keys = input ? Object.keys(v) : Object.keys(dd);
      if (keys.length < 1 || keys.length > 8) throw new ConfigError('1 bis 8 Uhrzeiten.');
      const out: GameConfig['slots'] = {};
      for (const id of keys) {
        if (!/^[a-z0-9]{2,12}$/.test(id)) throw new ConfigError('Ungültige Uhrzeit.');
        const x = (v[id] ?? {}) as Record<string, unknown>;
        const def = dd[id] ?? { short: '', label: '', day: 'wd', time: '' };
        const t = String(x.time ?? def.time);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new ConfigError('Uhrzeit im Format HH:MM.');
        const day = x.day ?? def.day;
        if (day !== 'wd' && day !== 'sa' && day !== 'su') throw new ConfigError('Tag: Werktag, Samstag oder Sonntag.');
        out[id] = { short: text(x.short ?? def.short, 20, 'Kurzname'), label: text(x.label ?? def.label, 40, 'Name'), day, time: t };
      }
      return out as GameConfig[K];
    }
    case 'netModes': {
      const r = (v.regular ?? {}) as Record<string, unknown>;
      const c = (v.current ?? {}) as Record<string, unknown>;
      const dd = d as GameConfig['netModes'];
      return {
        regular: { label: text(r.label ?? dd.regular.label, 20, 'Name'), hint: text(r.hint ?? dd.regular.hint, 200, 'Erklärung', true) },
        current: { label: text(c.label ?? dd.current.label, 20, 'Name'), hint: text(c.hint ?? dd.current.hint, 200, 'Erklärung', true), enabled: c.enabled !== false },
      } as GameConfig[K];
    }
    case 'scoring': {
      const dd = d as GameConfig['scoring'];
      const modes = (v.modes ?? {}) as Record<string, Record<string, unknown>>;
      const av = (v.avoid ?? {}) as Record<string, unknown>;
      const out: GameConfig['scoring'] = {
        modes: clone(dd.modes),
        transferPenalty: num(v.transferPenalty ?? dd.transferPenalty, 0, 15, 'Aufschlag je Umstieg', 1),
        avoid: { label: text(av.label ?? dd.avoid.label, 30, 'Name'), hint: text(av.hint ?? dd.avoid.hint, 400, 'Erklärung', true), enabled: av.enabled !== false },
      };
      for (const id of Object.keys(dd.modes) as ScoringMode[]) {
        const m = modes[id] ?? {};
        out.modes[id] = {
          icon: text(m.icon ?? dd.modes[id].icon, 8, 'Symbol'),
          label: text(m.label ?? dd.modes[id].label, 30, 'Name'),
          hint: text(m.hint ?? dd.modes[id].hint, 400, 'Erklärung', true),
          unit: text(m.unit ?? dd.modes[id].unit, 30, 'Kurztext'),
          enabled: m.enabled !== false,
        };
      }
      if (!Object.values(out.modes).some((m) => m.enabled)) throw new ConfigError('Mindestens eine Wertung muss wählbar bleiben.');
      return out as GameConfig[K];
    }
    case 'tips': {
      const dd = d as GameConfig['tips'];
      const kinds = (v.kinds ?? {}) as Record<string, Record<string, unknown>>;
      const lv = (v.levels ?? {}) as Record<string, unknown>;
      const out: GameConfig['tips'] = {
        kinds: clone(dd.kinds),
        levels: { cheap: num(lv.cheap ?? dd.levels.cheap, -0.5, 0.5, 'Günstig'), expensive: num(lv.expensive ?? dd.levels.expensive, -0.5, 0.5, 'Teuer') },
      };
      for (const id of Object.keys(dd.kinds) as TipKind[]) {
        const k = kinds[id] ?? {};
        out.kinds[id] = { label: text(k.label ?? dd.kinds[id].label, 40, 'Name'), share: num(k.share ?? dd.kinds[id].share, 0, 0.9, 'Abzug') };
      }
      return out as GameConfig[K];
    }
    case 'difficulty': {
      const dd = d as GameConfig['difficulty'];
      const presets = (v.presets ?? {}) as Record<string, Record<string, unknown>>;
      const sf = (v.stationFactors ?? {}) as Record<string, unknown>;
      const df = (v.distanceFactors ?? {}) as Record<string, unknown>;
      const out: GameConfig['difficulty'] = { presets: clone(dd.presets), stationFactors: clone(dd.stationFactors), distanceFactors: clone(dd.distanceFactors) };
      for (const id of Object.keys(dd.presets) as PresetId[]) {
        const p = presets[id] ?? {};
        const stations = Array.isArray(p.stations) ? (p.stations.filter((x) => KIND_IDS.includes(x as StationKind)) as StationKind[]) : dd.presets[id].stations;
        if (!stations.length) throw new ConfigError(`${id}: mindestens eine Haltestellen-Art.`);
        const distance = (['short', 'medium', 'long'] as const).find((x) => x === (p.distance ?? dd.presets[id].distance));
        if (!distance) throw new ConfigError(`${id}: Entfernung ungültig.`);
        const mt = Number(p.minTransfers ?? dd.presets[id].minTransfers);
        if (mt !== 0 && mt !== 1 && mt !== 2) throw new ConfigError(`${id}: Umstiege 0, 1 oder 2.`);
        // Reihenfolge wie in der Auswahl, damit „passt zur Schnellwahl“ zuverlässig erkannt wird
        out.presets[id] = { label: text(p.label ?? dd.presets[id].label, 20, 'Name'), stations: KIND_IDS.filter((k) => stations.includes(k)), distance, minTransfers: mt };
      }
      for (const k of KIND_IDS) out.stationFactors[k] = num(sf[k] ?? dd.stationFactors[k], 0.3, 3, `Faktor ${k}`);
      for (const k of Object.keys(dd.distanceFactors) as DistanceRange[]) out.distanceFactors[k] = num(df[k] ?? dd.distanceFactors[k], 0.3, 3, `Faktor ${k}`);
      return out as GameConfig[K];
    }
    case 'defaults':
      // Lobby-Einstellungen prüft der Server mit denselben Funktionen wie bei jeder Lobby (sanitizeDefaults)
      return clone(input ?? d) as GameConfig[K];
    case 'pools': {
      const out: GameConfig['pools'] = { add: {}, remove: {} };
      for (const side of ['add', 'remove'] as const) {
        const m = (v[side] ?? {}) as Record<string, unknown>;
        for (const k of KIND_IDS) {
          const list = ids(m[k]);
          if (list.length) out[side][k] = list;
        }
      }
      return out as GameConfig[K];
    }
    case 'addresses': {
      const added = Array.isArray(v.added) ? v.added : [];
      if (added.length > 500) throw new ConfigError('Höchstens 500 eigene Adressen.');
      return {
        removed: ids(v.removed, 20000).filter((x) => /^a:\d+$/.test(x)),
        added: added.map((a: Record<string, unknown>) => {
          const lat = num(a.lat, 48.1, 48.33, 'Breite', 1e-6);
          const lon = num(a.lon, 16.18, 16.58, 'Länge', 1e-6);
          return { name: text(a.name, 60, 'Adresse'), lat, lon, district: num(a.district ?? 0, 0, 23, 'Bezirk', 1) };
        }),
      } as GameConfig[K];
    }
    case 'chat': {
      const words = Array.isArray(v.words) ? v.words : [];
      const clean = [...new Set(words.map((w) => String(w).toLowerCase().replace(/\s+/g, ' ').trim()).filter((w) => w.length >= 2 && w.length <= 40))];
      if (clean.length > 2000) throw new ConfigError('Höchstens 2000 Wörter.');
      return { words: clean } as GameConfig[K];
    }
    case 'announcement':
      return { text: text(v.text ?? '', 300, 'Hinweis', true) } as GameConfig[K];
  }
  throw new ConfigError('Unbekannter Abschnitt.');
}

// ---------------------------------------------------------------- anwenden

/** Konfiguration auf die Spiel-Konstanten übertragen (Server und Browser) */
export function applyGameConfig(c: GameConfig | PublicConfig, menu?: MenuPlan[]) {
  const plans = menu ?? ('plans' in c ? c.plans : []);
  TIME_SLOTS.length = 0;
  for (const k of Object.keys(SLOT_TIME)) (delete SLOT_TIME[k], delete SLOT_DAYTYPE[k]);
  for (const [id, s] of Object.entries(c.slots)) {
    TIME_SLOTS.push({ id, short: s.short, label: s.label });
    SLOT_DAYTYPE[id] = s.day;
    SLOT_TIME[id] = s.time.split(':').map(Number) as [number, number];
  }
  NET_MODES.length = 0;
  NET_MODES.push({ id: 'regular', ...c.netModes.regular });
  if (c.netModes.current.enabled) NET_MODES.push({ id: 'current', label: c.netModes.current.label, hint: c.netModes.current.hint });
  NET_MODES.push(...plans);
  for (const m of SCORING_MODES) Object.assign(m, c.scoring.modes[m.id]);
  TRANSFER_PENALTY.avg = c.scoring.transferPenalty;
  TRANSFER_PENALTY.fixed = c.scoring.transferPenalty * 2;
  Object.assign(AVOID_TRANSFERS, c.scoring.avoid);
  for (const t of Object.values(TIPS)) Object.assign(t, c.tips.kinds[t.kind]);
  for (const l of TIP_LEVELS) if (l.id !== 'off') l.delta = c.tips.levels[l.id];
  for (const p of DIFFICULTY_PRESETS) Object.assign(p, clone(c.difficulty.presets[p.id]));
  for (const k of STATION_KINDS) k.factor = c.difficulty.stationFactors[k.id];
  for (const x of DISTANCES) x.factor = c.difficulty.distanceFactors[x.id];
  Object.assign(DEFAULT_SETTINGS, clone(c.defaults.route));
  Object.assign(DEFAULT_QUIZ_SETTINGS, clone(c.defaults.quiz));
  Object.assign(DEFAULT_TRAINING, clone(c.defaults.training));
  // Standard-Uhrzeit entfernt → erste Uhrzeit
  DEFAULT_SETTINGS.slot = slotOr(DEFAULT_SETTINGS.slot);
  DEFAULT_TRAINING.slot = slotOr(DEFAULT_TRAINING.slot);
  POOL_OVERRIDES.add = Object.fromEntries(Object.entries(c.pools.add).map(([k, v]) => [k, new Set(v)]));
  POOL_OVERRIDES.remove = Object.fromEntries(Object.entries(c.pools.remove).map(([k, v]) => [k, new Set(v)]));
}

/** Für den Browser: ohne gesperrte Wörter und Adressliste */
export function publicConfig(c: GameConfig, plans: MenuPlan[]): PublicConfig {
  const { chat: _c, addresses: _a, ...pub } = c;
  return { ...clone(pub), plans };
}

