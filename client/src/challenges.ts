// Tages-Challenges im Browser: die heutigen (3 + Bezirk der Woche) mit den Uhrzeiten/Wertungen dieses Spiels,
// und das Fenster beim Spielstart („Heute: ☕ Kaffeepause …“).
import {
  DISTRICT_GROUPS,
  allChallenges,
  challengeContext,
  dailyChallenges,
  districtChallenge,
  districtGroupId,
  districtOfDay,
  type Challenge,
  type ChallengeContext,
  type Schedule,
} from '../../shared/challenges.ts';
import { viennaDay } from '../../shared/career.ts';
import { app } from './store.ts';
import type { NetIndex } from './net.ts';
import type { RuleNet } from '../../shared/challengeRules.ts';
import type { WaterData } from '../../shared/water.ts';
import { bridgeIndex, bridgesAlong, type BridgeData } from '../../shared/bridges.ts';
import { esc, h } from './ui.ts';

// Gewässer-Daten liegen dem Spiel bei (data/water.json)
const context = (): ChallengeContext => challengeContext((app.net?.data.addressCount ?? 0) > 0, true);

/** vom Server berechneter Plan (sonst rechnet der Browser denselben selbst) */
let schedule: Schedule | null = null;
export function loadSchedule(): Promise<void> {
  return fetch('/api/challenges/schedule')
    .then((r) => (r.ok ? (r.json() as Promise<Schedule>) : null))
    .then((s) => void (schedule = s))
    .catch(() => {});
}

/** Mittelpunkt eines Bezirks = Schwerpunkt seiner Haltestellen (Fokus-Kreis in der Lobby) */
export function districtCenter(id: number): [number, number] {
  const sts = app.net.data.stations.filter((x) => x.district === id);
  return [sts.reduce((a, x) => a + x.lat, 0) / sts.length, sts.reduce((a, x) => a + x.lon, 0) / sts.length];
}

/** Bezirksgruppe als Challenge (Namen aus den Netzdaten) */
function districtOf(group: number[]): Challenge {
  return districtChallenge(group, group.map((d) => app.net.data.districts.find((x) => x.id === d)?.name ?? `${d}. Bezirk`));
}

/** heute: 3 Challenges aus dem Plan + Bezirk des Tages (für alle gleich) */
export function todaysChallenges(): Challenge[] {
  const day = viennaDay();
  return dailyChallenges(day, context(), districtOf(DISTRICT_GROUPS[districtOfDay(day, context(), schedule)]), schedule);
}

/** alle (Testseite; Challenge einer älteren Lobby wiederfinden) */
export function everyChallenge(): Challenge[] {
  return [...allChallenges(context()), ...DISTRICT_GROUPS.map(districtOf)];
}

export const findChallenge = (id: string | null) => (id ? (everyChallenge().find((c) => c.id === id) ?? null) : null);
export { districtGroupId };

/** Fenster beim Spielstart: Icon, Name, Beschreibung – Klick oder nach ein paar Sekunden weg */
export function showChallengeIntro(c: Challenge | null) {
  document.querySelector('.challenge-intro')?.remove();
  const el = h(
    'div',
    { class: 'challenge-intro', role: 'dialog', 'aria-label': 'Tages-Challenge' },
    `<div class="ci-card"><span class="ci-icon">${c?.icon ?? '🎯'}</span><small>Tages-Challenge</small><h2>${esc(c?.title ?? 'Tages-Challenge')}</h2>
      ${c ? `<p>${esc(c.text)}</p>` : ''}<button class="btn btn-primary">Los geht’s</button></div>`,
  );
  const close = () => el.remove();
  el.addEventListener('click', close);
  document.body.append(el);
  el.querySelector('button')!.focus();
  setTimeout(close, 6000);
}

/** Netz-Ansicht für die Regeln (shared/challengeRules.ts) im Browser */
export function clientRuleNet(net: NetIndex): RuleNet {
  const st = (id: string) => net.stations.get(id) ?? (net as unknown as { virtual?: Map<string, { name: string; district: number }> }).virtual?.get(id);
  const rn: RuleNet = {
    mode: (id) => net.lines.get(id)?.mode ?? null,
    name: (id) => st(id)?.name ?? id,
    district: (id) => st(id)?.district ?? null,
    traversed: (lineId, a, b) => {
      const line = net.lines.get(lineId);
      if (!line) return [];
      for (const p of net.patterns(line)) {
        const i = p.indexOf(a);
        const j = i >= 0 ? p.indexOf(b, i + 1) : -1;
        if (j > i) return p.slice(i, j + 1);
      }
      return [];
    },
    bridges: (lineId, a, b) => (bridgeIdx ? bridgesAlong(bridgeIdx, rn.traversed(lineId, a, b), rn.mode(lineId)) : []),
  };
  return rn;
}

// ---------------------------------------------------------------- „Brückenkenner“: Brücken (einmal laden)

let bridges: BridgeData | null = null;
let bridgeIdx: Map<string, string[]> | null = null;
let loadingBridges: Promise<BridgeData | null> | null = null;
export const bridgesNow = () => bridges;
export function loadBridges(): Promise<BridgeData | null> {
  loadingBridges ??= fetch('/api/bridges')
    .then((r) => (r.ok ? (r.json() as Promise<BridgeData>) : null))
    .then((d) => {
      bridges = d;
      bridgeIdx = d ? bridgeIndex(d) : null;
      return d;
    })
    .catch(() => null);
  return loadingBridges;
}

// ---------------------------------------------------------------- „Ab ins Wasser“: Gewässer-Daten (einmal laden)

let water: WaterData | null = null;
let loading: Promise<WaterData | null> | null = null;

export const waterNow = () => water;

export function loadWater(): Promise<WaterData | null> {
  loading ??= fetch('/api/water')
    .then((r) => (r.ok ? (r.json() as Promise<WaterData>) : null))
    .then((d) => (water = d))
    .catch(() => null);
  return loading;
}
