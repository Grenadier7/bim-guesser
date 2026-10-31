// Betriebsmeldungen der Wiener Linien (Open Data, Echtzeit): Störungen und Bauarbeiten mit betroffenen Linien und
// Zeitraum – für die Admin-Ansicht „Aktuell“ (wie und wie lange Linien anders fahren). Ohne Daten über Spielende.
// Zwischengespeichert (10 min), damit die Admin-Seite die Schnittstelle nicht bei jedem Aufruf fragt.
import type { TrafficInfo } from '../shared/types.ts';

const URL_INFO = 'https://www.wienerlinien.at/ogd_realtime/trafficInfoList?name=stoerunglang&name=stoerungkurz';
const TTL_MS = 10 * 60_000;

let cache: { at: number; infos: TrafficInfo[] } | null = null;

interface Raw {
  refTrafficInfoCategoryId?: number;
  title?: string;
  description?: string;
  relatedLines?: string[];
  time?: { start?: string; end?: string } | null;
}

/** Zeitstempel der Schnittstelle („2026-11-07T01:00:00.000+0100“) → ms */
const ms = (s: string | undefined) => (s ? Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) || null : null);

export function parseTrafficInfos(json: unknown): TrafficInfo[] {
  const list = ((json as { data?: { trafficInfos?: Raw[] } })?.data?.trafficInfos ?? []) as Raw[];
  return list
    .filter((t) => t.refTrafficInfoCategoryId === 2 || t.refTrafficInfoCategoryId === 3)
    .map((t) => ({
      kind: t.refTrafficInfoCategoryId === 2 ? ('long' as const) : ('short' as const),
      title: String(t.title ?? '').slice(0, 200),
      text: String(t.description ?? '').slice(0, 1000),
      lines: (t.relatedLines ?? []).map(String).slice(0, 40),
      start: ms(t.time?.start),
      end: ms(t.time?.end),
    }))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/** aktuelle Meldungen; bei Fehlern die letzten bekannten (mit Hinweis) */
export async function trafficInfos(now = Date.now()): Promise<{ infos: TrafficInfo[]; at: number | null; error: boolean }> {
  if (cache && now - cache.at < TTL_MS) return { infos: cache.infos, at: cache.at, error: false };
  try {
    const res = await fetch(URL_INFO, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    cache = { at: now, infos: parseTrafficInfos(await res.json()) };
    return { infos: cache.infos, at: cache.at, error: false };
  } catch {
    return { infos: cache?.infos ?? [], at: cache?.at ?? null, error: true };
  }
}
