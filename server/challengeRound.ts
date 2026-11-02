// Tages-Challenges am Server: Regeln ans Netz anbinden, Verbindungen gegen die Regeln prüfen, Umland-Einstiege,
// Auswahl-Kriterien je Challenge (z.B. Busfahrer: die besten Verbindungen sind Bus-Verbindungen).
import type { NetMode, RouteOption, Station } from '../shared/types.ts';
import { INNER_DISTRICTS, legProblem, routeProblem, undergroundStop, type LegLike, type RuleNet, type RuleRound } from '../shared/challengeRules.ts';
import { linePatterns } from '../shared/rules.ts';
import { distM } from '../shared/geo.ts';
import type { Network } from './network.ts';

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

// ---------------------------------------------------------------- Umland

/**
 * Aus dem Umland: Stadt in Niederösterreich → Linie(n) und erste Station in Wien. Das Netz endet an der Stadtgrenze –
 * gestartet wird dort, die erste Fahrt ist der Zug, in dem man sitzt (umsteigen in NÖ geht so gar nicht).
 */
export const UMLAND: { town: string; entry: string; lines: string[] }[] = [
  { town: 'Gänserndorf', entry: 'Süßenbrunn', lines: ['S1'] },
  { town: 'Mistelbach', entry: 'Leopoldau', lines: ['S2'] },
  { town: 'Wolkersdorf', entry: 'Leopoldau', lines: ['S2'] },
  { town: 'Korneuburg', entry: 'Strebersdorf', lines: ['S3'] },
  { town: 'Absdorf-Hippersdorf', entry: 'Strebersdorf', lines: ['S4'] },
  { town: 'Absdorf-Hippersdorf', entry: 'Nußdorf', lines: ['S40'] },
  { town: 'Tulln', entry: 'Nußdorf', lines: ['S40'] },
  { town: 'St. Pölten', entry: 'Weidlingau Bahnhof', lines: ['S50'] },
  { town: 'Wiener Neustadt', entry: 'Liesing', lines: ['S1', 'S3', 'S4'] },
  { town: 'Wiener Neustadt', entry: 'Blumental', lines: ['S60'] },
  { town: 'Bruck an der Leitha', entry: 'Grillgasse', lines: ['S60'] },
  { town: 'Baden', entry: 'Liesing', lines: ['S1'] },
  { town: 'Marchegg', entry: 'Aspern Nord', lines: ['S80'] },
];

/** Einstieg finden: Station dieses Namens, an der eine der Linien hält */
export function umlandEntry(net: Network, e: (typeof UMLAND)[number]): Station | null {
  return [...net.stations.values()].find((s) => s.name === e.entry && e.lines.some((l) => s.lines.includes(l))) ?? null;
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
    case 'sunny': {
      // sonst wäre es keine Herausforderung: die schnellste Verbindung führt unter die Erde
      const legs = rides(best);
      return legs.some((l) => l.line && l.fromStation && l.toStation && l.line.split('/').some((id) => undergroundStop(rn, { line: id, from: l.fromStation!, to: l.toStation! })));
    }
    case 'mustLine':
    case 'anyLine':
      return ok[0].medianMin <= best.medianMin + 12;
    default:
      return true;
  }
}

/**
 * Pflicht-Linien wählen: Linien aus anderen guten Verbindungen, die die schnellste nicht nimmt – sie „stören“.
 * `mustLine`: eine, `anyLine`: drei mit ähnlich guten Verbindungen (die Wahl soll nicht leicht fallen).
 */
export function pickRequired(kind: 'mustLine' | 'anyLine', routes: RouteOption[]): string[] {
  const valid = routes.filter((r) => r.key !== 'walk');
  if (valid.length < 2) return [];
  const bestLines = new Set(linesOf(valid[0]));
  const bestMin = valid[0].medianMin;
  // Kandidat: Linie → beste Zeit einer Verbindung mit ihr
  const cand = new Map<string, number>();
  for (const r of valid.slice(1)) for (const id of linesOf(r)) if (!bestLines.has(id) && !cand.has(id)) cand.set(id, r.medianMin);
  const list = [...cand].filter(([, m]) => m <= bestMin + 12).sort((a, b) => a[1] - b[1]);
  if (kind === 'mustLine') return list.length ? [list[Math.floor(Math.random() * Math.min(3, list.length))][0]] : [];
  if (list.length < 3) return [];
  // drei mit ähnlichen Zeiten (höchstens 5 min Unterschied)
  for (let i = 0; i + 2 < list.length; i++) if (list[i + 2][1] - list[i][1] <= 5) return list.slice(i, i + 3).map(([id]) => id);
  return [];
}
