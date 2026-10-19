// Browser-Ablage: Standardwerte bei fehlenden/kaputten Einträgen, Zusammenführen, Löschen, Fehler im privaten Modus
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadJson, loadMerged, saveJson } from '../client/src/storage.ts';

function fake(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
const broken = () => {
  throw new Error('SecurityError: privater Modus');
};

test('fehlend oder kaputt → Standardwert', () => {
  const s = fake();
  assert.deepEqual(loadJson('x', [1], () => s), [1]);
  s.setItem('x', '{kaputt');
  assert.deepEqual(loadJson('x', [1], () => s), [1]);
  assert.deepEqual(loadMerged('x', { a: 1 }, () => s), { a: 1 });
  s.setItem('x', 'null');
  assert.deepEqual(loadJson('x', 'def', () => s), 'def');
});

test('speichern, laden, mit Standard zusammenführen, null löscht', () => {
  const s = fake();
  saveJson('k', { b: 2 }, () => s);
  assert.deepEqual(loadJson('k', {}, () => s), { b: 2 });
  assert.deepEqual(loadMerged('k', { a: 1, b: 0 }, () => s), { a: 1, b: 2 });
  saveJson('k', null, () => s);
  assert.equal(s.getItem('k'), null);
});

test('Ablage nicht verfügbar (privater Modus, Node) → kein Fehler', () => {
  assert.deepEqual(loadJson('k', 5, broken), 5);
  assert.deepEqual(loadMerged('k', { a: 1 }, broken), { a: 1 });
  assert.doesNotThrow(() => saveJson('k', 1, broken));
});
