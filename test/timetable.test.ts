// Eigener Referenzfahrplan (data/timetable.json) und Verbindungssuche (server/timetable.ts): Abdeckung der Tage,
// direkte Fahrten, Umstiege, Regionalzüge auf S-Bahn-Abschnitten, Nacht, Adressen, Zwischenhalt, Plausibilität
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { EfaTrip } from '../server/efa.ts';
import { Network } from '../server/network.ts';
import { coversTime, localTrip } from '../server/timetable.ts';
import { slotTime } from '../server/timeslots.ts';

const HAS = existsSync(path.resolve(import.meta.dirname, '../data/timetable.json'));
const net = Network.load();
const at = (name: string, line?: string) => net.mainEfaId(net.data.stations.find((s) => s.name === name && (!line || s.lines.includes(line)))!.id);
const T = slotTime('wd12', 'regular', net.data.regularDays);
const rides = (t: EfaTrip) => t.legs.filter((l) => l.mode !== 'W');

/** Fahrt ist in sich stimmig: Zeiten steigen, Teilstrecken schließen aneinander an */
function consistent(t: EfaTrip) {
  for (const l of t.legs) assert.ok(l.arr >= l.dep, `${l.line}: Ankunft vor Abfahrt`);
  for (let i = 1; i < t.legs.length; i++) {
    assert.ok(t.legs[i].dep >= t.legs[i - 1].arr, 'Anschluss vor Ankunft');
    assert.equal(t.legs[i].from.id, t.legs[i - 1].to.id, 'Teilstrecken schließen nicht an');
  }
}

test('Referenztage abgedeckt, andere Tage nicht (dort fragt efa.ts die Auskunft)', { skip: !HAS }, () => {
  assert.equal(coversTime(T), true);
  assert.equal(coversTime(slotTime('sa02', 'regular', net.data.regularDays)), true);
  assert.equal(coversTime(slotTime('su12', 'regular', net.data.regularDays)), true);
  assert.equal(coversTime(T + 3 * 1440), false);
  assert.equal(localTrip({ from: at('Karlsplatz'), to: at('Praterstern'), time: T + 3 * 1440 }), null);
  assert.equal(localTrip({ from: 'gibtsnicht', to: at('Praterstern'), time: T }), null, 'unbekannter Halt → Auskunft');
});

test('direkte Fahrten (wie für die Wartezeiten): die nächsten U6 ab Westbahnhof nach Spittelau, Takt zu Mittag', { skip: !HAS }, () => {
  const trips = localTrip({ from: at('Westbahnhof', 'U6'), to: at('Spittelau', 'U6'), time: T, mots: [2], maxChanges: 0, count: 8 })!;
  assert.equal(trips.length, 8);
  for (const t of trips) {
    consistent(t);
    assert.deepEqual(rides(t).map((l) => l.line), ['U6']);
    assert.ok(t.dep >= T);
  }
  const deps = trips.map((t) => t.dep);
  assert.deepEqual(deps, [...deps].sort((a, b) => a - b));
  const gaps = deps.slice(1).map((d, i) => d - deps[i]);
  assert.ok(Math.max(...gaps) <= 6, `U6 mittags höchstens alle 6 min: ${gaps}`);
  const ride = trips[0].arr - trips[0].dep;
  assert.ok(ride >= 9 && ride <= 14, `Westbahnhof → Spittelau ${ride} min`);
});

test('Regionalzüge zählen auf S-Bahn-Abschnitten mit: Simmering → Stadlau (S80 und R/REX)', { skip: !HAS }, () => {
  const trips = localTrip({ from: at('Simmering', 'S80'), to: at('Stadlau', 'S80'), time: T, mots: [1], maxChanges: 0, count: 8 })!;
  const lines = new Set(trips.map((t) => rides(t)[0].line));
  assert.ok(lines.has('S80'), [...lines].join(','));
  assert.ok([...lines].some((l) => /^(R|REX)\d+$/.test(l!)), `kein Regionalzug: ${[...lines].join(',')}`);
  for (const t of trips) assert.equal(rides(t)[0].mode, 'S');
});

test('Umstiege: Reumannplatz → Rathaus (U1 + U2 o.ä.), mehrere Abfahrten, in sich stimmig', { skip: !HAS }, () => {
  const trips = localTrip({ from: at('Reumannplatz', 'U1'), to: at('Rathaus', 'U2'), time: T, count: 4 })!;
  assert.ok(trips.length >= 4);
  for (const t of trips) consistent(t);
  const best = Math.min(...trips.map((t) => t.arr - T));
  assert.ok(best >= 12 && best <= 25, `${best} min`);
  assert.ok(trips.some((t) => rides(t).length === 2), 'mit einem Umstieg');
});

