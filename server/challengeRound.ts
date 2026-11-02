// Tages-Challenges am Server: Regeln ans Netz anbinden, Verbindungen gegen die Regeln prüfen, Umland-Orte,
// Auswahl-Kriterien je Challenge (z.B. Busfahrer: die besten Verbindungen sind Bus-Verbindungen) und zusätzliche
// Suchen, damit die beste erlaubte Verbindung auch wirklich gefunden wird.
import type { NetMode, Restriction, RouteLeg, RouteOption, Station, UmlandStart } from '../shared/types.ts';
import { INNER_DISTRICTS, UNDERGROUND, legProblem, routeProblem, undergroundStop, type LegLike, type RuleNet, type RuleRound } from '../shared/challengeRules.ts';
import { WELL_KNOWN_S, linePatterns } from '../shared/rules.ts';
import { distM } from '../shared/geo.ts';
import type { Network } from './network.ts';
import type { RouteQuery } from './routing.ts';

export function ruleNetOf(net: Network, mode: NetMode): RuleNet {
  const st = (id: string): Station | undefined => {
    try {
      return net.station(id);
    } catch {
      return undefined;
    }
  };
  return {
    mode: (id) => net.lines.get(id)?.mode ?? null,
    name: (id) => st(id)?.name ?? id,
    district: (id) => st(id)?.district ?? null,
    traversed: (lineId, a, b) => {
      const line = net.lines.get(lineId);
      if (!line) return [];
      for (const p of linePatterns(line, mode)) {
        const i = p.indexOf(a);
        const j = i >= 0 ? p.indexOf(b, i + 1) : -1;
        if (j > i) return p.slice(i, j + 1);
      }
      return [];
    },
  };
}

/** Fahrten einer Verbindung als Teilstrecken; bei gleichwertigen Linien („S1/S2“) die erste, die die Regeln einhält */
export function legsOf(route: RouteOption, rr: RuleRound, rn: RuleNet): LegLike[] | null {
  const out: LegLike[] = [];
  for (const l of route.legs) {
    if (l.mode === 'W') continue;
    if (!l.line || !l.fromStation || !l.toStation) return null;
    const ids = l.line.split('/').filter((id) => rn.mode(id));
    const pick = ids.find((id) => !legProblem(rr, out, { line: id, from: l.fromStation!, to: l.toStation! }, rn)) ?? ids[0];
    if (!pick) return null;
    out.push({ line: pick, from: l.fromStation, to: l.toStation });
  }
  return out;
}

/** hält die Verbindung alle Regeln ein? */
export function routeAllowed(route: RouteOption, rr: RuleRound, rn: RuleNet): boolean {
  if (route.key === 'walk') return !rr.restriction;
  const legs = legsOf(route, rr, rn);
  return !!legs && !routeProblem(rr, legs, rn);
}

/** Linien einer Verbindung (Einzel-IDs) */
export const linesOf = (r: RouteOption) => r.legs.flatMap((l) => (l.mode !== 'W' && l.line ? l.line.split('/') : []));

/** Stationen, an denen die Verbindung hält oder durchfährt */
export function stationsOf(r: RouteOption, rn: RuleNet): string[] {
  return r.legs.flatMap((l) => {
    if (l.mode === 'W' || !l.line || !l.fromStation || !l.toStation) return [];
    for (const id of l.line.split('/')) {
      const s = rn.traversed(id, l.fromStation, l.toStation);
      if (s.length) return s;
    }
    return [l.fromStation, l.toStation];
  });
}

// ---------------------------------------------------------------- Suche

/**
 * Was die Suche gleich meiden soll (sonst liefert sie oft nur Verbindungen, die die Regel brechen):
 * gesperrte Bezirke, unterirdische Abschnitte, Insider-Linien.
 */
