// Fortschritt zusammenführen (Account-Sync): Objekte je Schlüssel, Zahlen das Maximum, Ja/Nein „oder“, Listen
// vereinigt – so geht nichts verloren, wenn zwei Geräte gleichzeitig spielen. Nur für Stände, aus denen nie etwas
// entfernt wird (Kurse, Tutorial); gemerkte Linien kann man abwählen, dort gilt der zuletzt gespeicherte Stand.
export function mergeProgress(a: unknown, b: unknown): unknown {
  if (a == null) return b;
  if (b == null) return a;
  if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b].map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as object) };
    for (const [k, v] of Object.entries(b as object)) out[k] = mergeProgress(out[k], v);
    return out;
  }
  return b;
}

/** am Server immer zusammengeführt statt überschrieben */
export const MONOTONE_KEYS = ['oeffi-courses-v1', 'oeffi-progress-v1'];
