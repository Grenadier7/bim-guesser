// Trainings-Coach: Rückmeldung zu jeder Teilstrecke, gestufte Hilfen und Erklärung am Ende
import type { Line, Mode, RouteLeg, RouteOption, Station } from '../../../shared/types.ts';
import { MODE_LABEL, lineKey } from '../../../shared/rules.ts';
import type { DraftLeg } from '../builder.ts';
import { departuresFrom, patternsOf, type Scope } from '../learn/model.ts';
import { distM, fmtDist } from '../net.ts';
import { app } from '../store.ts';

export interface CoachMsg {
  kind: 'good' | 'info' | 'warn';
  text: string;
}

const ALL_MODES = { modes: new Set<Mode>(['U', 'S', 'T', 'B', 'N']) } as Scope;

const pt = (r: RouteOption) => r.legs.filter((l) => l.mode !== 'W');

/**
 * Gleiche Linie? Wie bei der Wertung gilt auf demselben Abschnitt jede S-Bahn, Bim bzw. jeder Bus
 * gleich (S1/S2/S3 Praterstern–Meidling, 30/31 Brünner Straße–Floridsdorf). U-Bahnen bleiben getrennt.
 */
function sameLine(user: Line, leg: RouteLeg, userLeg?: DraftLeg): boolean {
  if (!leg.line) return false;
  if (leg.line.split('/').includes(user.id)) return true;
  if (user.mode === 'U' || lineKey(user.mode, user.id) !== lineKey(leg.mode, leg.line)) return false;
  if (user.mode === 'S') return true;
  // Bim/Bus: nur wenn auch Ein- und Ausstieg übereinstimmen
  if (!userLeg) return false;
  const name = (id: string) => app.net.station(id)?.name;
  return name(userLeg.from) === leg.fromName && name(userLeg.to) === leg.toName;
}

// ---------------------------------------------------------------- Richtung

const COMPASS = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];

export function compass(from: { lat: number; lon: number }, to: { lat: number; lon: number }): string {
  const dy = to.lat - from.lat;
  const dx = (to.lon - from.lon) * Math.cos((from.lat * Math.PI) / 180);
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return COMPASS[Math.round(((deg + 360) % 360) / 45) % 8];
}

/** "Die 5B fährt von hier Richtung Praterstern (über Taborstraße) oder Richtung Heiligenstadt." */
export function lineDirections(line: Line, board: Station): string {
  const dep = departuresFrom(board, ALL_MODES).find((d) => d.line.id === line.id);
  if (!dep) return `Die ${line.id} hält bei ${board.name}.`;
  const dirs = dep.dirs.map((d) => `Richtung ${d.to}${d.via ? ` (über ${d.via})` : ''}`);
  return `Die ${line.id} fährt ab ${board.name} ${dirs.length > 1 ? `${dirs.slice(0, -1).join(', ')} oder ${dirs[dirs.length - 1]}` : dirs[0]}.`;
}

// ---------------------------------------------------------------- Rückmeldung je Teilstrecke

export function legFeedback(leg: DraftLeg, index: number, before: Station, dest: Station, routes: RouteOption[]): CoachMsg[] {
  const net = app.net;
  const to = net.station(leg.to);
  const out: CoachMsg[] = [];
  const best = pt(routes[0]);
  const bestLeg = best[index];

  if (bestLeg && sameLine(leg.line, bestLeg, leg) && (bestLeg.toStation === leg.to || bestLeg.toName === to.name)) {
    out.push({ kind: 'good', text: `👍 Genau so fährt die schnellste Verbindung: mit der ${leg.line.id} bis ${to.name}.` });
  } else if (bestLeg && sameLine(leg.line, bestLeg, leg)) {
    const next = best[index + 1];
    const wrongWay = isWrongWay(leg, bestLeg.toStation);
    if (wrongWay) {
      out.push({
        kind: 'warn',
        text: `⚠️ Die ${leg.line.id} ist die richtige Linie – aber in die falsche Richtung! Fahr Richtung ${wrongWay} (bis ${bestLeg.toName}).`,
      });
    } else
      out.push({
        kind: 'info',
        text: `Die ${leg.line.id} ist richtig! Die schnellste Verbindung steigt aber bei ${bestLeg.toName} aus${next ? ` – dort geht's mit der ${next.line} weiter` : ''}.`,
      });
  } else {
    const rank = routes.findIndex((r) => pt(r)[index] && sameLine(leg.line, pt(r)[index], leg));
    if (rank > 0) out.push({ kind: 'info', text: `Die ${leg.line.id} ist Teil der ${rank + 1}.-schnellsten Verbindung – nicht schlecht!` });
    const d0 = distM(before, dest);
    const d1 = distM(to, dest);
    if (leg.to === dest.id) out.push({ kind: 'good', text: '🏁 Damit bist du am Ziel.' });
    else if (d1 > d0 + 200) out.push({ kind: 'warn', text: `⚠️ Damit entfernst du dich vom Ziel (${fmtDist(d1 - d0)} weiter weg). Das Ziel liegt im ${compass(to, dest)}.` });
    else if (rank < 0 && d1 < d0 - 300)
      out.push({ kind: 'info', text: `Die ${leg.line.id} bringt dich ${fmtDist(d0 - d1)} näher ans Ziel – die schnellste Verbindung nimmt hier aber eine andere Linie.` });
    else if (rank < 0) out.push({ kind: 'warn', text: `Hm, die ${leg.line.id} bringt dich kaum näher ans Ziel.` });
  }
  if (leg.to !== dest.id && out[0]?.kind === 'good') {
    out.push({ kind: 'info', text: `Von ${to.name} sind es noch ${fmtDist(distM(to, dest))} Richtung ${compass(to, dest)}.` });
  }
  return out;
}

