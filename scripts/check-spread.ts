// Verteilung der Tages-Challenges über Wien: jede Challenge 10× spielen (wie 10 Spiele hintereinander auf demselben
// Server) und prüfen, ob Start und Ziel über ganz Wien verteilt sind und sich die Spiele nicht wiederholen.
// npm run check:spread [ids,kommagetrennt] [spiele]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.STATE_DIR ??= mkdtempSync(path.join(tmpdir(), 'spread-'));
const { Network, cellOf } = await import('../server/network.ts');
const { Game } = await import('../server/game.ts');
const { allChallenges, districtChallenge, DISTRICT_GROUPS } = await import('../shared/challenges.ts');
const { DEFAULT_SETTINGS } = await import('../shared/defaults.ts');
const { distM } = await import('../shared/geo.ts');

const net = Network.load();
const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const PLAYS = Number(process.argv[3] ?? 10);

/** Gegenden Wiens (Bezirke) */
const REGIONS: { name: string; districts: number[] }[] = [
  { name: 'Zentrum', districts: [1, 4, 5, 6, 7, 8, 9] },
  { name: 'Innen', districts: [2, 3, 15, 16, 17, 18, 20] },
  { name: 'Süden', districts: [10, 11, 12, 23] },
  { name: 'Westen', districts: [13, 14, 19] },
  { name: 'Transd.', districts: [21, 22] },
];
const regionOf = (d: number) => REGIONS.findIndex((r) => r.districts.includes(d));
/**
 * zu ähnlich: Start und Ziel beide nah an einer früheren Runde (auch vertauscht) – 1,5 km, in kleinen Gebieten (Bezirk
 * des Tages, Ring-Runde) ein Sechstel des Gebiets
 */
const SIMILAR_M = 1500;

const ctx = { night: { id: 'sa02', time: '02:00' }, sunday: { id: 'su12', time: '12:00' }, current: false, addresses: true, water: true };
const list = [...allChallenges(ctx), ...DISTRICT_GROUPS.filter((g) => g.length > 1 || [1, 22].includes(g[0])).map((g) => districtChallenge(g, g.map(String)))];
console.log(`Spiele je Challenge: ${PLAYS} · Anteile Start+Ziel je Gegend: ${REGIONS.map((r) => r.name).join(' / ')} (erwartet laut Haltestellen-Fläche)\n`);
for (const c of list) {
  if (only && !only.includes(c.id)) continue;
  const settings = { ...DEFAULT_SETTINGS, ...c.settings, challenge: c.id };
  // erwartet: Felder mit passenden Haltestellen je Gegend (so zieht randomPair)
  const pool = settings.endpoints === 'addresses' ? [...net.stations.values()].filter((s) => s.lines.length) : net.candidates(settings.stations!, settings.slot!, settings.network!, settings.districts ?? null);
  const cells = new Map<string, number>();
  for (const s of pool) cells.set(cellOf(s), s.district);
  const expect = REGIONS.map((_, i) => [...cells.values()].filter((d) => regionOf(d) === i).length / cells.size);
  const seen = REGIONS.map(() => 0);
  let span = 0;
  // mit Fokus-Kreis (Ring-Runde): das Gebiet ist der Kreis
  if (settings.focus) span = 2 * settings.focus.radiusM;
  else for (const x of pool) for (const y of pool) span = Math.max(span, distM(x, y));
  const near = Math.min(SIMILAR_M, span / 6);
  let same = 0;
  const plays: { a: { lat: number; lon: number }; b: { lat: number; lon: number }; label: string }[] = [];
  let similar = 0;
  let failed = 0;
  const t = Date.now();
  for (let p = 0; p < PLAYS; p++) {
    const g = new Game(`S${c.id}${p}`, net, settings);
    const host = g.addPlayer('H');
    try {
      await g.start(host.token);
      // @ts-ignore – intern: die vorbereiteten Runden
      const rounds = g.rounds as any[];
      await Promise.allSettled(rounds.map((r) => r.ready));
      for (const [k, r] of rounds.entries()) {
        if (!r.from || !r.to) {
          failed++;
          continue;
        }
        const a = r.umland ? { lat: r.umland.lat, lon: r.umland.lon, district: 0 } : r.from;
        for (const s of [a, r.to]) if (s.district) seen[regionOf(s.district)]++;
        // jede Runde mit allen früheren Runden (auch anderer Spiele) vergleichen
        const close = (x: { lat: number; lon: number }, y: { lat: number; lon: number }, m: number) => distM(x, y) < m;
        if (plays.some((q) => (close(q.a, a, near) && close(q.b, r.to, near)) || (close(q.a, r.to, near) && close(q.b, a, near)))) similar++;
        if (plays.some((q) => (close(q.a, a, 50) && close(q.b, r.to, 50)) || (close(q.a, r.to, 50) && close(q.b, a, 50)))) same++;
        plays.push({ a, b: r.to, label: `${r.umland?.town ?? r.from.name} → ${r.to.name}${k ? '' : ''}` });
      }
    } catch (e) {
      failed++;
      console.log(`  ${c.id}: ${(e as Error).message}`);
    }
  }
  const total = seen.reduce((x, y) => x + y, 0) || 1;
  const share = seen.map((n) => n / total);
  // auffällig: eine Gegend mit nennenswertem Anteil an Haltestellen kommt kaum oder viel zu oft vor
  const off = REGIONS.map((r, i) => (expect[i] >= 0.12 && (share[i] < expect[i] * 0.4 || share[i] > expect[i] * 2.2) ? r.name : null)).filter(Boolean);
  const pct = (x: number) => String(Math.round(x * 100)).padStart(3);
  console.log(
    `${c.id.padEnd(14)} ${String(plays.length).padStart(3)} Runden ${String(Date.now() - t).padStart(6)} ms │ ${share.map(pct).join(' ')} │ erw. ${expect.map(pct).join(' ')} │ ähnlich ${similar} (${(near / 1000).toFixed(1)} km) · gleich ${same}${failed ? ` · ohne Strecke ${failed}` : ''}${off.length ? ` · ⚠ ${off.join(', ')}` : ''}`,
  );
  if (process.env.VERBOSE) for (const p of plays) console.log(`     ${p.label}`);
}
process.exit(0);
