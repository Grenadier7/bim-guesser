const R = 'file:///D:/files/!workingDIR/Zuhause_Dateien/verbindungs_guesser/';
const { Network } = await import(R + 'server/network.ts');
const { DEFAULT_SETTINGS, STATION_KINDS } = await import(R + 'shared/rules.ts');
const net = Network.load();
const kinds = STATION_KINDS.map((k: any) => k.id);
const res: [number, string][] = [];
for (const k of kinds) for (const slot of ['wd12', 'sa02']) for (const nm of ['regular', 'current']) res.push([net.candidates([k], slot, nm).length, `${k} ${slot} ${nm}`]);
res.sort((a, b) => a[0] - b[0]);
console.log(res.slice(0, 8));
// worst: smallest pool, long distance, 10 rounds
for (const [n, label] of res.slice(0, 4)) {
  const [k, slot, nm] = label.split(' ');
  for (const distance of ['short', 'medium', 'long']) {
    let fails = 0, errs = new Set<string>();
    for (let r = 0; r < 20; r++) {
      const used = new Set<string>(); const past: any[] = [];
      for (let i = 0; i < 10; i++) {
        try { const [a, b] = net.randomPair({ ...DEFAULT_SETTINGS, stations: [k], slot, network: nm, distance }, used, past); used.add(a.id).add(b.id); past.push({ a, b }); }
        catch (e) { fails++; errs.add(`${(e as Error).constructor.name}: ${(e as Error).message} @round ${i}`); break; }
      }
    }
    console.log(label, distance, 'pool', n, 'fails', fails, [...errs].slice(0, 2));
  }
}
// Empty pool behaviour
try { net.randomPair({ ...DEFAULT_SETTINGS, stations: ['Skey'], slot: 'sa02' }, new Set(net.candidates(['Skey'], 'sa02', 'regular').map((s: any) => s.id)), []); } catch (e) { console.log('empty pool ->', (e as Error).constructor.name, (e as Error).message); }
