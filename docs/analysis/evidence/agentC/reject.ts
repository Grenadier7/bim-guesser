const R = 'file:///D:/files/!workingDIR/Zuhause_Dateien/verbindungs_guesser/';
let calls = 0;
globalThis.fetch = (async () => { calls++; throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as any;
const { Network } = await import(R + 'server/network.ts');
const routing = await import(R + 'server/routing.ts');
const net = Network.load();
const u1 = net.lines.get('U1')!;
const p = u1.patterns[0];
const legs = [{ line: 'U1', from: p[2], to: p[6] }];
const t0 = Date.now();
try {
  const r = await routing.evaluateUserRoute(net, legs, p[2], p[6], 29700000, 'regular', { countWait: true, avgWait: true, restriction: null }, []);
  console.log('resolved', r);
} catch (e) {
  console.log('evaluateUserRoute REJECTS:', (e as Error).message, 'fetch calls', calls, 'ms', Date.now() - t0);
}
// topRoutes with all failing
try { await routing.topRoutes(net, p[2], p[6], 29700000, { countWait: true, avgWait: true, restriction: null }); } catch (e) { console.log('topRoutes:', (e as Error).constructor.name, (e as Error).message, 'calls', calls); }
// validateLegs edge cases
console.log('same from/to', routing.validateLegs(net, [{ line: 'U1', from: p[2], to: p[2] }], 'regular', null));
console.log('wrong dir ok (both dirs exist)', routing.validateLegs(net, [{ line: 'U1', from: p[6], to: p[2] }], 'regular', null));
console.log('unknown station', routing.validateLegs(net, [{ line: 'U1', from: 'sX', to: p[2] }], 'regular', null));
console.log('disconnected legs accepted', routing.validateLegs(net, [{ line: 'U1', from: p[2], to: p[3] }, { line: 'U1', from: p[10], to: p[12] }], 'regular', null));
console.log('not array', routing.validateLegs(net, null as any, 'regular', null));
// one-directional lines?
let oneWay = 0;
for (const l of net.lines.values()) { const sets = l.patterns.map((q: string[]) => q[0] + '>' + q[q.length - 1]); if (!l.patterns.some((q: string[]) => l.patterns.some((r: string[]) => r[0] === q[q.length - 1]))) oneWay++; }
console.log('lines w/o reverse pattern', oneWay);
// loop patterns: station appearing twice
let loops = 0;
for (const l of net.lines.values()) for (const q of l.patterns) if (new Set(q).size !== q.length) { loops++; break; }
console.log('lines with repeated station in pattern', loops);