export function avoidFor(rr: RuleRound, net: Network): Pick<RouteQuery, 'avoidStations' | 'avoidLines' | 'avoidLineStations'> {
  const blocked = rr.restriction === 'avoidInner' ? INNER_DISTRICTS : rr.restriction === 'avoidDistricts' ? (rr.districts ?? []) : [];
  if (blocked.length) return { avoidStations: [...net.stations.values()].filter((s) => blocked.includes(s.district)).map((s) => s.id) };
  if (rr.restriction === 'sunny') {
    const byName = new Map<string, string[]>();
    for (const s of net.stations.values()) byName.set(s.name, [...(byName.get(s.name) ?? []), s.id]);
    return {
      avoidLines: ['U3'],
      avoidLineStations: Object.fromEntries(Object.entries(UNDERGROUND).map(([l, names]) => [l, names.flatMap((n) => byName.get(n) ?? [])])),
    };
  }
  if (rr.restriction === 'insider') return { avoidLines: WELL_KNOWN_S };
  if (rr.restriction === 'banLines' && rr.banned?.length) return { avoidLines: rr.banned };
  return {};
}

/**
 * Zusätzliche Suchen je Regel: Die Suche liefert je Umstiegszahl nur die schnellste Verbindung – für „mind. eine
 * S-Bahn“ ist die oft nicht dabei (Speising → Heiligenstadt: S80 → Hütteldorf → S45 findet erst die Suche nur mit
 * S-Bahn). Deshalb auch mit eingeschränkten Verkehrsmitteln suchen und alles zusammen auswerten.
 */
export function searchVariants(r: Restriction | null): Partial<RouteQuery>[] {
  switch (r) {
    case 'needS':
      return [{ onlyModes: ['S'] }, { onlyModes: ['S', 'T', 'B'] }];
    case 'needTram':
    case 'tramEnds':
    case 'twoTrams':
      return [{ onlyModes: ['T'] }, { onlyModes: ['S', 'T', 'B'] }];
    case 'needBus':
      return [{ onlyModes: ['S', 'T', 'B'] }, { onlyModes: ['T', 'B'] }];
    case 'mixModes':
    case 'noSameMode':
    case 'maxOneU':
    case 'min2Transfers':
    case 'mustLine':
    case 'anyLine':
      return [{ onlyModes: ['S', 'T', 'B'] }, { onlyModes: ['U', 'S', 'T'] }];
    case 'sunny':
    case 'avoidInner':
    case 'avoidDistricts':
      return [{ onlyModes: ['S', 'T', 'B'] }];
    default:
      return [];
  }
}

