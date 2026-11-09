// Das Docker-Image kopiert die Daten einzeln – fehlt eine Datei aus data/, fehlen auf dem Server ganze Challenges
// (so geschehen mit Brücken und Gewässern: „Brückenkenner“ suchte endlos, „Ab ins Bad“ fand nichts)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

/** Daten-Dateien im Repo – ohne git (z.B. im Docker-Build selbst) gibt es nichts zu prüfen */
function trackedData(): string[] | null {
  try {
    return execFileSync('git', ['ls-files', 'data'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
  } catch {
    return null;
  }
}

test('Dockerfile kopiert alle Daten-Dateien aus dem Repo', (t) => {
  const files = trackedData();
  if (!files) return t.skip('kein git');
  const tracked = files
    .filter((f) => /^data\/[^/]+\.json$/.test(f));
  assert.ok(tracked.length >= 4, 'keine Daten-Dateien gefunden');
  const copied = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
    .split('\n')
    .filter((l) => /^COPY\s/.test(l) && !l.includes('--from'))
    .flatMap((l) => l.split(/\s+/).slice(1, -1));
  const missing = tracked.filter((f) => !copied.includes(f));
  assert.deepEqual(missing, [], `im Dockerfile fehlt: ${missing.join(', ')}`);
});
