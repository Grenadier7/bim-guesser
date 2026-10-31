// Chat-Befehl „/ez“: wird zu einem zufälligen Spruch, nie zweimal derselbe hintereinander, Sprüche selbst sauber
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BAD_WORDS } from '../shared/config.ts';
import { EZ_PHRASES, ezPhrase, isEz } from '../server/ez.ts';
import { moderate, setBadWords } from '../server/moderation.ts';

test('„/ez“ erkannt – nur als ganze Nachricht', () => {
  assert.ok(isEz('/ez'));
  assert.ok(isEz('  /EZ '));
  assert.ok(!isEz('/ez lol'));
  assert.ok(!isEz('ez'));
});

test('Sprüche: zufällig, nie zweimal derselbe hintereinander, keine gesperrten Wörter', () => {
  const lobby = {};
  const zero = () => 0;
  const a = ezPhrase(lobby, zero);
  const b = ezPhrase(lobby, zero);
  assert.notEqual(a, b);
  assert.ok(EZ_PHRASES.includes(a) && EZ_PHRASES.includes(b));
  setBadWords(DEFAULT_BAD_WORDS);
  for (const p of EZ_PHRASES) {
    assert.equal(moderate(p), p, p);
    assert.ok(p.length <= 300);
  }
});
