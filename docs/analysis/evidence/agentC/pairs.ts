const R = 'file:///D:/files/!workingDIR/Zuhause_Dateien/verbindungs_guesser/';
const { Network, distM } = await import(R + 'server/network.ts');
const { DEFAULT_SETTINGS } = await import(R + 'shared/rules.ts');
const net = Network.load();

function run(label: string, over: any, rounds = 10, reps = 30) {
  const s = { ...DEFAULT_SETTINGS, ...over };
  let fails = 0, firstFailRound: number[] = [];
  const t0 = performance.now();
  const pool = net.candidates(s.stations, s.slot, s.network);
  for (let r = 0; r < reps; r++) {
    const used = new Set<string>();
    const past: any[] = [];
    for (let i = 0; i < rounds; i++) {
      try {
        const [a, b] = net.randomPair(s, used, past);
        used.add(a.id).add(b.id);
        past.push({ a, b });
      } catch (e) {
        fails++; firstFailRound.push(i); break;
      }
    }
  }
  console.log(label, 'pool', pool.length, 'fails', fails, '/', reps, 'failRounds', firstFailRound.slice(0, 8).join(','), 'ms', (performance.now() - t0).toFixed(0));
}
const stephansplatz = { lat: 48.2085, lon: 16.3731 };
const edge = { lat: 48.27, lon: 16.45 }; // Nordost-Rand
run('default', {});
run('Ukey short', { stations: ['Ukey'], distance: 'short' });
run('Skey long', { stations: ['Skey'], distance: 'long' });
run('night Skey', { stations: ['Skey'], slot: 'sa02' });
run('night Tkey long', { stations: ['Tkey'], slot: 'sa02', distance: 'long' });
run('focus1500 Ukey long share0.9', { stations: ['Ukey'], distance: 'long', focus: { ...stephansplatz, radiusM: 1500, share: 0.9 } });
run('focus1500 edge Skey long 0.9', { stations: ['Skey'], distance: 'long', focus: { ...edge, radiusM: 1500, share: 0.9 } });
run('focus1500 edge all short 0.9', { stations: ['all'], distance: 'short', focus: { ...edge, radiusM: 1500, share: 0.9 } });
run('Ukey long 10 rounds', { stations: ['Ukey'], distance: 'long' }, 10);
run('Skey night long', { stations: ['Skey'], slot: 'sa02', distance: 'long' }, 10);
// focus share effect: fraction of stations in circle
{
  const s = { ...DEFAULT_SETTINGS, stations: ['U','S'], distance: 'medium', focus: { ...stephansplatz, radiusM: 1500, share: 0.9 } };
  let inside = 0, n = 0;
  for (let i = 0; i < 2000; i++) { const [a, b] = net.randomPair(s, new Set(), []); for (const x of [a, b]) { n++; if (distM(x, s.focus) <= 1500) inside++; } }
  console.log('focus share 0.9 r1500 medium -> inside fraction', (inside / n).toFixed(2));
}
// distance distribution check
{
  const s = { ...DEFAULT_SETTINGS };
  const ds: number[] = [];
  for (let i = 0; i < 2000; i++) { const [a, b] = net.randomPair(s, new Set(), []); ds.push(distM(a, b)); }
  ds.sort((x, y) => x - y);
  console.log('medium dist quantiles', [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => Math.round(ds[Math.floor(q * ds.length)])).join(' '));
}
// resolve() perf (falls through to full scan)
{
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) net.resolve({ id: 'x' + i, name: 'Nirgendwo ' + i, place: '', lat: 48.2 + i * 1e-5, lon: 16.37 });
  console.log('resolve miss x2000 ms', (performance.now() - t0).toFixed(1));
}
// station ids in efaIds shared by multiple stations?
{
  const seen = new Map<string, string[]>();
  for (const [sid, ids] of Object.entries(net.data.efaIds) as [string, string[]][]) for (const id of ids) seen.set(id, [...(seen.get(id) ?? []), sid]);
  const dup = [...seen].filter(([, v]) => v.length > 1);
  console.log('efa ids mapped to >1 station', dup.length, dup.slice(0, 3));
}
