// Zielnetz 2040: wie oft ist die beste Strecke wegen des neuen Netzes anders oder schneller als heute? (Ziel ≥ 90 %)
// npm run check:future
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.STATE_DIR ??= mkdtempSync(path.join(tmpdir(), 'z40-'));
const { planStore } = await import('../server/plans.ts');
const { PlanRuntime } = await import('../server/planruntime.ts');
const { Network } = await import('../server/network.ts');
const { Game } = await import('../server/game.ts');
const { allChallenges, challengeContext } = await import('../shared/challenges.ts');
const { DEFAULT_SETTINGS } = await import('../shared/defaults.ts');
const { NET_MODES } = await import('../shared/rules.ts');
const base = Network.load();
const rt = new PlanRuntime(base, planStore(), () => ({ removed: [], added: [] }) as any);
// Netzplan in der Auswahl (wie am Server nach dem Laden der Konfiguration)
if (!NET_MODES.some((m: any) => m.id === 'plan:ziel2040')) NET_MODES.push({ id: 'plan:ziel2040', label: 'Zielnetz 2040', hint: '' } as any);
const c = allChallenges(challengeContext(true, true)).find((x) => x.id === 'future')!;
let n = 0, changed = 0, faster = 0, sum = 0;
for (let g = 0; g < 15; g++) {
  const game = new Game('Z' + g, (m: any) => (m === 'regular' ? base : rt.planNet(m.slice(5))!), { ...DEFAULT_SETTINGS, ...c.settings, challenge: c.id, rounds: 2 });
  const h = game.addPlayer('H');
  await game.start(h.token);
  // @ts-ignore
  for (const r of game.rounds) {
    await r.ready.catch(() => {});
    if (!r.routes) continue;
    n++;
    const best = r.routes[0];
    const lines = best.legs.filter((l: any) => l.mode !== 'W').map((l: any) => l.line.split('/')[0]).join('›');
    const now = r.today;
    const norm = (id: string) => (/^S[1-4]$/.test(id) ? 'S1-4' : id);
    const FUT = new Set(['U5', 'U2', 'S45', 'S80', 'S70', 'S60', 'S1-4', 'VK', '15', '25', '27', '12', '29', '33', 'GE', '21A', '10', 'O', '60']);
    const before = new Set((now?.lines ?? []).map(norm));
    const diff = !now || best.medianMin <= now.min - 2 || lines.split('›').map(norm).some((id: string) => FUT.has(id) && !before.has(id));
    if (diff) changed++;
    if (now && best.medianMin <= now.min - 2) (faster++, (sum += now.min - best.medianMin));
    console.log(`${r.from?.name} → ${r.to?.name}: 2040 ${lines} ${best.medianMin}′ · heute ${now ? now.lines.join('›') + ' ' + now.min + '′' : '(neue Station)'}${diff ? '' : '  ✗ gleich'}`);
  }
}
console.log(`\n${changed}/${n} anders oder schneller (${Math.round((changed / n) * 100)} %), ${faster} schneller (Ø ${(sum / Math.max(1, faster)).toFixed(1)} min)`);
process.exit(0);
