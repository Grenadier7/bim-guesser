// Netzplan „Zielnetz 2040“ (Tages-Challenge „Zielnetz 2040“): was es in Wien bis etwa 2040 geben könnte – nicht
// genau, sondern als spielbares Zukunftsnetz. Angelegt als eigener Netzplan (Admin → Netzpläne), dort änderbar.
// Grundlage: Wiener-Linien-/ÖBB-Ausbaupläne (U2/U5-Linienkreuz, U1 Rothneusiedl, S-Bahn-Ausbau, neue Bim-Strecken).
import type { DayType, LineEdit, NetworkPlan, ServiceBand } from '../shared/types.ts';

/** Takt: Mo–Fr / Sa / So von früh bis Mitternacht */
const every = (wd: number, sa = wd, su = sa): Record<DayType, ServiceBand[]> => ({
  wd: [{ from: '05:00', to: '24:00', every: wd }],
  sa: [{ from: '05:30', to: '24:00', every: sa }],
  su: [{ from: '06:00', to: '24:00', every: su }],
});
/** dichterer Takt einer bestehenden Linie (alle Tage) */
const denser = (line: string, wd: number, we: number): LineEdit[] => [
  { kind: 'headway', line, day: 'wd', from: '05:00', to: '24:00', every: wd },
  { kind: 'headway', line, day: 'sa', from: '05:30', to: '24:00', every: we },
  { kind: 'headway', line, day: 'su', from: '06:00', to: '24:00', every: we },
];
const station = (station: string, name: string, lat: number, lon: number, district: number): LineEdit => ({ kind: 'addStation', station, name, lat, lon, district });

