// Tages-Challenges im Browser: die heutigen (3 + Bezirk der Woche) mit den Uhrzeiten/Wertungen dieses Spiels,
// und das Fenster beim Spielstart („Heute: ☕ Kaffeepause …“).
import { allChallenges, dailyChallenges, districtChallenge, districtOfDay, type Challenge, type ChallengeContext } from '../../shared/challenges.ts';
import { viennaDay } from '../../shared/career.ts';
import { NET_MODES, SLOT_DAYTYPE, SLOT_TIME, TIME_SLOTS, isNightSlot } from '../../shared/rules.ts';
import { app } from './store.ts';
import type { NetIndex } from './net.ts';
import type { RuleNet } from '../../shared/challengeRules.ts';
import type { WaterData } from '../../shared/water.ts';
import { esc, h } from './ui.ts';

const hhmm = (id: string) => SLOT_TIME[id].map((n) => String(n).padStart(2, '0')).join(':');

function context(): ChallengeContext {
  const night = TIME_SLOTS.find((t) => isNightSlot(t.id));
  const sunday = TIME_SLOTS.find((t) => SLOT_DAYTYPE[t.id] === 'su' && !isNightSlot(t.id));
  const at = (t: { id: string } | undefined) => (t ? { id: t.id, time: hhmm(t.id) } : null);
  return {
    night: at(night),
    sunday: at(sunday),
    current: NET_MODES.some((m) => m.id === 'current'),
    addresses: (app.net?.data.addressCount ?? 0) > 0,
    // Gewässer-Daten liegen dem Spiel bei (data/water.json)
    water: true,
  };
}

/** Mittelpunkt eines Bezirks = Schwerpunkt seiner Haltestellen */
export function districtCenter(id: number): [number, number] {
  const sts = app.net.data.stations.filter((x) => x.district === id);
  return [sts.reduce((a, x) => a + x.lat, 0) / sts.length, sts.reduce((a, x) => a + x.lon, 0) / sts.length];
}

function districtOf(d: number): Challenge {
  const name = app.net.data.districts.find((x) => x.id === d)?.name ?? `${d}. Bezirk`;
  return districtChallenge(d, name, districtCenter(d));
}

/** heute: 3 Challenges aus der Rotation + Bezirk des Tages (für alle gleich) */
export function todaysChallenges(): Challenge[] {
  return dailyChallenges(viennaDay(), context(), districtOf(districtOfDay(viennaDay())));
}

/** alle (Testseite; Challenge einer älteren Lobby wiederfinden) */
export function everyChallenge(): Challenge[] {
  return [...allChallenges(context()), ...Array.from({ length: 23 }, (_, i) => districtOf(i + 1))];
}

export const findChallenge = (id: string | null) => (id ? (everyChallenge().find((c) => c.id === id) ?? null) : null);

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
  return {
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
  };
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
