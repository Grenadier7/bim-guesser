const R = 'file:///D:/files/!workingDIR/Zuhause_Dateien/verbindungs_guesser/';
const { computeScore, locatePoints } = await import(R + 'shared/rules.ts');
const { expectedWait } = await import(R + 'server/routing.ts');
console.log(computeScore({ routePoints: 556, tips: ['startLines'], elapsedSec: 90, limitSec: 180, locateDist: { from: 250, to: 1625 }, multiplier: 1.05, tipLevel: 'cheap' }));
console.log('loc', locatePoints(250), locatePoints(1625), locatePoints(3000), locatePoints(0));
for (const H of [4, 5, 10, 15, 30]) console.log('H', H, 'ew', expectedWait(Array.from({ length: 200 }, (_, i) => i * H), 0), 'every', Math.round(expectedWait(Array.from({ length: 200 }, (_, i) => i * H), 0)! * 2));