test('Einschränkungen: ohne U-Bahn kommt keine U-Bahn vor, max. 1 Umstieg wird eingehalten', { skip: !HAS }, () => {
  const noU = localTrip({ from: at('Karlsplatz'), to: at('Praterstern'), time: T, mots: [1, 3, 4, 5], count: 3 })!;
  assert.ok(noU.length);
  for (const t of noU) assert.ok(rides(t).every((l) => l.mode !== 'U'), rides(t).map((l) => l.line).join('>'));
  const one = localTrip({ from: at('Siebenhirten'), to: at('Leopoldau'), time: T, maxChanges: 1, count: 3 })!;
  for (const t of one) assert.ok(rides(t).length <= 2);
});

test('Nacht (Samstag 2 Uhr): Nachtbusse aus der Freitagnacht', { skip: !HAS }, () => {
  const t2 = slotTime('sa02', 'regular', net.data.regularDays);
  const trips = localTrip({ from: at('Schwedenplatz'), to: at('Floridsdorf'), time: t2, count: 3 })!;
  assert.ok(trips.length, 'nachts gibt es eine Verbindung');
  assert.ok(trips.some((t) => rides(t).some((l) => l.mode === 'N' || /^U/.test(l.line ?? ''))), trips.map((t) => rides(t).map((l) => l.line).join('>')).join(' | '));
});

test('Adresse als Start: zuerst zu Fuß zur Haltestelle; über Zwischenhalt', { skip: !HAS }, () => {
  const trips = localTrip({ from: 'coord:16.3592:48.2087', to: at('Praterstern'), time: T, count: 2 })!;
  assert.ok(trips.length);
  assert.equal(trips[0].legs[0].mode, 'W');
  consistent(trips[0]);
  const via = localTrip({ from: at('Karlsplatz'), to: at('Praterstern'), time: T, via: at('Schottentor'), count: 1 })!;
  assert.ok(via.length);
  assert.ok(via[0].legs.some((l) => l.to.name === 'Schottentor' || l.from.name === 'Schottentor'), 'führt über Schottentor');
});

test('schnell genug für den Spielstart: 100 Suchen in unter 4 s', { skip: !HAS }, () => {
  const ids = net.data.stations.filter((s) => s.lines.some((l) => /^U/.test(l))).map((s) => net.mainEfaId(s.id));
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) localTrip({ from: ids[(i * 7) % ids.length], to: ids[(i * 13 + 5) % ids.length], time: T, count: 4 });
  const ms = performance.now() - t0;
  assert.ok(ms < 4000, `${Math.round(ms)} ms`);
});

test('Regionalzüge: keine eigenen Linien im Netz, zählen aber auf S-Bahn-Abschnitten mit (S80 Simmering → Stadlau)', { skip: !HAS }, async () => {
  const { evaluateUserRoute, topRoutes } = await import('../server/routing.ts');
  assert.equal(net.data.lines.filter((l) => /^(R|REX|CJX)\d+$/.test(l.id)).length, 0, 'nicht im Routen-Baukasten');
  const st = (n: string) => net.data.stations.find((s) => s.name === n && s.lines.includes('S80'))!.id;
  const [a, b] = [st('Simmering'), st('Stadlau')];
  const q = { countWait: true, restriction: null, avgWait: true };
  const rex = await evaluateUserRoute(net, [{ line: 'REX8', from: a, to: b }], a, b, T, 'regular', q, []);
  assert.match(rex.error ?? '', /Unbekannte Linie/);
  const s80 = await evaluateUserRoute(net, [{ line: 'S80', from: a, to: b }], a, b, T, 'regular', q, []);
  assert.equal(s80.error, null);
  // eine Stunde lang: mehr Abfahrten als die S80 allein (alle 30 min)
  const hour = localTrip({ from: at('Simmering', 'S80'), to: at('Stadlau', 'S80'), time: T, mots: [1], maxChanges: 0, count: 20 })!.filter((t) => t.dep < T + 60);
  assert.ok(hour.length >= 4, `${hour.length} Abfahrten/h: ${hour.map((t) => rides(t)[0].line).join(',')}`);
  // beste Verbindung: zusammengefasst „S80/…“ und mit Ø-Wartezeiten nachgerechnet
  const top = await topRoutes(net, a, b, T, q);
  const leg = top[0].legs.find((l) => l.mode !== 'W')!;
  assert.equal(leg.line, 'S80', 'nur die S-Bahn in der Beschriftung');
  assert.deepEqual(leg.with, ['REX8', 'R81'], 'Regionalzüge getrennt');
  assert.deepEqual(top[0].steps!.find((x) => x.kind === 'wait')?.with, ['REX8', 'R81'], 'beim Warten: Takt gilt mit den Regionalzügen');
  assert.ok(top[0].steps, 'nachgerechnet (Zeitplan vorhanden)');
});

