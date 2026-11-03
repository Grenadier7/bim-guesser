// Regeln der Tages-Challenges – für Server (Route prüfen, Strecken auswählen, beste Verbindung) und Baukasten
// (sofort korrigieren: nicht erlaubte Linien/Halte gar nicht erst anbieten, mit klarer Begründung). Eine Stelle für
// alle Meldungen, damit Spiel und Auswertung immer dasselbe sagen.
import type { Mode, Restriction } from './types.ts';
import { RESTRICTIONS, isWellKnownLine, restrictionAllowsLine } from './rules.ts';

/** innere Bezirke: 1, 4, 5, 6, 7, 8, 9 („Innenstadt umfahren“) */
export const INNER_DISTRICTS = [1, 4, 5, 6, 7, 8, 9];

/**
 * Wo Linien (grob) unter der Erde fahren – „Sonnenschein“. Ein Abschnitt, der eine dieser Stationen berührt, gilt
 * als unterirdisch. U3 fast ganz; U6 nur kurz (Längenfeldgasse/Niederhofstraße, Jägerstraße/Dresdner Straße) –
 * am Gürtel fährt sie oben; S-Bahn-Stammstrecke zwischen Praterstern und Hauptbahnhof; 18er am Hauptbahnhof und
 * 6/18 im Südgürtel-Tunnel.
 */
export const UNDERGROUND: Record<string, string[]> = {
  U1: ['Altes Landgut', 'Troststraße', 'Reumannplatz', 'Keplerplatz', 'Hauptbahnhof', 'Taubstummengasse', 'Karlsplatz', 'Stephansplatz', 'Schwedenplatz', 'Nestroyplatz', 'Praterstern', 'Vorgartenstraße'],
  U2: ['Praterstern', 'Taborstraße', 'Schottenring', 'Schottentor', 'Rathaus', 'Volkstheater', 'Museumsquartier', 'Karlsplatz'],
  U3: ['Kendlerstraße', 'Hütteldorfer Straße', 'Johnstraße', 'Schweglerstraße', 'Westbahnhof', 'Zieglergasse', 'Neubaugasse', 'Volkstheater', 'Herrengasse', 'Stephansplatz', 'Stubentor', 'Mitte-Landstraße', 'Rochusgasse', 'Kardinal-Nagl-Platz', 'Schlachthausgasse', 'Erdberg', 'Gasometer', 'Zippererstraße', 'Enkplatz', 'Simmering'],
  U4: ['Karlsplatz', 'Stadtpark', 'Mitte-Landstraße', 'Schwedenplatz', 'Schottenring', 'Roßauer Lände'],
  U6: ['Längenfeldgasse', 'Niederhofstraße', 'Jägerstraße', 'Dresdner Straße'],
  S1: ['Mitte-Landstraße', 'Rennweg', 'Quartier Belvedere'],
  S2: ['Mitte-Landstraße', 'Rennweg', 'Quartier Belvedere'],
  S3: ['Mitte-Landstraße', 'Rennweg', 'Quartier Belvedere'],
  S4: ['Mitte-Landstraße', 'Rennweg', 'Quartier Belvedere'],
  S7: ['Mitte-Landstraße', 'Rennweg'],
  '18': ['Hauptbahnhof', 'Kliebergasse', 'Matzleinsdorfer Platz', 'Eichenstraße'],
  '6': ['Matzleinsdorfer Platz', 'Eichenstraße'],
};

/** was die Regeln über das Netz wissen müssen (Server und Browser haben es unterschiedlich gespeichert) */
export interface RuleNet {
  mode(lineId: string): Mode | null;
  name(stationId: string): string;
  district(stationId: string): number | null;
  /** Stationen einer Fahrt von → bis (inkl. beider) – leer, wenn die Linie so nicht fährt */
  traversed(lineId: string, from: string, to: string): string[];
  /** Brücken, über die diese Fahrt führt (Brückenkenner; ohne Brücken-Daten leer) */
  bridges?(lineId: string, from: string, to: string): string[];
}

/** Regeln einer Runde */
export interface RuleRound {
  restriction: Restriction | null;
  /** gesperrte Linien („Linie gesperrt“) */
  banned?: string[];
  /** Pflicht-Linien: eine davon (bei „mustLine“ genau eine angegeben) muss vorkommen */
  required?: string[];
  /** Umland: erste Fahrt mit einer dieser Linien ab der Start-Station */
  entryLines?: string[];
  /** Umland: Name der Stadt (für die Meldung) */
  entryTown?: string;
  /** Fleckerlteppich: gesperrte Bezirke */
  districts?: number[];
  /** Brückenkenner: so viele Brücken mindestens */
  bridges?: number;
}

/** verschiedene Brücken einer Route */
export function bridgeCount(legs: LegLike[], net: RuleNet): number {
  return new Set(legs.flatMap((l) => net.bridges?.(l.line, l.from, l.to) ?? [])).size;
}

/** gesperrte Bezirke der Runde (Innenstadt umfahren: 1, 4–9; Fleckerlteppich: die gezogenen) */
export function blockedDistricts(round: RuleRound): number[] {
  if (round.restriction === 'avoidInner') return INNER_DISTRICTS;
  if (round.restriction === 'avoidDistricts') return round.districts ?? [];
  return [];
}

