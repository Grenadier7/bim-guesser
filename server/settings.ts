// Eingaben aus Requests prüfen: Routenjagd-Einstellungen (inkl. alter Formate), Teilstrecken, Koordinaten
import type { GameSettings, LatLon, UserLeg } from '../shared/types.ts';
import {
  DEFAULT_SETTINGS,
  DIFFICULTY_PRESETS,
  DISTANCES,
  FOCUS_RADII,
  cleanFocusShare,
  cleanMinTransfers,
  cleanStationKinds,
  isSlotId,
  matchPreset,
  NET_MODES,
  stationKindsFromPool,
  xtremeBlocksLocate,
} from '../shared/rules.ts';

export function sanitizeSettings(s: Partial<GameSettings> | undefined, base: GameSettings = DEFAULT_SETTINGS): GameSettings {
  const out = { ...base };
  if (!s) return out;
  if (isSlotId(s.slot)) out.slot = s.slot;
  // Netz: Regulär, Aktuell oder ein Netzplan aus dem Menü (Admin-Seite)
  if (NET_MODES.some((m) => m.id === s.network)) out.network = s.network!;
  // Schnellwahl setzt die Regler; einzelne Regler-Werte überschreiben danach
  const preset = DIFFICULTY_PRESETS.find((d) => d.id === s.difficulty);
  if (preset) Object.assign(out, { stations: [...preset.stations], distance: preset.distance, minTransfers: preset.minTransfers });
  // Haltestellen-Arten (alte Einstellung: Stufe 1–6)
  const kinds = cleanStationKinds(s.stations) ?? stationKindsFromPool((s as { stationPool?: unknown }).stationPool);
  if (kinds) out.stations = kinds;
  if (DISTANCES.some((x) => x.id === s.distance)) out.distance = s.distance!;
  // alte Einstellung "Immer mit Umstieg" (true/false) → mindestens 1 / 0 Umstiege
  const legacy = (s as { needTransfer?: unknown }).needTransfer;
  const mt = cleanMinTransfers(s.minTransfers) ?? (typeof legacy === 'boolean' ? (legacy ? 1 : 0) : null);
  if (mt !== null) out.minTransfers = mt;
  out.difficulty = matchPreset(out);
  if (s.focus === null) out.focus = null;
  else if (s.focus && typeof s.focus === 'object') {
    const lat = Number(s.focus.lat);
    const lon = Number(s.focus.lon);
    // nur Punkte in/um Wien
    if (lat > 48.0 && lat < 48.4 && lon > 16.1 && lon < 16.65) {
      const radiusM = FOCUS_RADII.includes(Number(s.focus.radiusM)) ? Number(s.focus.radiusM) : (out.focus?.radiusM ?? 2500);
      const share = cleanFocusShare(s.focus.share) ?? out.focus?.share ?? 0.5;
      out.focus = { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, radiusM, share };
    }
  }
  if (Number.isInteger(s.rounds)) out.rounds = Math.min(10, Math.max(1, s.rounds!));
  if (s.roundTimeLimitSec === null) out.roundTimeLimitSec = null;
  else if (typeof s.roundTimeLimitSec === 'number') out.roundTimeLimitSec = Math.min(600, Math.max(20, Math.round(s.roundTimeLimitSec)));
  for (const k of ['locate', 'countWait', 'avgWait'] as const) if (typeof s[k] === 'boolean') out[k] = s[k];
  // Tipps: keine / günstig / teuer (alte Einstellung true/false)
  const tl = s.tips as unknown;
  if (tl === 'off' || tl === 'cheap' || tl === 'expensive') out.tips = tl;
  else if (tl === true) out.tips = 'cheap';
  else if (tl === false) out.tips = 'off';
  if (s.goal === 'best' || s.goal === 'fastest') out.goal = s.goal;
  if (s.endpoints === 'stations' || s.endpoints === 'addresses') out.endpoints = s.endpoints;
  // Adressen: Schwierigkeit „eigene“ (die Schnellwahl meint Haltestellen) – wer danach eine Schnellwahl antippt,
  // spielt wieder mit Haltestellen
  if (preset && s.endpoints === undefined) out.endpoints = 'stations';
  if (out.endpoints === 'addresses') out.difficulty = 'custom';
  if (s.xtreme === 'off' || s.xtreme === 'noHints' || s.xtreme === 'noNames' || s.xtreme === 'noMap') out.xtreme = s.xtreme;
  // ohne Namen / ohne Karte: "Wo liegt das?" ergibt keinen Sinn
  if (xtremeBlocksLocate(out.xtreme)) out.locate = false;
  // X-treme: Tipps nur teuer (oder gar keine)
  if (out.xtreme !== 'off' && out.tips === 'cheap') out.tips = 'expensive';
  // Einschränkungs-Runden: nie / manchmal / immer (alte Einstellung war true/false)
  const r = s.restrictions as unknown;
  if (r === 'never' || r === 'sometimes' || r === 'always') out.restrictions = r;
  else if (r === true) out.restrictions = 'sometimes';
  else if (r === false) out.restrictions = 'never';
  return out;
}

/** Teilstrecken aus dem Request: nur Objekte mit kurzen String-Feldern */
export function cleanLegs(v: unknown): UserLeg[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 10)
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
    .map((l) => ({ line: String(l.line ?? '').slice(0, 12), from: String(l.from ?? '').slice(0, 12), to: String(l.to ?? '').slice(0, 12) }));
}

/** Koordinaten-Tipp aus dem Request: [lat, lon] oder null */
export function validLatLon(v: unknown): LatLon | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v.map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? [a, b] : null;
}
