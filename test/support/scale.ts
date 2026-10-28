// Vor allen Server-Imports laden: Rate-Limits für In-Prozess-Tests hochsetzen (SCALE wird beim Import gelesen) und
// Laufzeitdaten (Auskunfts-Cache, Statistik) in einen eigenen Ordner – nie in den echten Cache unter data/
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.RATE_LIMIT_SCALE ??= '1000';
process.env.STATE_DIR ??= mkdtempSync(path.join(tmpdir(), 'bimguesser-test-'));