export const ZIEL2040_EDITS: LineEdit[] = [
  // ---- neue Stationen
  station('z40-arne', 'Arne-Karlsson-Park', 48.2183, 16.3478, 9),
  station('z40-frankh', 'Frankhplatz', 48.214, 16.3521, 9),
  station('z40-reinp', 'Reinprechtsdorfer Straße', 48.1857, 16.3555, 5),
  station('z40-wbg', 'Wienerberg', 48.1695, 16.3445, 10),
  station('z40-rothn', 'Rothneusiedl', 48.138, 16.3925, 10),
  station('z40-enns', 'Ennsgasse', 48.2265, 16.403, 2),
  station('z40-lobau', 'Lobau', 48.1935, 16.4935, 22),
  station('z40-essl', 'Essling', 48.216, 16.518, 22),
  station('z40-pilot', 'Pilotengasse', 48.2205, 16.495, 22),
  station('z40-hauptallee', 'Prater Hauptallee', 48.2145, 16.407, 2),
  station('z40-nwb', 'Nordwestbahnhof', 48.229, 16.38, 20),
  station('z40-seenord', 'Seestadt Nord', 48.233, 16.518, 22),

  // ---- U-Bahn-Linienkreuz U2/U5
  // U5 neu: Hernals – Elterleinplatz – Michelbeuern – Arne-Karlsson-Park – Frankhplatz – Rathaus – … – Karlsplatz
  {
    kind: 'addLine',
    line: 'U5',
    mode: 'U',
    color: '#2cb1b1',
    stops: [
      { station: 's1228', min: 0 },
      { station: 's996', min: 2 },
      { station: 's1600', min: 2 },
      { station: 'z40-arne', min: 1 },
      { station: 'z40-frankh', min: 2 },
      { station: 's72', min: 2 },
      { station: 's421', min: 1 },
      { station: 's1564', min: 1 },
      { station: 's1386', min: 2 },
    ],
    service: every(4, 5, 5),
  },
  // U2 neu: ab Rathaus nicht mehr zum Karlsplatz, sondern über Neubaugasse und Pilgramgasse zum Wienerberg
  { kind: 'cut', line: 'U2', at: 's72', beyond: 's1386' },
  {
    kind: 'extend',
    line: 'U2',
    at: 's72',
    stops: [
      { station: 's1289', min: 2 },
      { station: 's19', min: 2 },
      { station: 'z40-reinp', min: 1 },
      { station: 's1577', min: 2 },
      { station: 's1171', min: 2 },
      { station: 'z40-wbg', min: 2 },
    ],
  },
  // U1 Rothneusiedl: jeder zweite Zug ab Alaudagasse nach Rothneusiedl
  {
    kind: 'addVariant',
    line: 'U1',
    stops: [
      { station: 's314', min: 0 },
      { station: 's1386', min: 2 },
      { station: 's356', min: 1 },
      { station: 's341', min: 2 },
      { station: 's1395', min: 1 },
      { station: 's95', min: 1 },
      { station: 's560', min: 2 },
      { station: 's386', min: 2 },
      { station: 'z40-rothn', min: 3 },
    ],
    service: every(8, 10, 10),
  },

  // ---- S-Bahn: Ring, dichtere Takte, neue Tangente
  // S45 über Handelskai hinaus bis Praterkai – mit der S80 ein Ring um die Stadt
  { kind: 'extend', line: 'S45', at: 's691', stops: [{ station: 'z40-enns', min: 3 }, { station: 's295', min: 4 }] },
  ...denser('S45', 5, 7),
  ...denser('S80', 10, 15),
  // Stammstrecke: jede Linie alle 15 Minuten (zusammen etwa alle 3–4 Minuten)
  ...denser('S1', 15, 15),
  ...denser('S2', 15, 30),
  ...denser('S3', 15, 30),
  ...denser('S4', 15, 30),
  // S70 neu: Simmering – Lobau – Essling – Aspern Nord – Süßenbrunn (Tangente im Osten)
  {
    kind: 'addLine',
    line: 'S70',
    mode: 'S',
    color: '#1e6fbf',
    stops: [
      { station: 's260', min: 0 },
      { station: 'z40-lobau', min: 5 },
      { station: 'z40-essl', min: 3 },
      { station: 's1636', min: 3 },
      { station: 's346', min: 6 },
    ],
    service: every(15, 30, 30),
  },

  // ---- Straßenbahn
  // 15 neu: Wienerberg-Tangente Meidling – Wienerbergbrücke – Wienerberg – Gußriegelstraße – Troststraße
  {
    kind: 'addLine',
    line: '15',
    mode: 'T',
    color: '#9e1b32',
    stops: [
      { station: 's16', min: 0 },
      { station: 's466', min: 2 },
      { station: 'z40-wbg', min: 3 },
      { station: 's1171', min: 3 },
      { station: 's560', min: 4 },
    ],
    service: every(7, 10, 10),
  },
  // 25 neu geführt: von Aspern, Oberdorfstraße weiter in die Seestadt
  { kind: 'extend', line: '25', at: 's614', stops: [{ station: 'z40-pilot', min: 3 }, { station: 's1668', min: 3 }] },
  // 27 in die Seestadt Nord
  { kind: 'extend', line: '27', at: 's1636', stops: [{ station: 'z40-seenord', min: 3 }] },
  // 18 vom Stadion über die Hauptallee zum Praterstern
  { kind: 'extend', line: '18', at: 's842', stops: [{ station: 'z40-hauptallee', min: 3 }, { station: 's41', min: 3 }] },
  // 12 vom Nordbahnviertel über die Hauptallee zum Stadion
  { kind: 'extend', line: '12', at: 's1252', stops: [{ station: 'z40-hauptallee', min: 3 }, { station: 's842', min: 3 }] },
  // 29 neu: Dresdner Straße – Nordwestbahnhof – Am Tabor – Praterstern
  {
    kind: 'addLine',
    line: '29',
    mode: 'T',
    color: '#9e1b32',
    stops: [
      { station: 's1223', min: 0 },
      { station: 'z40-nwb', min: 3 },
      { station: 's1233', min: 2 },
      { station: 's41', min: 3 },
    ],
    service: every(8, 10, 10),
  },
];

export const ZIEL2040: NetworkPlan = {
  id: 'ziel2040',
  label: 'Zielnetz 2040',
  hint: 'Wien um 2040 (nicht genau): U5 und U2 zum Wienerberg, U1 Rothneusiedl, S45 bis Praterkai, S80/S45 und Stammstrecke im dichten Takt, S70 Simmering–Süßenbrunn, neue Bim 15 und 29, 12/18/25/27 verlängert.',
  inMenu: true,
  params: {},
  edits: ZIEL2040_EDITS,
};
