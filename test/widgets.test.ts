// Einstellungs-Warteschlange: nichts geht verloren, Änderungen während einer Anfrage werden zusammengefasst nachgeschickt
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchQueue } from '../client/src/widgets.ts';

test('Regression M-10: Änderungen während einer laufenden Anfrage gehen nicht verloren', async () => {
  const sent: object[] = [];
  const send = patchQueue(async (p: Record<string, unknown>) => {
    sent.push(p);
    await new Promise((r) => setTimeout(r, 20));
  });
  const a = send({ rounds: 3 });
  void send({ distance: 'long' });
  void send({ rounds: 10 });
  await a;
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(sent, [{ rounds: 3 }, { distance: 'long', rounds: 10 }]);
});

test('Fehler in einer Anfrage blockiert die Warteschlange nicht', async () => {
  const sent: object[] = [];
  let first = true;
  const send = patchQueue(async (p: Record<string, unknown>) => {
    sent.push(p);
    await new Promise((r) => setTimeout(r, 10));
    if (first) {
      first = false;
      throw new Error('Netz weg');
    }
  });
  await send({ a: 1 }).catch(() => {});
  await send({ b: 2 });
  assert.deepEqual(sent, [{ a: 1 }, { b: 2 }]);
});