/** Verbindungen mehrerer Suchen zusammenführen (gleiche Verbindung nur einmal) */
export function mergeRoutes(lists: RouteOption[][]): RouteOption[] {
  const seen = new Map<string, RouteOption>();
  for (const r of lists.flat()) {
    const old = seen.get(r.key);
    if (!old || r.medianMin < old.medianMin) seen.set(r.key, r);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- Umland

/**
 * Aus dem Umland: Orte in Niederösterreich und die Züge von dort nach Wien – Linie(n), erste Station in Wien und die
 * Fahrzeit bis dorthin (ca., der eigene Fahrplan endet an der Stadtgrenze). Manche Orte haben zwei Züge zur Wahl.
 */
export const UMLAND: { town: string; lat: number; lon: number; options: { lines: string[]; entry: string; min: number }[] }[] = [
  { town: 'Gänserndorf', lat: 48.3407, lon: 16.7189, options: [{ lines: ['S1'], entry: 'Süßenbrunn', min: 17 }] },
  { town: 'Wolkersdorf', lat: 48.379, lon: 16.5164, options: [{ lines: ['S2'], entry: 'Leopoldau', min: 14 }] },
  { town: 'Mistelbach', lat: 48.5664, lon: 16.5684, options: [{ lines: ['S2'], entry: 'Leopoldau', min: 38 }] },
  { town: 'Korneuburg', lat: 48.3443, lon: 16.3326, options: [{ lines: ['S3'], entry: 'Strebersdorf', min: 6 }] },
  { town: 'Stockerau', lat: 48.3866, lon: 16.2148, options: [{ lines: ['S3'], entry: 'Strebersdorf', min: 15 }] },
  {
    town: 'Absdorf-Hippersdorf',
    lat: 48.4011,
    lon: 15.9719,
    options: [
      { lines: ['S4'], entry: 'Strebersdorf', min: 33 },
      { lines: ['S40'], entry: 'Nußdorf', min: 35 },
    ],
  },
  { town: 'Tulln', lat: 48.3302, lon: 16.0565, options: [{ lines: ['S40'], entry: 'Nußdorf', min: 24 }] },
  { town: 'Neulengbach', lat: 48.1958, lon: 15.905, options: [{ lines: ['S50'], entry: 'Weidlingau Bahnhof', min: 30 }] },
  {
    town: 'Wiener Neustadt',
    lat: 47.8115,
    lon: 16.234,
    options: [
      { lines: ['S1', 'S3', 'S4'], entry: 'Liesing', min: 36 },
      { lines: ['S60'], entry: 'Blumental', min: 38 },
    ],
  },
  { town: 'Mödling', lat: 48.086, lon: 16.2935, options: [{ lines: ['S1', 'S2', 'S3', 'S4'], entry: 'Liesing', min: 6 }] },
  { town: 'Baden', lat: 48.006, lon: 16.2363, options: [{ lines: ['S1'], entry: 'Liesing', min: 16 }] },
  { town: 'Bruck an der Leitha', lat: 48.026, lon: 16.7787, options: [{ lines: ['S60'], entry: 'Grillgasse', min: 33 }] },
  { town: 'Marchegg', lat: 48.2795, lon: 16.9062, options: [{ lines: ['S80'], entry: 'Aspern Nord', min: 24 }] },
];

/** Ort mit den Einstiegs-Stationen im Netz (Station dieses Namens, an der eine der Linien hält) */
export function umlandStart(net: Network, u: (typeof UMLAND)[number]): UmlandStart | null {
  const options = u.options.flatMap((o) => {
    const st = [...net.stations.values()].find((s) => s.name === o.entry && o.lines.some((l) => s.lines.includes(l)));
    const lines = o.lines.filter((l) => st?.lines.includes(l));
    return st && lines.length ? [{ lines, entry: st.id, min: o.min }] : [];
  });
  return options.length ? { town: u.town, lat: u.lat, lon: u.lon, options } : null;
}

/** Zugfahrt vom Ort bis zur Stadtgrenze vor eine Verbindung setzen (fährt sie mit demselben Zug weiter: verlängern) */
export function withTrain(r: RouteOption, um: UmlandStart, opt: UmlandStart['options'][number], net: Network): RouteOption {
  const entry = net.station(opt.entry);
  const first = r.legs[0];
  const sameTrain = first && first.mode !== 'W' && first.fromStation === opt.entry && first.line?.split('/').some((l) => opt.lines.includes(l));
  const train: RouteLeg = {
    mode: 'S',
    line: opt.lines.join('/'),
    color: net.lines.get(opt.lines[0])?.color ?? '#1a6fb5',
    fromName: um.town,
    toName: entry.name,
    fromStation: null,
    toStation: entry.id,
    dep: '',
    arr: first?.dep ?? '',
    path: [
      [um.lat, um.lon],
      [entry.lat, entry.lon],
    ],
  };
  const legs = sameTrain ? [{ ...first, fromName: um.town, path: [[um.lat, um.lon] as [number, number], ...first.path] }, ...r.legs.slice(1)] : [train, ...r.legs];
  const m = opt.min;
  return { ...r, key: `umland:${opt.entry}:${r.key}`, legs, medianMin: r.medianMin + m, minMin: r.minMin + m, maxMin: r.maxMin + m, rideMin: r.rideMin + m, steps: undefined };
}

// ---------------------------------------------------------------- Fleckerlteppich

/**
 * Gesperrte Bezirke ziehen: 2–3, durch die die guten Verbindungen fahren (mind. einer der besten), dazu 1–2 andere –
 * nie der Bezirk von Start oder Ziel. null = Strecke führt durch keinen fremden Bezirk.
 */
export function pickDistricts(routes: RouteOption[], a: Station, b: Station, rn: RuleNet): number[] | null {
  const valid = routes.filter((r) => r.key !== 'walk');
  if (!valid.length) return null;
  const own = new Set([a.district, b.district]);
  const districtsOf = (r: RouteOption) => new Set(stationsOf(r, rn).map((id) => rn.district(id) ?? 0).filter((d) => d && !own.has(d)));
  const onBest = [...districtsOf(valid[0])];
  if (!onBest.length) return null;
  const shuffle = <T>(l: T[]) => l.map((x) => ({ x, k: Math.random() })).sort((p, q) => p.k - q.k).map((p) => p.x);
  const picked = new Set<number>([shuffle(onBest)[0]]);
  for (const d of shuffle([...new Set(valid.slice(1, 4).flatMap((r) => [...districtsOf(r)]))])) if (picked.size < 2 + Math.round(Math.random())) picked.add(d);
  const others = shuffle(Array.from({ length: 23 }, (_, i) => i + 1).filter((d) => !own.has(d) && !picked.has(d)));
  for (const d of others.slice(0, 1 + Math.round(Math.random()))) picked.add(d);
  return [...picked].sort((x, y) => x - y);
}

// ---------------------------------------------------------------- Kriterien je Challenge

const STEPHANSPLATZ = { lat: 48.2085, lon: 16.3731 };

/** kürzester Abstand eines Punkts zur Strecke a–b (Meter, flach gerechnet) */
function distToSegment(p: { lat: number; lon: number }, a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = Math.cos((48.2 * Math.PI) / 180);
  const [px, py, ax, ay, bx, by] = [p.lon * k, p.lat, a.lon * k, a.lat, b.lon * k, b.lat];
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return distM(p, { lat: ay + t * dy, lon: (ax + t * dx) / k });
}

/** Innenstadt umfahren: Start und Ziel außerhalb, die Luftlinie führt mitten hindurch */
export function crossesCenter(a: Station, b: Station): boolean {
  return !INNER_DISTRICTS.includes(a.district) && !INNER_DISTRICTS.includes(b.district) && distToSegment(STEPHANSPLATZ, a, b) < 2200;
}

/**
 * Passt das Paar zur Challenge? `all` = alle Verbindungen (ohne Regel), `ok` = die, die die Regeln einhalten.
 * `strict` = false nach vielen Versuchen (dann reicht, dass es eine erlaubte Verbindung gibt).
 */
export function pairFits(rr: RuleRound, all: RouteOption[], ok: RouteOption[], rn: RuleNet, a: Station, b: Station, strict: boolean): boolean {
  if (!ok.length || ok[0].key === 'walk') return false;
  if (!strict) return true;
  const best = all[0];
  const rides = (r: RouteOption) => r.legs.filter((l) => l.mode !== 'W');
  switch (rr.restriction) {
    case 'needBus': {
      // Busfahrer: die besten Verbindungen sind Bus-Verbindungen (nicht nur irgendwo ein kurzer Bus)
      const top = all.filter((r) => r.key !== 'walk').slice(0, 3);
      const busy = (r: RouteOption) => rides(r).filter((l) => l.mode === 'B' || l.mode === 'N').length * 2 >= rides(r).length;
      return top.length > 0 && top.every((r) => rides(r).some((l) => l.mode === 'B' || l.mode === 'N')) && busy(best);
    }
    case 'mixModes':
      // nicht billig ohne drei Verkehrsmittel: die gemischte Verbindung ist fast so schnell wie die beste
      return ok[0].medianMin <= best.medianMin + 4;
    case 'busOnly': {
      // kurz und mit 1–2 Umstiegen zu schaffen
      const n = rides(ok[0]).length;
      return n >= 2 && n <= 3 && ok[0].medianMin <= 35;
    }
    case 'oneLeg':
      // Fußbus: keine Linie fährt direkt – man muss hin- oder weggehen
      return !a.lines.some((l) => b.lines.includes(l)) && ok[0].legs.some((l) => l.mode === 'W');
    case 'avoidInner':
      return crossesCenter(a, b) && !routeAllowed(best, rr, rn);
    case 'avoidDistricts':
      // die Sperre kostet etwas, aber nicht die halbe Stadt
      return !routeAllowed(best, rr, rn) && ok[0].medianMin <= best.medianMin + 15;
    case 'sunny': {
      // sonst wäre es keine Herausforderung: die schnellste Verbindung führt unter die Erde
      const legs = rides(best);
      return legs.some((l) => l.line && l.fromStation && l.toStation && l.line.split('/').some((id) => undergroundStop(rn, { line: id, from: l.fromStation!, to: l.toStation! })));
    }
    case 'mustLine':
      return ok[0].medianMin <= best.medianMin + 12;
    case 'anyLine': {
      // die beste erlaubte Verbindung nimmt genau eine der drei – nie zwei (sonst wäre es keine Entscheidung)
      const req = new Set(rr.required ?? []);
      return ok[0].medianMin <= best.medianMin + 12 && new Set(linesOf(ok[0]).filter((l) => req.has(l))).size === 1;
    }
    default:
      return true;
  }
}

/**
 * Pflicht-Linien wählen: Linien aus anderen Verbindungen, die die schnellste nicht nimmt – sie „stören“.
 * `mustLine`: eine. `anyLine`: drei lästige (jede kostet Umweg, Bim/Bus/S-Bahn vor U-Bahn) mit ähnlichen Zeiten,
 * und keine Verbindung mit zweien davon ist die beste – man muss sich für eine entscheiden.
 */
export function pickRequired(kind: 'mustLine' | 'anyLine', routes: RouteOption[], mode: (id: string) => string | null): string[] {
  const valid = routes.filter((r) => r.key !== 'walk');
  if (valid.length < 2) return [];
  const bestLines = new Set(linesOf(valid[0]));
  const bestMin = valid[0].medianMin;
  // Kandidat: Linie → beste Zeit einer Verbindung mit ihr
  const cand = new Map<string, number>();
  for (const r of valid.slice(1)) for (const id of linesOf(r)) if (!bestLines.has(id) && !cand.has(id)) cand.set(id, r.medianMin);
  if (kind === 'mustLine') {
    const list = [...cand].filter(([, m]) => m <= bestMin + 12).sort((a, b) => a[1] - b[1]);
    return list.length ? [list[Math.floor(Math.random() * Math.min(3, list.length))][0]] : [];
  }
  // lästig: mindestens 2 min Umweg, höchstens 15; U-Bahn nur, wenn es sonst nicht reicht
  const annoying = [...cand].filter(([, m]) => m >= bestMin + 2 && m <= bestMin + 15).sort((a, b) => a[1] - b[1]);
  const pool = annoying.filter(([id]) => mode(id) !== 'U').length >= 3 ? annoying.filter(([id]) => mode(id) !== 'U') : annoying;
  for (let i = 0; i + 2 < pool.length; i++)
    for (let j = i + 1; j + 1 < pool.length; j++)
      for (let k = j + 1; k < pool.length; k++) {
        const three = [pool[i], pool[j], pool[k]];
        if (three[2][1] - three[0][1] > 6) continue;
        const ids = new Set(three.map(([id]) => id));
        // die schnellste Verbindung mit einer der drei darf nicht zwei davon nehmen
        const first = valid.find((r) => linesOf(r).some((l) => ids.has(l)));
        if (first && new Set(linesOf(first).filter((l) => ids.has(l))).size === 1) return [...ids];
      }
  return [];
}
