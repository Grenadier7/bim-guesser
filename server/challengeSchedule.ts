// Plan der Tages-Challenges (welche an welchem Tag, shared/challenges.ts): einmal berechnen und als Datei ablegen.
// Beim Start bzw. bei der ersten Anfrage: gibt es die Datei mit derselben Challenge-Liste, wird sie genommen –
// sonst (neue/geänderte Challenges, andere Uhrzeiten auf der Admin-Seite) neu berechnet und gespeichert.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSchedule, challengeContext, scheduleKey, type Schedule } from '../shared/challenges.ts';
import { STATE_DIR } from './paths.ts';

const FILE = path.join(STATE_DIR, 'challenge-schedule.json');
let cache: Schedule | null = null;

export function challengeSchedule(addresses: boolean, water: boolean, bridges: boolean): Schedule {
  const ctx = challengeContext(addresses, water, bridges);
  const key = scheduleKey(ctx);
  if (cache?.key === key) return cache;
  try {
    const saved = JSON.parse(readFileSync(FILE, 'utf8')) as Schedule;
    if (saved.key === key) return (cache = saved);
  } catch {
    /* noch keine Datei */
  }
  const t = Date.now();
  cache = buildSchedule(ctx);
  try {
    writeFileSync(FILE, JSON.stringify(cache));
    console.log(`Challenge-Plan neu berechnet (${cache.days.length} Tage, ${Date.now() - t} ms) → ${FILE}`);
  } catch (e) {
    console.warn(`Challenge-Plan konnte nicht gespeichert werden: ${(e as Error).message}`);
  }
  return cache;
}
