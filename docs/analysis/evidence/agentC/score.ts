const R = 'file:///D:/files/!workingDIR/Zuhause_Dateien/verbindungs_guesser/';
const rules = await import(R + 'shared/rules.ts');
const { scoreRoute, computeScore, tipShareOf, tipShare, difficultyMultiplier, timeBonus, routeCost, maxRoundPoints, DEFAULT_SETTINGS, STATION_KINDS, DISTANCES } = rules;
const { expectedWait } = await import(R + 'server/routing.ts');
const ts = await import(R + 'server/timeslots.ts');

console.log('scoreRoute');
for (const [u, b] of [[30,30],[31,30],[31.2,30],[32,30],[38,30],[45,30],[51,30],[52,30],[29,30],[27,30],[24,30],[0,30],[5,5],[6,5],[4,5],[0,0],[1,0],[10,0],[-5,30],[NaN,30],[30,NaN],[Infinity,30]]) console.log(u, b, scoreRoute(u, b));
// monotonic?
let prev = Infinity, viol = 0;
for (let u = 0; u <= 100; u += 0.25) { const s = scoreRoute(u, 30); if (s > prev) viol++; prev = s; }
console.log('monotonic violations', viol);
// continuity at best: 29.99 vs 30
console.log('29.99', scoreRoute(29.99, 30), '30', scoreRoute(30, 30));
console.log('tips cheap', ['startLines','transfers'].map(k=>tipShare(k,'cheap')), tipShareOf(['startLines','endLines'],'cheap'), tipShareOf(['startLines','endLines','modeChain','transfers'],'cheap'), tipShareOf(['startLines','endLines','modeChain','transfers'],'expensive'));
console.log('tips off level', tipShareOf(['startLines'],'off'));
console.log('dup tips', tipShareOf(['startLines','startLines'],'cheap'));
console.log('timeBonus', timeBonus(1000, 0, null), timeBonus(1000, 90, null), timeBonus(1000, 200, null), timeBonus(1000, 0, 180), timeBonus(1000, -10, 180));
const cs = computeScore({ routePoints: 1300, tips: [], elapsedSec: 0, limitSec: 180, locateDist: { from: 0, to: 0 }, multiplier: difficultyMultiplier({ stations: ['U','S','T','all'], distance: 'long', minTransfers: 2 }) });
console.log('max possible', cs, 'maxRoundPoints', maxRoundPoints({ ...DEFAULT_SETTINGS, stations: ['U','S','T','all'], distance: 'long', minTransfers: 2, locate: true }));
console.log('mult range', difficultyMultiplier({ stations: ['Ukey'], distance: 'short', minTransfers: 0 }), difficultyMultiplier({ stations: [], distance: 'short', minTransfers: 0 }), difficultyMultiplier({ stations: ['U','S','T','all'], distance: 'long', minTransfers: 2 }));
console.log('routeCost', routeCost(30, 2, { goal: 'best', avgWait: true }), routeCost(30, 2, { goal: 'best', avgWait: false }), routeCost(30, 2, { goal: 'fastest', avgWait: true }));

console.log('expectedWait');
console.log(expectedWait([10, 20], 0, 60), expectedWait([0], 0, 60), expectedWait([5,5,5], 0, 10), expectedWait([10], 0.5, 60), expectedWait([0, 60], 0, 60), expectedWait([30], 0, 0));
// performance: 200 deps, find per minute
let t0 = performance.now();
const deps = Array.from({ length: 200 }, (_, i) => i * 1);
for (let i = 0; i < 10000; i++) expectedWait(deps, 0);
console.log('ew perf ms/10k', (performance.now() - t0).toFixed(1));

console.log('holidays/timeslots');
const d = (s: string) => new Date(s + 'T00:00:00Z');
for (const s of ['2026-04-06','2026-05-14','2026-05-25','2026-06-04','2026-04-03','2026-12-24','2027-03-29','2027-05-06','2027-05-17','2027-05-27','2027-05-18','2027-10-27','2026-06-30','2026-06-27','2026-06-28'])
  console.log(s, ['Mo','Di','Mi','Do','Fr','Sa','So'][(d(s).getUTCDay()+6)%7], 'hol', ts.isHoliday(d(s)), 'school', ts.isSchoolHoliday(d(s)), 'typWd', ts.isTypicalDay(d(s),'wd'));
console.log('nextTypicalDay from local midnight-ish', ts.nextTypicalDay('wd', new Date('2026-10-19T23:30:00+02:00')).toISOString(), ts.nextTypicalDay('wd', new Date('2026-10-20T00:30:00+02:00')).toISOString());
console.log('slot', ts.describeSlotDate(ts.slotTime('sa02','regular',{wd:{date:'2026-06-30'},sa:{date:'2026-06-27'},su:{date:'2026-06-28'}} as any)));
console.log('TZ', Intl.DateTimeFormat().resolvedOptions().timeZone);
