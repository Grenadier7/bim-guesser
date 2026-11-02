// Tages-Challenges im Browser: die heutigen (3 + Bezirk der Woche) mit den Uhrzeiten/Wertungen dieses Spiels,
// und das Fenster beim Spielstart („Heute: ☕ Kaffeepause …“).
import { dailyChallenges, districtChallenge, districtOfWeek, type Challenge, type ChallengeContext } from '../../shared/challenges.ts';
import { viennaDay } from '../../shared/career.ts';
import { AVOID_TRANSFERS, SLOT_DAYTYPE, SLOT_TIME, TIME_SLOTS, isNightSlot } from '../../shared/rules.ts';
import { app } from './store.ts';
import { esc, h } from './ui.ts';

const hhmm = (id: string) => SLOT_TIME[id].map((n) => String(n).padStart(2, '0')).join(':');

function context(): ChallengeContext {
  const night = TIME_SLOTS.find((t) => isNightSlot(t.id));
  const rush = TIME_SLOTS.find((t) => SLOT_DAYTYPE[t.id] === 'wd' && SLOT_TIME[t.id][0] >= 16 && SLOT_TIME[t.id][0] <= 19);
  return { night: night ? { id: night.id, time: hhmm(night.id) } : null, rush: rush ? { id: rush.id, time: hhmm(rush.id) } : null, avoid: AVOID_TRANSFERS.enabled };
}

/** Mittelpunkt eines Bezirks = Schwerpunkt seiner Haltestellen */
export function districtCenter(id: number): [number, number] {
  const sts = app.net.data.stations.filter((x) => x.district === id);
  return [sts.reduce((a, x) => a + x.lat, 0) / sts.length, sts.reduce((a, x) => a + x.lon, 0) / sts.length];
}

/** heute: 3 Challenges + Bezirk der Woche (für alle gleich) */
export function todaysChallenges(): Challenge[] {
  const d = districtOfWeek();
  const name = app.net.data.districts.find((x) => x.id === d)?.name ?? `${d}. Bezirk`;
  return [...dailyChallenges(viennaDay(), context()), districtChallenge(d, name, districtCenter(d))];
}

export const findChallenge = (id: string | null) => (id ? (todaysChallenges().find((c) => c.id === id) ?? null) : null);

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
