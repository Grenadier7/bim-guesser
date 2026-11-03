// Fortschritt im Browser (auch ohne Account): XP & Level, Serie mit Joker, Wochenziel, Sammelkarte „Mein Wien“,
// Medaillen. Mit Account wird der Stand synchronisiert (account.ts) – Level und Medaillen kommen dann vom Server.
import type { LevelInfo, MedalPublic, UserLeg } from '../../shared/types.ts';
import { CAREER_KEY, XP, emptyCareer, levelOf, medalList, reachedKeys, streakOf, trimActs, viennaDay, weekCount, type Career, type CareerCounters, type MedalStats } from '../../shared/career.ts';
import { isSpecialLine } from '../../shared/rules.ts';
import { SEEN_MEDALS, account } from './account.ts';
import { loadJson, saveJson } from './storage.ts';
import { app } from './store.ts';
import { toast } from './ui.ts';

export function career(): Career {
  const c = loadJson<Partial<Career>>(CAREER_KEY, {});
  return { ...emptyCareer(), ...c, c: { ...(c.c ?? {}) }, acts: { ...(c.acts ?? {}) } };
}

/** Kurse & Tutorial aus dem Lernstand (gleiche Schlüssel wie am Server) */
function learnState(): { done: number; mastered: number; tutorial: boolean } {
  const courses = Object.values(loadJson<Record<string, { done?: boolean; mastered?: boolean }>>('oeffi-courses-v1', {}));
  const p = loadJson<{ tutorialDone?: boolean }>('oeffi-progress-v1', {});
  return { done: courses.filter((c) => c?.done).length, mastered: courses.filter((c) => c?.mastered).length, tutorial: !!p.tutorialDone };
}

function localLevel(c = career()): LevelInfo {
  const l = learnState();
  return levelOf(c.xp + l.done * XP.course + l.mastered * XP.mastered + (l.tutorial ? XP.tutorial : 0));
}

const tramLineIds = () => (app.net ? app.net.data.lines.filter((l) => l.mode === 'T' && !isSpecialLine(l)).map((l) => l.id) : []);

function localMedals(c = career()): MedalPublic[] {
  const l = learnState();
  const tram = new Set(tramLineIds());
  const cc = c.c;
  const stats: MedalStats = {
    games: cc.games ?? 0,
    wins: cc.wins ?? 0,
    perfect: cc.perfect ?? 0,
    beat: cc.beat ?? 0,
    quizAce: cc.quizAce ?? 0,
    trainings: cc.trainings ?? 0,
    courses: l.done + l.mastered,
    tutorial: l.tutorial ? 1 : 0,
    friends: 0,
    level: localLevel(c).level,
    streak: Math.max(c.best, streakOf(c.acts).days),
    stations: c.stations.length,
    tramLines: c.lines.filter((id) => tram.has(id)).length,
    tramTotal: tram.size,
    night: cc.night ?? 0,
    daily: cc.daily ?? 0,
    blindPerfect: cc.blindPerfect ?? 0,
    lateNight: cc.lateNight ?? 0,
    challenges: c.ch?.length ?? 0,
    challengesDone: c.chDone?.length ?? 0,
  };
  return medalList(stats);
}

/** Level: mit Account vom Server, sonst aus dem Browser */
export const myLevel = (): LevelInfo => account.me?.level ?? localLevel();
export const myMedals = (): MedalPublic[] => account.me?.medals ?? localMedals();

export function progressSummary() {
  const c = career();
  const s = streakOf(c.acts);
  return { level: myLevel(), streak: s, best: Math.max(c.best, s.days), week: weekCount(c.acts), medals: myMedals(), career: c, guest: !account.me };
}

// ---------------------------------------------------------------- Ereignisse

/** Stationen einer eigenen Teilstrecke: Ein- und Ausstieg und alles dazwischen (für die Sammelkarte) */
function legStations(leg: UserLeg): string[] {
  const line = app.net?.lines.get(leg.line);
  if (!line) return [leg.from, leg.to];
  for (const p of app.net.patterns(line)) {
    const a = p.indexOf(leg.from);
    const b = p.indexOf(leg.to);
    if (a >= 0 && b >= 0) return a <= b ? p.slice(a, b + 1) : p.slice(b, a + 1);
  }
  return [leg.from, leg.to];
}

