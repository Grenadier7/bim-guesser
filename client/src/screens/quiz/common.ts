// Quiz – gemeinsame Helfer der Bildschirme (Liniennummern, Karte, Spielerliste)
import type { LatLon, Line, QuizState } from '../../../../shared/types.ts';
import { regularPatterns } from '../../../../shared/rules.ts';
import { type QuizQuestionPublic, type QuizSettings } from '../../../../shared/quiz.ts';
import { netLayer, netView } from '../../netmap.ts';
import { app } from '../../store.ts';
import { kickButton } from '../host.ts';
import { accountTag, esc, lineChip } from '../../ui.ts';

export const NEUTRAL = '#3a3f47';

export function chip(id: string): string {
  const l = app.net.lines.get(id);
  return l ? lineChip(l.mode, l.id, l.color) : esc(id);
}

export function linePaths(l: Line): { paths: [number, number][][]; stops: { id: string; lat: number; lon: number; name: string; terminal: boolean }[] } {
  const pats = regularPatterns(l);
  const ends = new Set(pats.flatMap((p) => [p[0], p[p.length - 1]]));
  return {
    paths: pats.map((p) => p.map((id) => [app.net.station(id).lat, app.net.station(id).lon] as [number, number])),
    stops: [...new Set(pats.flat())].map((id) => {
      const s = app.net.station(id);
      return { id, lat: s.lat, lon: s.lon, name: s.name, terminal: ends.has(id) };
    }),
  };
}

/** Mehrere Linien auf der Netzkarte hervorheben (mit Nummer) */
export function drawLinesColored(ids: string[], fit: boolean) {
  const pts = netLayer().render(netView({ focus: new Set(ids.filter((id) => app.net.lines.has(id))), allLabels: true }));
  if (fit && pts.length) app.map.fitPoints(pts, 15);
}

/** Linie zeichnen: Start- und Endstation */
export function sketchEnds(q: QuizQuestionPublic): [LatLon, LatLon] | undefined {
  if (q.type !== 'draw' || q.markers?.length !== 2) return undefined;
  const [a, b] = q.markers.map((id) => app.net.station(id));
  return [
    [a.lat, a.lon],
    [b.lat, b.lon],
  ];
}

/** Linien, die von einer Station abfahren (im Quiz-Netz) */
export function linesAt(stationId: string): Line[] {
  return app.net
    .station(stationId)
    .lines.map((id) => app.net.lines.get(id))
    .filter((l): l is Line => !!l && linePaths(l).paths.length > 0);
}

/** Linie auf der Netzkarte: während der Frage allein, neutral und still (verrät nichts) – in der Auflösung
 *  in ihrer Farbe mit Endstationen und Namen */
export function drawLine(id: string, reveal: boolean, fit: boolean) {
  const l = app.net.lines.get(id);
  if (!l) return;
  const { stops } = linePaths(l);
  const stations = stops.map((s) => app.net.station(s.id));
  const view = reveal
    ? netView({ focus: new Set([id]), stops: stations, marks: stops.filter((s) => s.terminal).map((s) => app.net.station(s.id)) })
    : netView({ focus: new Set([id]), only: new Set([id]), colors: { [id]: NEUTRAL }, stops: stations, quiet: true });
  const pts = netLayer().render(view);
  if (fit && pts.length) app.map.fitPoints(pts, 15);
}

export function areaOf(s: QuizSettings) {
  const d = s.area ? app.net.data.districts.find((x) => x.id === s.area) : null;
  return d ? { rings: d.rings } : null;
}

export function playersHtml(st: QuizState): string {
  return st.players
    .map(
      (p) => `<li class="${p.connected ? '' : 'offline'}"><span class="dot"></span>${esc(p.name)}${accountTag(p)}${p.id === app.session?.playerId ? ' <small>(du)</small>' : ''}${p.isHost ? ' <span title="Host">👑</span>' : ''}${kickButton(p)}</li>`,
    )
    .join('');
}
