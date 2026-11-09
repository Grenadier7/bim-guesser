// Netzplan „Zielnetz 2040“ (Tages-Challenge „Zielnetz 2040“): was es in Wien bis etwa 2040 geben könnte – nicht
// genau, sondern als spielbares Zukunftsnetz. Angelegt als eigener Netzplan (Admin → Netzpläne), dort änderbar.
// Grundlage: Wiener-Linien-/ÖBB-Ausbaupläne (U2/U5-Linienkreuz, S-Bahn-Ausbau, neue Bim-Strecken). Jede Linie bleibt auf
// ihrer Route – keine Äste. Neue Stationen heißen „z40-…“ (die Karte der Challenge hebt sie hervor).
import type { DayType, LineEdit, NetworkPlan, ServiceBand } from '../shared/types.ts';

/** Takt: Mo–Fr / Sa / So von früh bis Mitternacht */
const every = (wd: number, sa = wd, su = sa): Record<DayType, ServiceBand[]> => ({
  wd: [{ from: '05:00', to: '24:00', every: wd }],
  sa: [{ from: '05:30', to: '24:00', every: sa }],
  su: [{ from: '06:00', to: '24:00', every: su }],
});
/** Takt einer bestehenden Linie (alle Tage, ganzer Betriebstag) – die Hauptfahrt je Richtung, Kurzführungen entfallen */
const takt = (line: string, wd: number, we: number): LineEdit[] => [
  { kind: 'headway', line, day: 'wd', from: '05:00', to: '24:00', every: wd },
  { kind: 'headway', line, day: 'sa', from: '05:30', to: '24:00', every: we },
  { kind: 'headway', line, day: 'su', from: '06:00', to: '24:00', every: we },
];
/** Takt tagsüber (abends bleibt der heutige Fahrplan) */
const taktTags = (line: string, wd: number, we: number): LineEdit[] => [
  { kind: 'headway', line, day: 'wd', from: '06:00', to: '20:00', every: wd },
  { kind: 'headway', line, day: 'sa', from: '08:00', to: '20:00', every: we },
  { kind: 'headway', line, day: 'su', from: '09:00', to: '20:00', every: we },
];
const station = (station: string, name: string, lat: number, lon: number, district: number): LineEdit => ({ kind: 'addStation', station, name, lat, lon, district });
/** Halte der Reihe nach, `min` = Fahrzeit ab dem vorigen */
const stops = (...list: [string, number][]) => list.map(([s, min]) => ({ station: s, min }));
/** Linie hält dazwischen nicht mehr (fährt durch) */
const skip = (line: string, ...ids: string[]): LineEdit[] => ids.map((s) => ({ kind: 'skipStop', line, station: s }));
const insert = (line: string, a: string, b: string, s: string, minA: number, minB: number): LineEdit => ({ kind: 'insertStop', line, a, b, station: s, minA, minB });

