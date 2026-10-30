// Gespeicherter Stand im Browser (localStorage/sessionStorage) – fehlertolerant: privater Modus,
// volle Ablage oder kaputtes JSON führen nie zu einem Fehler, sondern zum Standardwert.

type Store = () => Storage;
const local: Store = () => localStorage;

/** Gespeicherter Wert oder `def` (fehlend, kaputt oder null) */
export function loadJson<T>(key: string, def: T, storage: Store = local): T {
  try {
    return (JSON.parse(storage().getItem(key) ?? 'null') as T | null) ?? def;
  } catch {
    return def;
  }
}

/** Gespeichertes Objekt über `def` gelegt – neue Felder bekommen so ihren Standardwert */
export function loadMerged<T extends object>(key: string, def: T, storage: Store = local): T {
  try {
    return { ...def, ...JSON.parse(storage().getItem(key) ?? '{}') };
  } catch {
    return def;
  }
}

/** wird nach jedem Speichern in localStorage aufgerufen (Account-Sync) */
let onSave: ((key: string, v: unknown) => void) | null = null;
export function onSaveJson(fn: (key: string, v: unknown) => void) {
  onSave = fn;
}

/** Speichern; null/undefined löscht den Eintrag */
export function saveJson(key: string, v: unknown, storage: Store = local) {
  try {
    if (v == null) storage().removeItem(key);
    else storage().setItem(key, JSON.stringify(v));
  } catch {
    /* privater Modus o.ä. */
  }
  if (storage === local) onSave?.(key, v ?? null);
}
