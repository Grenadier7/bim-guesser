// Fehlerliste: Linien aus falsch beantworteten Quizfragen und aus Routenjagd-Runden, in denen die schnelle
// Verbindung eine andere Linie genommen hätte. Im Lernmodus unter „Üben“ → „Fehler wiederholen“; geübte Linien
// fallen wieder heraus. Mit Account auf allen Geräten gleich (account.ts).
import { loadJson, saveJson } from './storage.ts';

export const MISTAKES_KEY = 'oeffi-mistakes-v1';
/** mehr hält niemand im Kopf – die ältesten fallen heraus */
const MAX = 30;

type Mistakes = Record<string, number>; // Linie → zuletzt falsch (ms)

const read = () => loadJson<Mistakes>(MISTAKES_KEY, {});

export function addMistakes(lineIds: Iterable<string>) {
  const m = read();
  const now = Date.now();
  for (const id of lineIds) if (id) m[id] = now;
  const keep = Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX);
  saveJson(MISTAKES_KEY, Object.fromEntries(keep));
}

/** Linien der Fehlerliste, neueste zuerst */
export const mistakeLines = (): string[] =>
  Object.entries(read())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

/** nach dem Üben: diese Linien sind erledigt */
export function clearMistakes(lineIds: string[]) {
  const m = read();
  for (const id of lineIds) delete m[id];
  saveJson(MISTAKES_KEY, m);
}
