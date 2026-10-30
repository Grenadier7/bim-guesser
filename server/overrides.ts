// Stellschrauben der Routenberechnung, im Betrieb über die Admin-Seite änderbar (gespeichert in STATE_DIR):
//  - Parameter: Umsteigezeit, Fußwege, höchstens so viele Fahrten, Anteil der ersten Wartezeit
//  - Linien-Änderungen im Referenzfahrplan: verlängern (S40 wieder ab Franz-Josefs-Bahnhof), kürzen (S40 erst ab
//    Heiligenstadt), Fahrzeit zwischen zwei Halten
// Angewendet werden sie in timetable.ts (Fahrten) und network.ts (Haltefolgen für den Routen-Baukasten).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LineEdit, RoutingOverrides, RoutingParams } from '../shared/types.ts';
import { GameError } from './lobby.ts';
import { STATE_DIR } from './paths.ts';

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

const FILE = () => process.env.ROUTING_OVERRIDES_FILE ?? path.join(STATE_DIR, 'routing-overrides.json');

/** aktuell gültige Parameter – timetable.ts und routing.ts lesen hier (ein Objekt, damit Änderungen sofort wirken) */
export const params: RoutingParams = { ...DEFAULT_PARAMS };
let current: RoutingOverrides = { params: {}, edits: [] };

function readFile(): RoutingOverrides {
  try {
    if (existsSync(FILE())) return sanitizeOverrides(JSON.parse(readFileSync(FILE(), 'utf8')));
  } catch (e) {
    console.warn(`⚠ ${FILE()} ist kaputt und wird ignoriert: ${(e as Error).message}`);
  }
  return { params: {}, edits: [] };
}

function use(o: RoutingOverrides) {
  current = o;
  Object.assign(params, DEFAULT_PARAMS, o.params);
}
use(readFile());

export function overrides(): RoutingOverrides {
  return current;
}

export function hasOverrides(): boolean {
  return current.edits.length > 0 || Object.keys(current.params).length > 0;
}

/** speichern (atomar) und sofort gültig machen */
export function saveOverrides(o: RoutingOverrides) {
  const file = FILE();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(o, null, 2));
  renameSync(`${file}.tmp`, file);
  use(o);
}

const str = (v: unknown, what: string): string => {
  const s = String(v ?? '').trim();
  if (!s || s.length > 60) throw new GameError(`${what} fehlt.`);
  return s;
};
const minutes = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 60) throw new GameError('Fahrzeit: 0–60 Minuten.');
  return Math.round(n);
};

/** Eingabe prüfen (von der Admin-Seite oder aus der Datei) – wirft GameError mit verständlicher Meldung */
export function sanitizeOverrides(input: unknown): RoutingOverrides {
  const o = (input ?? {}) as Partial<RoutingOverrides>;
  const out: RoutingOverrides = { params: {}, edits: [] };
  for (const [k, v] of Object.entries(o.params ?? {})) {
    if (!(k in DEFAULT_PARAMS) || v == null || (v as unknown) === '') continue;
    const key = k as keyof RoutingParams;
    const n = Number(v);
    const [lo, hi] = PARAM_LIMITS[key];
    if (!Number.isFinite(n) || n < lo || n > hi) throw new GameError(`${key}: erlaubt sind ${lo}–${hi}.`);
    if (n !== DEFAULT_PARAMS[key]) out.params[key] = key === 'firstWaitFactor' ? Math.round(n * 100) / 100 : Math.round(n);
  }
  if (!Array.isArray(o.edits ?? [])) throw new GameError('Linien-Änderungen: Liste erwartet.');
  if ((o.edits ?? []).length > 50) throw new GameError('Höchstens 50 Linien-Änderungen.');
  for (const e of (o.edits ?? []) as LineEdit[]) {
    const line = str(e?.line, 'Linie');
    if (e.kind === 'extend') {
      if (!Array.isArray(e.stops) || !e.stops.length || e.stops.length > 15) throw new GameError(`${line}: 1–15 neue Halte angeben.`);
      out.edits.push({ kind: 'extend', line, at: str(e.at, 'Bisherige Endstation'), stops: e.stops.map((s) => ({ station: str(s?.station, 'Halt'), min: minutes(s?.min) })) });
    } else if (e.kind === 'cut') {
      out.edits.push({ kind: 'cut', line, at: str(e.at, 'Neue Endstation'), beyond: str(e.beyond, 'Wegfallender Teil (Richtung)') });
    } else if (e.kind === 'time') {
      out.edits.push({ kind: 'time', line, from: str(e.from, 'Von'), to: str(e.to, 'Nach'), min: minutes(e.min) });
    } else throw new GameError('Unbekannte Art von Linien-Änderung.');
  }
  if (o.updatedAt) out.updatedAt = Number(o.updatedAt) || undefined;
  if (o.updatedBy) out.updatedBy = String(o.updatedBy).slice(0, 40);
  return out;
}
