// Prüft jede Tages-Challenge mit dem echten Fahrplan: findet die Rundenvorbereitung Strecken? (z.B. nach einem
// Fahrplan-Update) – npm run check:challenges [ids,kommagetrennt] [runden]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.STATE_DIR ??= mkdtempSync(path.join(tmpdir(), 'feas-'));
const { Network } = await import('../server/network.ts');
const { Game } = await import('../server/game.ts');
const { allChallenges } = await import('../shared/challenges.ts');
const { DEFAULT_SETTINGS } = await import('../shared/defaults.ts');
const net = Network.load();
const only = process.argv[2] ? process.argv[2].split(',') : null;
const n = Number(process.argv[3] ?? 3);
for (const c of allChallenges({ night: { id: 'sa02', time: '02:00' }, sunday: { id: 'su12', time: '12:00' }, current: false, addresses: true, water: true })) {
  if (only && !only.includes(c.id)) continue;
  const patch = c.settings;
  const base: Record<string, unknown> = { ...DEFAULT_SETTINGS, focus: null };
  if (patch.difficulty) for (const k of ['stations', 'distance', 'minTransfers']) delete base[k];
  const g = new Game('F' + c.id, net, { ...base, ...patch, challenge: c.id, rounds: n });
  const host = g.addPlayer('H');
  const t = Date.now();
  let out = '';
  try {
    await g.start(host.token);
    // @ts-ignore
    const rs = await Promise.allSettled(g.rounds.map((r) => r.ready));
    const bad = rs.filter((r) => r.status === 'rejected').length;
    // @ts-ignore
    const r0 = g.rounds[0];
    const best = r0.routes?.[0];
    out = bad ? `${bad}/${n} ohne Strecke: ${(rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason?.message}` : `ok – ${r0.from?.name} → ${r0.to?.name}${r0.entryTown ? ` (${r0.entryTown})` : ''}${r0.required?.length ? ` [${r0.required}]` : ''}: ${best?.legs.filter((l: any) => l.mode !== 'W').map((l: any) => l.line).join('›')} ${best?.medianMin}′`;
  } catch (e) {
    out = 'FEHLER ' + (e as Error).message;
  }
  console.log(`${c.id.padEnd(11)} ${String(Date.now() - t).padStart(6)} ms  ${out}`);
}
process.exit(0);
