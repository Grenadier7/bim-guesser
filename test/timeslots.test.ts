// Feiertage, Wiener Schulferien und „typische Tage“ (für die Wahl der Referenz-/Abfragetage)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHoliday, isSchoolHoliday, isTypicalDay } from '../server/timeslots.ts';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

test('Regression L-09: Schulferien nach Regeln – stimmen mit der bisherigen Liste 2026/27 überein, Pfingsten 2027 dabei', () => {
  // bisherige (geprüfte) Liste
  const table: [string, string][] = [
    ['2026-02-02', '2026-02-07'], ['2026-03-28', '2026-04-06'], ['2026-05-23', '2026-05-26'], ['2026-07-04', '2026-09-06'],
    ['2026-10-27', '2026-10-31'], ['2027-02-01', '2027-02-06'], ['2027-03-20', '2027-03-29'], ['2027-07-03', '2027-09-05'],
  ];
  for (const [a, b] of table) {
    assert.ok(isSchoolHoliday(d(a)) && isSchoolHoliday(d(b)), `${a}–${b}`);
    const before = new Date(d(a).getTime() - 86400000);
    const after = new Date(d(b).getTime() + 86400000);
    assert.ok(!isSchoolHoliday(before) || before.getUTCMonth() === 11, `Tag vor ${a} ist keine Ferien`);
    assert.ok(!isSchoolHoliday(after), `Tag nach ${b} ist keine Ferien`);
  }
  for (const iso of ['2027-05-15', '2027-05-18', '2027-12-24', '2028-01-06', '2028-04-17', '2028-07-01']) assert.ok(isSchoolHoliday(d(iso)), iso);
  assert.equal(isTypicalDay(d('2027-05-18'), 'wd'), false);
});

test('Feiertage: Ostermontag, Christi Himmelfahrt, Pfingstmontag, Fronleichnam 2026; Karfreitag ist keiner', () => {
  for (const iso of ['2026-04-06', '2026-05-14', '2026-05-25', '2026-06-04', '2026-10-26']) assert.ok(isHoliday(d(iso)), iso);
  assert.equal(isHoliday(d('2026-04-03')), false);
});