// Stationen im Netz (IDs aus data/network.json)
const S = {
  hillerstr: 's1252',
  elderschpl: 's994',
  krieau: 's841',
  sturgasse: 's1699',
  pwhPrater: 's1464',
  natterer: 's901',
  stadion: 's842',
  wallensteinpl: 's432',
  brigittapl: 's685',
  jaegerstr: 's648',
  hoechstaedtpl: 's1299',
  dresdnerStr: 's1223',
  traisengasse: 's374',
  rauscherstr: 's77',
  heiligenstadt: 's1215',
  handelskai: 's691',
  donaumarina: 's1003',
  praterkai: 's295',
  praterstern: 's41',
  muehlfeldgasse: 's1623',
  nordbahnstr: 's1667',
  amTabor: 's1233',
  lorenzMueller: 's647',
  muthgasse: 's1621',
  gunoldstr: 's1162',
  oberdorfstr: 's614',
  siegespl: 's247',
  kutschera: 's335',
  asperNord: 's1636',
  siebeckstr: 's953',
  donaustadtstr: 's952',
  kagranerBr: 's1361',
  arminenstr: 's1540',
  bernoullistr: 's333',
  haeusslergasse: 's1298',
  prandaugasse: 's721',
  baumannGasse: 's1337',
  carminweg: 's926',
  fultonstr: 's1092',
  kagran: 's1358',
  polgarstr: 's33',
  erzherzogKarl: 's1008',
  dornbach: 's1175',
  hernals: 's1228',
  dillenz: 's893',
  seestadt: 's1668',
  touaillon: 's47',
  lannesstr: 's1482',
  altesLandgut: 's1052',
  daumegasse: 's1017',
  grenzackerstr: 's1490',
  raxstr: 's78',
  gussriegelstr: 's1171',
  fadingerPl: 's305',
  altdorferstr: 's1025',
  gzSued: 's1259',
  eibesbrunner: 's984',
  wienerbergbr: 's466',
  meidling: 's16',
  doerfelstr: 's1592',
  speising: 's1728',
  atzgersdorferStr: 's1685',
  usvVerbindungsbahn: 's412',
  huetteldorf: 's1290',
  liesing: 's1517',
  rodaun: 's106',
  grillgasse: 's257',
  zentralfriedhof: 's509',
  josefstaedterStr: 's1346',
  albertgasse: 's847',
  florianigasse: 's1056',
  laudongasse: 's1483',
  langeGasse: 's1477',
  lazarettgasse: 's1491',
  spitalgasse: 's286',
  alserbachstr: 's1010',
  fjb: 's1067',
  friedensbr: 's1079',
  klosterneuburgerStr: 's433',
  engelsPl: 's1086',
} as const;
/** S60 fährt hinter Grillgasse nach Kledering (außerhalb des Spielnetzes – Fahrplan-ID) */
const KLEDERING = 'at:43:3895';

/** 26A-Strecke ab Erzherzog-Karl-Straße bis Eßling – die Linie GE übernimmt sie */
const GE_EAST: [string, number][] = [
  ['s1431', 1], // Konstanziagasse
  ['s1201', 2], // Hartlebengasse
  ['s528', 1], // Zschokkegasse
  ['s1023', 2], // Aspernstraße
  ['s1683', 1], // Haberlandtgasse
  ['s247', 2], // Siegesplatz
  ['s1542', 1], // Lohwaggasse
  ['s144', 2], // Saltenstraße
  ['s1059', 1], // Flugfeldstraße
  ['s1482', 2], // Lannesstraße
  ['s1410', 1], // Kirschenallee
  ['s1021', 2], // Eßling Schule
  ['s643', 1], // Seefeldergasse
  ['s27', 2], // Podlahagasse
  ['s1002', 1], // Englisch-Feld-Gasse
  ['s1165', 2], // Eßling, Stadtgrenze
];