/** Meldung für eine Station in einem gesperrten Bezirk */
function districtText(round: RuleRound, name: string, d: number): string {
  return round.restriction === 'avoidInner'
    ? `🚫 ${name} liegt im ${d}. Bezirk – die inneren Bezirke (1, 4–9) sind tabu.`
    : `🧩 ${name} liegt im ${d}. Bezirk – der ist heute gesperrt (rot auf der Karte).`;
}

export interface LegLike {
  line: string;
  from: string;
  to: string;
}

const MODE_WORD: Record<Mode, string> = { U: 'U-Bahn', S: 'S-Bahn', T: 'Bim', B: 'Bus', N: 'Nachtbus', W: 'Fußweg', H: 'Hubschrauber' };
const sameMode = (a: Mode | null, b: Mode | null) => !!a && !!b && (a === b || (a !== 'W' && b !== 'W' && [a, b].every((m) => m === 'B' || m === 'N')));

/** liegt eine Fahrt (teilweise) unter der Erde? → die betroffene Station */
export function undergroundStop(net: RuleNet, leg: LegLike): string | null {
  const under = UNDERGROUND[leg.line];
  if (!under) return null;
  const hit = net.traversed(leg.line, leg.from, leg.to).find((id) => under.includes(net.name(id)));
  return hit ? net.name(hit) : null;
}

/** fährt die Linie (fast) nur unter der Erde? (U3) – dann gar nicht erst anbieten */
const allUnderground = (lineId: string) => lineId === 'U3';

/**
 * Darf diese Linie als nächste Fahrt gewählt werden (nach `prev`)? Meldung, warum nicht – null = ok.
 * Prüft nur, was schon an der Linie hängt; Halte prüft legProblem.
 */
export function lineProblem(round: RuleRound, prev: LegLike[], lineId: string, net: RuleNet): string | null {
  const r = round.restriction;
  const mode = net.mode(lineId);
  if (!mode) return `Linie ${lineId} gibt es nicht.`;
  if (r === 'busOnly' && mode !== 'B' && mode !== 'N') return `🚌 Busreise: nur Busse – ${lineId} ist ${MODE_WORD[mode]}.`;
  if (r === 'noRail' && (mode === 'U' || mode === 'S')) return `🚋 Ohne U- und S-Bahn: nur Bim und Bus – ${lineId} ist ${MODE_WORD[mode]}.`;
  if (r && !restrictionAllowsLine(r, round.banned ?? [], { id: lineId, mode })) {
    if (r === 'insider') return `🕵️ ${lineId} ist für Insider tabu – keine U-Bahn und keine bekannte S-Bahn (S1–S4, S7, S45, S80).`;
    if (r === 'banLines') return `⛔ ${lineId} ist in dieser Runde gesperrt.`;
    return `${RESTRICTIONS[r].icon} ${lineId} geht hier nicht: ${RESTRICTIONS[r].hint}`;
  }
  const last = prev.at(-1);
  if (r === 'oneLeg' && prev.length) return '🚶 Fußbus: nur eine Linie – den Rest gehst du zu Fuß.';
  if (r === 'tramEnds' && !prev.length && mode !== 'T') return `🦘 Bim-Hüpfer: Die erste Fahrt muss mit der Bim sein – ${lineId} ist ${MODE_WORD[mode]}.`;
  if (r === 'umland' && !prev.length && !(round.entryLines ?? []).includes(lineId))
    return `🚆 Von ${round.entryTown ?? 'dort'} fährt die ${lineId} nicht nach Wien – welcher Zug bringt dich hin?`;
  if (r === 'maxOneU' && mode === 'U' && prev.some((l) => net.mode(l.line) === 'U')) return '☝️ Eine U reicht: Du bist schon mit der U-Bahn gefahren.';
  if (r === 'noSameMode' && last && sameMode(net.mode(last.line), mode)) return `🔁 Nie zweimal dasselbe: nach ${MODE_WORD[net.mode(last.line)!]} nicht wieder ${MODE_WORD[mode]}.`;
  if (r === 'sunny' && allUnderground(lineId)) return `☀️ Sonnenschein: Die ${lineId} fährt fast nur unter der Erde.`;
  return null;
}

/** Einstieg an dieser Station mit dieser Linie möglich? (Innenstadt umfahren, Sonnenschein) */
export function stationProblem(round: RuleRound, lineId: string, stationId: string, net: RuleNet): string | null {
  const d = net.district(stationId) ?? 0;
  if (blockedDistricts(round).includes(d)) return districtText(round, net.name(stationId), d);
  if (round.restriction === 'sunny' && UNDERGROUND[lineId]?.includes(net.name(stationId))) return `☁️ Die ${lineId} hält bei ${net.name(stationId)} unter der Erde.`;
  return null;
}

/** kurze Begründung für eine gesperrte Auswahl (hinter dem Stationsnamen) */
export function problemBadge(round: RuleRound): string {
  if (round.restriction === 'sunny') return '☁️ unter der Erde';
  if (round.restriction === 'avoidInner') return '🚫 innerer Bezirk';
  if (round.restriction === 'avoidDistricts') return '🧩 gesperrter Bezirk';
  return '⛔ nicht erlaubt';
}