interface Event {
  /** zählt als Spiel/Strecke (Serie, Wochenziel) */
  activity?: boolean;
  xp?: number;
  count?: Partial<Record<keyof CareerCounters, number>>;
  /** eigene, gültige Route → Sammelkarte */
  legs?: UserLeg[];
  /** Tages-Challenge gespielt (und ggf. geschafft) */
  challenge?: { id: string; done: boolean };
}

const once = new Set<string>();

const CHALLENGE_DAYS = 'oeffi-challenge-days-v1';

/** Gäste: XP-Faktor einer Tages-Challenge – das erste Spiel dieser Challenge am Tag zählt doppelt (wie am Server) */
export function challengeXpFactor(challenge: string | null, run: string): number {
  if (!challenge) return 1;
  const day = viennaDay();
  const all = loadJson<Record<string, string>>(CHALLENGE_DAYS, {});
  const key = `${day}:${challenge}`;
  if (!all[key]) saveJson(CHALLENGE_DAYS, Object.fromEntries([...Object.entries(all).filter(([k]) => k.startsWith(day)), [key, run]]));
  return (all[key] ?? run) === run ? XP.firstChallengeFactor : 1;
}

/**
 * Fortschritt verbuchen. `key` verhindert doppeltes Zählen (z.B. Endstand nach Neuladen).
 * Gast-XP nur ohne Account – mit Account rechnet der Server selbst.
 */
export function record(key: string, ev: Event) {
  if (once.has(key)) return;
  once.add(key);
  const before = new Set(reachedKeys(localMedals()));
  const c = career();
  const today = viennaDay();
  if (ev.activity) {
    c.acts[today] = (c.acts[today] ?? 0) + 1;
    const h = new Date().getHours();
    if (h < 4) c.c.lateNight = (c.c.lateNight ?? 0) + 1;
  }
  if (ev.xp && !account.me) c.xp = Math.round(c.xp + ev.xp);
  for (const [k, v] of Object.entries(ev.count ?? {})) c.c[k as keyof CareerCounters] = (c.c[k as keyof CareerCounters] ?? 0) + (v ?? 0);
  if (ev.legs?.length) {
    const lines = new Set(c.lines);
    const stations = new Set(c.stations);
    for (const leg of ev.legs) {
      if (!app.net?.lines.has(leg.line)) continue;
      lines.add(leg.line);
      for (const id of legStations(leg)) if (app.net.stations.has(id)) stations.add(id);
    }
    c.lines = [...lines];
    c.stations = [...stations];
  }
  if (ev.challenge) {
    // Bezirk des Tages: jeder Bezirk ist dieselbe Challenge
    const id = ev.challenge.id.startsWith('district-') ? 'district' : ev.challenge.id;
    c.ch = [...new Set([...(c.ch ?? []), id])];
    if (ev.challenge.done) c.chDone = [...new Set([...(c.chDone ?? []), id])];
  }
  c.acts = trimActs(c.acts, today);
  c.best = Math.max(c.best, streakOf(c.acts, today).days);
  saveJson(CAREER_KEY, c);
  // ohne Account: neue Medaillen-Stufen gleich melden (mit Account meldet sie account.ts nach dem Sync)
  if (!account.me) {
    const fresh = localMedals(c).filter((m) => m.tier && !before.has(`${m.id}:${m.tier}`));
    const seen = new Set(loadJson<string[]>(SEEN_MEDALS, []));
    const news = fresh.filter((m) => !seen.has(`${m.id}:${m.tier}`));
    if (news.length) {
      saveJson(SEEN_MEDALS, [...seen, ...news.map((m) => `${m.id}:${m.tier}`)]);
      for (const m of news) toast(`🏅 Neue Medaille: ${m.icon} ${m.title}${m.tiers > 1 ? ` (${['Bronze', 'Silber', 'Gold'][m.tier - 1]})` : ''}`, 'info');
    }
  }
}