export const ZIEL2040_EDITS: LineEdit[] = [
  // ---- neue Stationen
  station('z40-arne', 'Arne-Karlsson-Park', 48.2183, 16.3478, 9),
  station('z40-frankh', 'Frankhplatz', 48.214, 16.3521, 9),
  station('z40-reinp', 'Reinprechtsdorfer Straße', 48.1857, 16.3555, 5),
  station('z40-wbg', 'Wienerberg', 48.1695, 16.3445, 10),
  // S70 auf der Strecke Stadlau–Süßenbrunn und der neue 21A
  station('z40-ostbahnweg', 'Ostbahnweg', 48.237076, 16.45621, 22),
  station('z40-gewerbepark', 'Gewerbepark Stadlau S', 48.246015, 16.460779, 22),
  station('z40-perco', 'Percostraße', 48.260972, 16.467996, 22),
  station('z40-rugier', 'Rugierstraße', 48.238286, 16.453985, 22),
  station('z40-pogrelz', 'Pogrelzstraße', 48.239001, 16.451798, 22),
  station('z40-duesseldorf', 'Düsseldorfstraße', 48.240035, 16.44404, 22),
  station('z40-brigittenau', 'Brigittenau', 48.248181, 16.379623, 20),
  station('z40-reichsbr', 'Reichsbrücke S', 48.225917, 16.405271, 2),
  station('z40-nwb', 'Nordwestbahnsiedlung', 48.232328, 16.380645, 20),
  station('z40-pilot', 'Pilotengasse', 48.219203, 16.493274, 22),
  station('z40-enzian', 'Enzianweg', 48.222567, 16.494453, 22),
  station('z40-yella', 'Yella-Hertzka-Park', 48.227449, 16.500794, 22),
  station('z40-see', 'Asperner See', 48.228994, 16.50545, 22),
  station('z40-veil', 'Simone-Veil-Gasse', 48.248017, 16.423123, 22),
  station('z40-schanze', 'An der Schanze', 48.248498, 16.417786, 21),
  station('z40-muehlschuettel', 'Mühlschüttelgasse', 48.249913, 16.411257, 21),
  // Kaltenleutgebner Bahn (VK) – Lage entlang der Strecke geschätzt
  station('z40-hochstr', 'Hochstraße', 48.1302, 16.259, 23),
  station('z40-sonnberg', 'Sonnbergstraße', 48.1312, 16.252, 23),
  station('z40-zugberg', 'Zugbergsteg', 48.1316, 16.245, 23),
  station('z40-kammerstein', 'Abzweigung Kammerstein', 48.1305, 16.237, 23),
  station('z40-waldmuehle', 'Rodaun Waldmühle', 48.1268, 16.226, 23),

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

  // ---- S-Bahn
  // S45: neuer Halt Brigittenau; über Handelskai hinaus über Reichsbrücke und Donaumarina bis Praterkai – mit der S80
  // ein Ring um die Stadt
  insert('S45', S.heiligenstadt, S.handelskai, 'z40-brigittenau', 2, 2),
  { kind: 'extend', line: 'S45', at: S.handelskai, stops: stops(['z40-reichsbr', 3], [S.donaumarina, 3], [S.praterkai, 2]) },
  ...takt('S45', 5, 7),
  // S80: auf der Verbindungsbahn zusätzlich Atzgersdorfer Straße und Unter St. Veit
  insert('S80', S.meidling, S.speising, S.atzgersdorferStr, 2, 2),
  insert('S80', S.speising, S.huetteldorf, S.usvVerbindungsbahn, 2, 3),
  ...takt('S80', 10, 15),
  // S60 hält am Zentralfriedhof
  insert('S60', S.grillgasse, KLEDERING, S.zentralfriedhof, 2, 2),
  // Stammstrecke: jede Linie alle 15 Minuten (zusammen etwa alle 3–4 Minuten)
  ...takt('S1', 15, 15),
  ...takt('S2', 15, 30),
  ...takt('S3', 15, 30),
  ...takt('S4', 15, 30),
  // S70 neu: Simmering – Stadlau – Erzherzog-Karl-Straße auf den Gleisen der S80, dann auf der bestehenden Strecke
  // (Stadlau–Süßenbrunn, westlich der A23) über Ostbahnweg, Gewerbepark Stadlau und Percostraße nach Süßenbrunn
  {
    kind: 'addLine',
    line: 'S70',
    mode: 'S',
    color: '#1e6fbf',
    stops: [
      { station: 's260', min: 0 },
      { station: 's1189', min: 2 },
      { station: 's295', min: 3 },
      { station: 's292', min: 3 },
      { station: 's1008', min: 2 },
      { station: 'z40-ostbahnweg', min: 2 },
      { station: 'z40-gewerbepark', min: 2 },
      { station: 'z40-perco', min: 2 },
      { station: 's346', min: 3 },
    ],
    service: every(15, 30, 30),
  },
  // 28A hält zusätzlich an der Percostraße (S70)
  insert('28A', 's657', 's123', 'z40-perco', 1, 1),
  // 21A neu: von der S70 (Ostbahnweg) über Kagraner Anger und Bernoullistraße nach Kagran
  {
    kind: 'addLine',
    line: '21A',
    mode: 'B',
    color: '#0a295d',
    stops: stops(
      ['z40-ostbahnweg', 0],
      ['z40-rugier', 1],
      ['z40-pogrelz', 1],
      ['s1360', 1],
      ['z40-duesseldorf', 1],
      [S.bernoullistr, 2],
      [S.siebeckstr, 1],
      [S.kagran, 2],
    ),
    service: every(10, 15, 15),
  },
  // VK neu: Lokalbahn auf der Kaltenleutgebner Bahn – Liesing, durch Perchtoldsdorf (3 Halte, nur als Fahrzeit), dann
  // in Wien über Hochstraße bis zur Waldmühle in Rodaun
  {
    kind: 'addLine',
    line: 'VK',
    mode: 'T',
    color: '#2b4c9b',
    stops: stops([S.liesing, 0], ['z40-hochstr', 9], ['z40-sonnberg', 2], ['z40-zugberg', 2], ['z40-kammerstein', 2], ['z40-waldmuehle', 2]),
    service: every(15, 30, 30),
  },

  // ---- Straßenbahn
  // 12: zwischen Wallensteinplatz und Traisengasse über Rauscherstraße und die Nordwestbahnsiedlung; ab Hillerstraße
  // weiter über die Krieau zum Stadion
  ...skip('12', S.brigittapl, S.jaegerstr, S.hoechstaedtpl, S.dresdnerStr),
  insert('12', S.wallensteinpl, S.traisengasse, S.rauscherstr, 2, 3),
  insert('12', S.rauscherstr, S.traisengasse, 'z40-nwb', 2, 2),
  {
    kind: 'extend',
    line: '12',
    at: S.hillerstr,
    stops: stops([S.elderschpl, 2], [S.krieau, 1], [S.sturgasse, 1], [S.pwhPrater, 1], [S.natterer, 2], [S.stadion, 1]),
  },
  // 33 wieder: Josefstädter Straße – Brigittaplatz – Höchstädtplatz – Friedrich-Engels-Platz (die alte Strecke der 12)
  {
    kind: 'addLine',
    line: '33',
    mode: 'T',
    color: '#9e1b32',
    stops: stops(
      [S.josefstaedterStr, 0],
      [S.albertgasse, 2],
      [S.florianigasse, 2],
      [S.laudongasse, 1],
      [S.langeGasse, 2],
      [S.lazarettgasse, 1],
      [S.spitalgasse, 2],
      [S.alserbachstr, 2],
      [S.fjb, 2],
      [S.friedensbr, 2],
      [S.klosterneuburgerStr, 1],
      [S.wallensteinpl, 1],
      [S.brigittapl, 2],
      [S.jaegerstr, 1],
      [S.hoechstaedtpl, 2],
      [S.engelsPl, 2],
    ),
    service: every(10, 12, 12),
  },
  // 29 neu: Praterstern – Nordbahnviertel – Am Tabor – Nordwestbahnsiedlung – Traisengasse – Höchstädtplatz – Heiligenstadt
  {
    kind: 'addLine',
    line: '29',
    mode: 'T',
    color: '#9e1b32',
    stops: stops(
      [S.praterstern, 0],
      [S.muehlfeldgasse, 2],
      [S.nordbahnstr, 1],
      [S.amTabor, 2],
      [S.rauscherstr, 3],
      ['z40-nwb', 2],
      [S.traisengasse, 2],
      [S.dresdnerStr, 2],
      [S.hoechstaedtpl, 1],
      [S.lorenzMueller, 1],
      [S.muthgasse, 2],
      [S.gunoldstr, 2],
      [S.heiligenstadt, 2],
    ),
    service: every(8, 10, 10),
  },
  // 5B fährt seltener (die 29 übernimmt viel davon)
  ...takt('5B', 15, 20),
  // 25: zwischen Prandaugasse und Fultonstraße neu durch die Siedlungen an der Alten Donau, zwischen Donaustadtstraße
  // und Siebeckstraße über Häußlergasse und Bernoullistraße, von Aspern, Oberdorfstraße weiter über Siegesplatz und
  // Johann-Kutschera-Gasse nach Aspern Nord
  ...skip('25', S.baumannGasse, S.carminweg),
  insert('25', S.prandaugasse, S.fultonstr, 'z40-veil', 2, 4),
  insert('25', 'z40-veil', S.fultonstr, 'z40-schanze', 1, 3),
  insert('25', 'z40-schanze', S.fultonstr, 'z40-muehlschuettel', 2, 1),
  ...skip('25', S.kagranerBr, S.arminenstr),
  insert('25', S.donaustadtstr, S.siebeckstr, S.haeusslergasse, 2, 2),
  insert('25', S.haeusslergasse, S.siebeckstr, S.bernoullistr, 1, 1),
  {
    kind: 'extend',
    line: '25',
    at: S.oberdorfstr,
    stops: stops([S.siegespl, 2], ['z40-pilot', 2], ['z40-enzian', 1], [S.kutschera, 2], ['z40-yella', 2], ['z40-see', 1], [S.asperNord, 2]),
  },
  // GE neu: Kagran – Kagraner Brücke – Erzherzog-Karl-Straße und dann die ganze Strecke des 26A bis Eßling
  {
    kind: 'addLine',
    line: 'GE',
    mode: 'T',
    color: '#2b4c9b',
    stops: stops([S.kagran, 0], [S.kagranerBr, 2], [S.arminenstr, 1], [S.donaustadtstr, 2], [S.polgarstr, 1], [S.erzherzogKarl, 2], ...GE_EAST),
    service: every(8, 10, 10),
  },
  { kind: 'removeLine', line: '26A' },
  // 27: von Aspern Nord weiter durch die Seestadt bis Lannesstraße
  { kind: 'extend', line: '27', at: S.asperNord, stops: stops([S.dillenz, 2], [S.seestadt, 2], [S.touaillon, 2], [S.lannesstr, 2]) },
  // … und tagsüber etwas dichter
  ...taktTags('27', 7, 8),
  // 10: von Dornbach weiter nach Hernals (U5, S45)
  { kind: 'extend', line: '10', at: S.dornbach, stops: stops([S.hernals, 3]) },
  // 15 neu: Altes Landgut – Raxstraße – Stefan-Fadinger-Platz – Gesundheitszentrum Süd – Wienerbergbrücke – Meidling
  {
    kind: 'addLine',
    line: '15',
    mode: 'T',
    color: '#9e1b32',
    stops: stops(
      [S.altesLandgut, 0],
      [S.daumegasse, 2],
      [S.grenzackerstr, 1],
      [S.raxstr, 1],
      [S.gussriegelstr, 1],
      [S.fadingerPl, 1],
      [S.altdorferstr, 1],
      [S.gzSued, 1],
      [S.eibesbrunner, 2],
      [S.wienerbergbr, 2],
      [S.meidling, 2],
      [S.doerfelstr, 1],
    ),
    service: every(6, 8, 8),
  },
  // 15A fährt viel seltener – die 15 übernimmt die Strecke Altes Landgut – Eibesbrunnergasse
  ...takt('15A', 20, 30),
  // O: von Raxstraße weiter über Gußriegelstraße zum Stefan-Fadinger-Platz
  { kind: 'extend', line: 'O', at: S.raxstr, stops: stops([S.gussriegelstr, 2], [S.fadingerPl, 1]) },
  // 60: von Rodaun weiter zur Hochstraße (VK)
  { kind: 'extend', line: '60', at: S.rodaun, stops: stops(['z40-hochstr', 2]) },
  // 30 und 31 tagsüber etwas dichter
  ...taktTags('30', 5, 8),
  ...taktTags('31', 5, 8),
];

export const ZIEL2040: NetworkPlan = {
  id: 'ziel2040',
  label: 'Zielnetz 2040',
  hint:
    'Wien um 2040 (nicht genau): U5 und U2 zum Wienerberg; S45 mit Halt Brigittenau über Reichsbrücke und Donaumarina bis Praterkai, ' +
    'S80 mit mehr Halten auf der Verbindungsbahn, S60 am Zentralfriedhof, Stammstrecke im dichten Takt, S70 Simmering–Stadlau–Süßenbrunn, ' +
    'Lokalbahn VK nach Rodaun; neue Bim 15, 29, 33 und GE (statt 26A), 12 über die Nordwestbahnsiedlung zum Stadion, 25 durch die Seestadt, ' +
    '10, 27, 60 und O verlängert.',
  inMenu: true,
  params: {},
  edits: ZIEL2040_EDITS,
};
