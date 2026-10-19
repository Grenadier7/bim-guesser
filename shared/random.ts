// Zufall – gemeinsam für Quiz (Server) und Lernmodus (Client)

/** Mischt das Array an Ort und Stelle (Fisher-Yates) und gibt es zurück */
export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Zufälliges Element (undefined bei leerem Array) */
export const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
