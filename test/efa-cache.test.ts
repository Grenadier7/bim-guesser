// Auskunfts-Cache: Speicher begrenzt (H-04), abgelaufene Dateien werden gelöscht (M-05)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { installEfaMock } from './support/efa-mock.ts';

await installEfaMock();
const efa = await import('../server/efa.ts');
const { Network } = await import('../server/network.ts');
const net = Network.load();

test('Regression H-04: Speicher-Cache wächst nicht über 500 Antworten', async () => {
  const ids = Object.values(net.data.efaIds).map((x) => x[0]);
  for (let i = 0; i < 620; i++) await efa.trip({ from: ids[i % ids.length], to: ids[(i * 7 + 3) % ids.length], time: 29_000_000 + i });
  assert.ok(efa.memCacheSize() <= 500, `${efa.memCacheSize()} Einträge`);
});

test('Regression M-05: abgelaufene Cache-Dateien werden gelöscht, frische bleiben', async () => {
  const dir = path.join(process.env.STATE_DIR!, 'cache');
  mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'alt.json');
  const fresh = path.join(dir, 'neu.json');
  writeFileSync(old, '{}');
  writeFileSync(fresh, '{}');
  const fourDaysAgo = (Date.now() - 4 * 24 * 3600 * 1000) / 1000;
  utimesSync(old, fourDaysAgo, fourDaysAgo);
  assert.ok((await efa.cleanDiskCache()) >= 1);
  assert.ok(!existsSync(old));
  assert.ok(existsSync(fresh));
});
