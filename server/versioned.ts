// Einstellungen der Admin-Seite als JSON im State-Ordner – jede Änderung wird als Version aufgehoben (zum Zurückrollen).
// Atomar geschrieben (erst .tmp, dann umbenennen): ein Absturz mittendrin hinterlässt nie eine halbe Datei.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.ts';

const KEEP = 100;

export interface Version {
  id: string;
  at: number;
  by: string;
  note: string;
}

export class VersionedJson<T> {
  private name: string;
  private value: T;
  private dir: string;
  private sanitize: (v: unknown) => T;
  private fallback: () => T;

  constructor(name: string, sanitize: (v: unknown) => T, fallback: () => T, dir = path.join(STATE_DIR, 'config')) {
    this.name = name;
    this.dir = dir;
    this.sanitize = sanitize;
    this.fallback = fallback;
    this.value = this.read();
  }

  private get file() {
    return path.join(this.dir, `${this.name}.json`);
  }
  private get histDir() {
    return path.join(this.dir, 'history', this.name);
  }

  private read(): T {
    try {
      if (existsSync(this.file)) return this.sanitize(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (e) {
      console.warn(`⚠ ${this.file} ist ungültig und wird ignoriert (Standard gilt): ${(e as Error).message}`);
    }
    return this.fallback();
  }

  get(): T {
    return this.value;
  }

  /** prüfen, speichern, als Version aufheben */
  save(next: unknown, by: string, note: string): T {
    const v = this.sanitize(next);
    mkdirSync(this.histDir, { recursive: true });
    const at = Date.now();
    const id = `${at}`;
    writeFileSync(path.join(this.histDir, `${id}.json`), JSON.stringify({ at, by, note, value: v }));
    writeFileSync(`${this.file}.tmp`, JSON.stringify(v, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    this.value = v;
    const old = readdirSync(this.histDir).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP))) rmSync(path.join(this.histDir, f), { force: true });
    return v;
  }

  versions(): Version[] {
    if (!existsSync(this.histDir)) return [];
    return readdirSync(this.histDir)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort()
      .reverse()
      .map((f) => {
        try {
          const { at, by, note } = JSON.parse(readFileSync(path.join(this.histDir, f), 'utf8')) as Version;
          return { id: f.slice(0, -5), at, by, note };
        } catch {
          return null;
        }
      })
      .filter((x): x is Version => !!x);
  }

  /** eine frühere Version wieder herstellen (wird selbst als neue Version gespeichert) */
  rollback(id: string, by: string): T {
    if (!/^\d+$/.test(id)) throw new Error('Unbekannte Version.');
    const f = path.join(this.histDir, `${id}.json`);
    if (!existsSync(f)) throw new Error('Unbekannte Version.');
    const { value, at } = JSON.parse(readFileSync(f, 'utf8')) as { value: unknown; at: number };
    return this.save(value, by, `zurück auf den Stand vom ${new Date(at).toLocaleString('de-AT')}`);
  }
}