/**
 * Fährt der User auf der richtigen Linie, aber vom richtigen Ausstieg weg?
 * Gibt dann die richtige Endstation ("Richtung …") zurück, sonst null.
 */
function isWrongWay(leg: DraftLeg, target: string | null): string | null {
  if (!target) return null;
  const net = app.net;
  for (const p of patternsOf(leg.line)) {
    const i = p.indexOf(leg.from);
    const j = p.indexOf(target);
    if (i < 0 || j <= i) continue;
    // richtige Richtung: Ausstieg liegt in dieser Haltefolge zwischen Einstieg und Ziel (oder dahinter)
    if (p.indexOf(leg.to, i + 1) > i) return null;
    return net.station(p[p.length - 1]).name;
  }
  return null;
}

// ---------------------------------------------------------------- Gestufte Hilfen

export const HINTS = [
  { id: 'dir', label: '🧭 Richtung' },
  { id: 'modes', label: '🚇 Verkehrsmittel' },
  { id: 'first', label: '1️⃣ Erste Linie' },
  { id: 'transfers', label: '🔀 Umstiege' },
  { id: 'solution', label: '💡 Lösung' },
] as const;
export type HintId = (typeof HINTS)[number]['id'];

export function hintText(id: HintId, position: Station, dest: Station, best: RouteOption): string {
  const legs = pt(best);
  if (id === 'dir') return `Das Ziel liegt ${fmtDist(distM(position, dest))} im ${compass(position, dest)} von ${position.name}.`;
  if (id === 'modes')
    return `Die schnellste Verbindung: ${legs.map((l) => MODE_LABEL[l.mode]).join(' → ')} (${legs.length - 1 === 0 ? 'ohne Umstieg' : `${legs.length - 1} Umstieg${legs.length > 2 ? 'e' : ''}`}).`;
  if (id === 'first') return `Starte mit der ${legs[0].line} ab ${legs[0].fromName}.`;
  if (id === 'transfers')
    return legs.length > 1 ? `Umsteigen bei: ${legs.slice(0, -1).map((l) => l.toName).join(', ')}.` : 'Kein Umstieg nötig – eine Linie fährt direkt!';
  return `Lösung: ${routeSentence(best)}`;
}

// ---------------------------------------------------------------- Auswertung

function minutes(l: RouteLeg): number {
  const [h1, m1] = l.dep.split(':').map(Number);
  const [h2, m2] = l.arr.split(':').map(Number);
  return (((h2 * 60 + m2 - (h1 * 60 + m1)) % 1440) + 1440) % 1440;
}

/** "5B bis Taborstraße, dann U2 bis Stadion" */
export function routeSentence(r: RouteOption): string {
  const legs = pt(r);
  return legs.map((l, i) => `${i === 0 ? '' : 'dann '}${l.line} bis ${l.toName}`).join(', ');
}

export function explain(user: RouteOption, best: RouteOption): string[] {
  const out: string[] = [];
  const u = pt(user);
  const b = pt(best);
  const walk = (r: RouteOption) => r.legs.filter((l) => l.mode === 'W').reduce((s, l) => s + minutes(l), 0);
  const ride = (r: RouteOption) => pt(r).reduce((s, l) => s + minutes(l), 0);
  if (u.length !== b.length) {
    const d = u.length - b.length;
    out.push(d > 0 ? `Du steigst ${d}× öfter um – jeder Umstieg kostet Geh- und Wartezeit.` : `Du steigst ${-d}× seltener um, verlierst aber anderswo Zeit.`);
  }
  const wDiff = walk(user) - walk(best);
  if (wDiff >= 3) out.push(`Du gehst etwa ${wDiff} min mehr zu Fuß.`);
  const waitU = user.medianMin - user.rideMin;
  const waitB = best.medianMin - best.rideMin;
  if (waitU - waitB >= 3)
    out.push(`Bei deiner Route wartest du im Schnitt ${waitU - waitB} min länger an der Haltestelle${u[0] ? ` – die ${u[0].line} fährt seltener` : ''}.`);
  const rDiff = ride(user) - ride(best);
  if (rDiff >= 3) {
    // Unterschied benennen: schnelles Verkehrsmittel der besten Route, das du nicht genutzt hast
    const fast = b.find((l) => (l.mode === 'U' || l.mode === 'S') && !u.some((x) => x.line === l.line));
    const slow = u.find((l) => (l.mode === 'B' || l.mode === 'T') && !b.some((x) => x.line === l.line));
    out.push(
      fast && slow
        ? `Die reine Fahrzeit ist ${rDiff} min länger: Die ${fast.line} ist auf diesem Stück schneller als die ${slow.line} (${slow.mode === 'B' ? 'Bus' : 'Bim'}).`
        : `Die reine Fahrzeit ist ${rDiff} min länger – deine Route ist ein Umweg.`,
    );
  }
  if (waitB - waitU >= 3) out.push(`Dafür wartest du bei deiner Route ${waitB - waitU} min weniger – das macht einen Teil wieder wett.`);
  if (!out.length) out.push('Die Unterschiede sind klein – vor allem Abfahrtszeiten und Anschlüsse machen den Unterschied.');
  return out;
}