test('Ergänzungen zum normalen Netz: S40 ab Franz-Josefs-Bahnhof, 18 bis Stadion, 43 bis Neuwaldegg, 46 bis Parlament', { skip: !HAS }, () => {
  const direct = (a: string, b: string, line: string, mots: number[]) =>
    localTrip({ from: at(a, line), to: at(b, line), time: T, mots, maxChanges: 0, count: 6 })!.filter((t) => rides(t)[0].line === line);
  // S40: FJB → Heiligenstadt in 5 min (Fahrplan 2024), regelmäßig
  const s40 = direct('Franz-Josefs-Bahnhof', 'Heiligenstadt', 'S40', [1]);
  assert.ok(s40.length >= 2, 'S40 fährt ab Franz-Josefs-Bahnhof');
  assert.equal(s40[0].arr - s40[0].dep, 5);
  assert.ok(direct('Heiligenstadt', 'Franz-Josefs-Bahnhof', 'S40', [1]).length >= 2, 'und zurück');
  // 18: Schlachthausgasse → Stadion
  const t18 = direct('Hauptbahnhof', 'Stadion', '18', [4]);
  assert.ok(t18.length >= 4, '18 fährt bis Stadion');
  assert.ok(direct('Stadion', 'Schlachthausgasse', '18', [4]).length >= 4, 'und zurück');
  // 43 und 46 wie an normalen Tagen
  assert.ok(direct('Schottentor', 'Neuwaldegg', '43', [4]).length >= 4, '43 bis Neuwaldegg');
  assert.ok(direct('Joachimsthalerplatz', 'Parlament/Volkstheater', '46', [4]).length >= 4, '46 bis Parlament');
  // im Netz (Routen-Baukasten) gibt es die Strecken auch
  const serves = (line: string, a: string, b: string) => net.servesInOrder(line, net.data.stations.find((s) => s.name === a && s.lines.includes(line))!.id, net.data.stations.find((s) => s.name === b && s.lines.includes(line))!.id, 'regular');
  assert.ok(serves('S40', 'Franz-Josefs-Bahnhof', 'Heiligenstadt'));
  assert.ok(serves('18', 'Schlachthausgasse', 'Stadion'));
  assert.ok(serves('43', 'Dornbach', 'Neuwaldegg'));
});

test('durchgebundene Züge (S7 wird in Rennweg zur REX2, S2 in Leopoldau zur S7): sitzen bleiben, nichts doppelt', { skip: !HAS }, () => {
  const day = T - 12 * 60 + 4 * 60; // 4 Uhr
  const all = (a: string, b: string) => localTrip({ from: at(a, 'S7'), to: at(b, 'S7'), time: day, mots: [1], maxChanges: 0, count: 200 })!;
  // ein Zug pro Abfahrt – die durchgehende Fahrt ersetzt die beiden Teile
  const back = all('Praterstern', 'St. Marx');
  assert.equal(new Set(back.map((t) => t.dep)).size, back.length, 'keine doppelten Abfahrten');
  assert.ok(back.every((t) => rides(t)[0].line === 'S7'), [...new Set(back.map((t) => rides(t)[0].line))].join(','));
  // St. Marx → Floridsdorf direkt: auch die Züge, die ab Rennweg REX2 heißen (sitzen bleiben, kein Umstieg)
  const through = all('St. Marx', 'Floridsdorf');
  assert.ok(through.length >= 20, `${through.length} direkte Züge am Tag`);
  assert.ok(through.every((t) => rides(t).length === 1 && rides(t)[0].line === 'S7'));
  // wer erst nach dem Wechsel einsteigt, sieht den richtigen Namen
  const after = all('Rennweg', 'Floridsdorf').map((t) => rides(t)[0].line);
  assert.ok(after.includes('REX2'), [...new Set(after)].join(','));
});

test('Regionalzüge nach langem Fußweg: um die Fahrzeit, nicht um die Abfragezeit (S40 mit REX4, REX41)', { skip: !HAS }, async () => {
  const { evaluateUserRoute } = await import('../server/routing.ts');
  const st = (n: string, l: string) => net.data.stations.find((s) => s.name === n && s.lines.includes(l))!.id;
  const [fjb, hei] = [st('Franz-Josefs-Bahnhof', 'S40'), st('Heiligenstadt', 'S40')];
  for (const start of [fjb, st('Siebenhirten', 'U6')]) {
    const r = await evaluateUserRoute(net, [{ line: 'S40', from: fjb, to: hei }], start, hei, T, 'regular', { countWait: true, avgWait: true, restriction: null }, []);
    const leg = r.route!.legs.find((l) => l.mode !== 'W')!;
    assert.equal(leg.line, 'S40');
    assert.deepEqual(leg.with, ['REX4', 'REX41']);
  }
});