/** Ist diese Fahrt (Linie + Ein-/Ausstieg) erlaubt? */
export function legProblem(round: RuleRound, prev: LegLike[], leg: LegLike, net: RuleNet): string | null {
  const line = lineProblem(round, prev, leg.line, net);
  if (line) return line;
  const r = round.restriction;
  if (r === 'sunny') {
    const u = undergroundStop(net, leg);
    if (u) return `☁️ Die ${leg.line} fährt bei ${u} unter der Erde – heute nur an der Sonne.`;
  }
  const blocked = blockedDistricts(round);
  if (blocked.length) {
    const hit = net.traversed(leg.line, leg.from, leg.to).find((id) => blocked.includes(net.district(id) ?? 0));
    if (hit) return districtText(round, net.name(hit), net.district(hit)!);
  }
  return null;
}

/** Ist die fertige Route (am Ziel) erlaubt? Prüft auch jede Fahrt. */
export function routeProblem(round: RuleRound, legs: LegLike[], net: RuleNet): string | null {
  for (let i = 0; i < legs.length; i++) {
    const p = legProblem(round, legs.slice(0, i), legs[i], net);
    if (p) return p;
  }
  const r = round.restriction;
  const modes = legs.map((l) => net.mode(l.line));
  const n = (...m: Mode[]) => modes.filter((x) => x && m.includes(x)).length;
  if (r === 'needS' && !n('S')) return '🚆 S-Bahn-Fan: Es fehlt noch eine S-Bahn.';
  if (r === 'needTram' && !n('T')) return '🚋 Es fehlt noch ein Stück Bim.';
  if (r === 'needBus' && !n('B', 'N')) return '🚌 Busfahrer: Es fehlt noch ein Bus.';
  if (r === 'twoTrams' && n('T') < 2) return '🦘 Bim-Hüpfer: mindestens zweimal mit der Bim.';
  if (r === 'tramEnds' && modes.at(-1) !== 'T') return '🦘 Bim-Hüpfer: Die letzte Fahrt muss mit der Bim sein.';
  if (r === 'mixModes') {
    const kinds = new Set(modes.map((m) => (m === 'N' ? 'B' : m)));
    if (kinds.size < 3) return `🎨 Bunt gemischt: mindestens 3 verschiedene Verkehrsmittel – bisher ${kinds.size}.`;
  }
  if (r === 'min2Transfers' && legs.length < 3) return `🔀 Umsteige-Profi: mindestens 2-mal umsteigen (3 Fahrten) – bisher ${Math.max(0, legs.length - 1)}.`;
  if (r === 'oneLeg' && legs.length !== 1) return '🚶 Fußbus: genau eine Linie.';
  if (r === 'minBridges' && bridgeCount(legs, net) < (round.bridges ?? 0)) return `🌉 Brückenkenner: mindestens ${round.bridges} Brücken – bisher ${bridgeCount(legs, net)}.`;
  if ((r === 'mustLine' || r === 'anyLine') && round.required?.length && !legs.some((l) => round.required!.includes(l.line)))
    return round.required.length === 1 ? `📌 Pflicht-Linie: Die ${round.required[0]} muss dabei sein.` : `🎲 Eine von ${round.required.join(', ')} muss dabei sein.`;
  return null;
}

/** Regel-Hinweis für den Kopf der Runde (was gilt), kurz */
export function ruleSummary(round: RuleRound): string | null {
  const r = round.restriction;
  if (!r) return null;
  if (r === 'mustLine' && round.required?.length) return `📌 Pflicht-Linie: ${round.required[0]} muss mindestens einmal dabei sein.`;
  if (r === 'anyLine' && round.required?.length) return `🎲 Eine dieser Linien muss dabei sein: ${round.required.join(', ')}.`;
  if (r === 'umland') return `🚆 Du startest in ${round.entryTown ?? 'Niederösterreich'}. Welcher Zug bringt dich nach Wien? Umsteigen erst in Wien – die Fahrt bis zur Stadtgrenze zählt mit.`;
  if (r === 'minBridges') return `🌉 Brückenkenner: Überquere mindestens ${round.bridges} Brücken (🌉 auf der Karte) – mehr als auf der schnellsten Verbindung.`;
  if (r === 'avoidDistricts') return `🧩 Fleckerlteppich: gesperrt sind die Bezirke ${(round.districts ?? []).join(', ')} (rot auf der Karte) – dort nicht ein-, aus- oder durchfahren.`;
  if (r === 'insider') return `${RESTRICTIONS.insider.icon} Insider – nicht erlaubt: U1–U6 und die bekannten S-Bahnen S1, S2, S3, S4, S7, S45, S80. Erlaubt: Bim, Bus und die übrigen S-Bahnen (z.B. S40, S50, S60).`;
  return `${RESTRICTIONS[r].icon} ${RESTRICTIONS[r].label}: ${RESTRICTIONS[r].hint}`;
}

export { isWellKnownLine };
