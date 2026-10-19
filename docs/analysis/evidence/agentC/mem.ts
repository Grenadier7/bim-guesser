import { readdirSync, readFileSync, statSync } from 'node:fs';
const dir = 'D:/files/!workingDIR/Zuhause_Dateien/verbindungs_guesser/data/cache';
const files = readdirSync(dir);
let total = 0, expired = 0, oldest = Infinity;
const now = Date.now();
const sizes: number[] = [];
for (const f of files) { const st = statSync(dir + '/' + f); total += st.size; sizes.push(st.size); if (now - st.mtimeMs > 3 * 86400000) expired++; oldest = Math.min(oldest, st.mtimeMs); }
sizes.sort((a, b) => a - b);
console.log('files', files.length, 'MB', (total / 1e6).toFixed(0), 'expired(>3d)', expired, 'oldest', new Date(oldest).toISOString(), 'median KB', (sizes[sizes.length >> 1] / 1e3).toFixed(0), 'p95 KB', (sizes[Math.floor(sizes.length * 0.95)] / 1e3).toFixed(0));
// heap per parsed response (sample 300 files)
(globalThis as any).gc?.();
const before = process.memoryUsage().heapUsed;
const keep: any[] = [];
let raw = 0;
for (const f of files.slice(0, 300)) { const s = readFileSync(dir + '/' + f, 'utf8'); raw += s.length; keep.push(JSON.parse(s).data); }
(globalThis as any).gc?.();
const after = process.memoryUsage().heapUsed;
console.log('300 parsed: heap MB', ((after - before) / 1e6).toFixed(0), 'raw MB', (raw / 1e6).toFixed(0), '-> per entry KB', ((after - before) / 300 / 1e3).toFixed(0));
// url kinds
const kinds = new Map<string, number>();
for (const f of files.slice(0, 2000)) { try { const j = JSON.parse(readFileSync(dir + '/' + f, 'utf8')); const k = String(j.url).match(/ogd_routing\/(\w+)/)?.[1] + (String(j.url).includes('name_via') ? '+via' : ''); kinds.set(k, (kinds.get(k) ?? 0) + 1); } catch {} }
console.log(kinds);
