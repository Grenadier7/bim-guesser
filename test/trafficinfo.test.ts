// Betriebsmeldungen der Wiener Linien: nur Störungen (lang/kurz), keine Aufzugsmeldungen; Zeiten mit Zeitzone
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTrafficInfos } from '../server/trafficinfo.ts';

test('Meldungen: Störungen mit Linien und Zeitraum, Aufzüge weg', () => {
  const infos = parseTrafficInfos({
    data: {
      trafficInfos: [
        { refTrafficInfoCategoryId: 1, title: 'Kliebergasse', description: 'Aufzug', relatedLines: ['1'], time: null },
        {
          refTrafficInfoCategoryId: 2,
          title: 'D: Gleisbauarbeiten',
          description: 'Linie D: Kein Betrieb zwischen Börse und Augasse.',
          relatedLines: ['D'],
          time: { start: '2026-09-28T04:30:00.000+0200', end: '2026-11-07T01:00:00.000+0100' },
        },
        { refTrafficInfoCategoryId: 3, title: '13A: Verspätungen', description: 'Unfall', relatedLines: ['13A'], time: { start: '2026-10-31T08:00:00.000+0100' } },
      ],
    },
  });
  assert.equal(infos.length, 2);
  assert.deepEqual({ ...infos[0], text: '' }, { kind: 'long', title: 'D: Gleisbauarbeiten', text: '', lines: ['D'], start: Date.parse('2026-09-28T02:30:00Z'), end: Date.parse('2026-11-07T00:00:00Z') });
  assert.equal(infos[1].kind, 'short');
  assert.equal(infos[1].end, null);
  assert.deepEqual(parseTrafficInfos(null), []);
});
