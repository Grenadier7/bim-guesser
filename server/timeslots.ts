import type { DayType, NetMode, ReferenceDay, SlotId } from '../shared/types.ts';
import { SLOT_DAYTYPE } from '../shared/rules.ts';
import { naiveMinutes } from './efa.ts';

const SLOT_TIME: Record<SlotId, [number, number]> = {
  wd12: [12, 0],
  wd17: [17, 0],
  sa02: [2, 0], // Nacht Fr -> Sa (U-Bahn fährt durch)
  su12: [12, 0],
};

/** Erlaubte Wochentage (0 = Mo … 6 = So) je Tagestyp; Wochentag = Di–Do */
export const DAYTYPE_DAYS: Record<DayType, number[]> = { wd: [1, 2, 3], sa: [5], su: [6] };

const WEEKDAY = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

export function isHoliday(d: Date): boolean {
  const md = `${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  if (['1-1', '1-6', '5-1', '8-15', '10-26', '11-1', '12-8', '12-24', '12-25', '12-26', '12-31'].includes(md)) return true;
  const e = easter(d.getUTCFullYear()).getTime();
  return [1, 39, 50, 60].some((off) => e + off * 86400000 === d.getTime());
}

// Wiener Schulferien (Ferienfahrplan bei der U-Bahn) – nach den festen Regeln berechnet statt als Liste, die
// irgendwann endet (Befund L-09: Pfingsten 2027 fehlte, Liste endete 2027-09):
//   Semester: 1. Montag im Februar – Samstag · Ostern: Samstag vor Palmsonntag – Ostermontag
//   Pfingsten: Samstag davor – Dienstag danach · Sommer: 1. Samstag im Juli – 1. Sonntag im September
//   Herbst: 27.–31. Oktober · Weihnachten: 24.12. – 6.1.
const DAY = 86400000;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
/** erster Wochentag `wd` (0 = So … 6 = Sa) ab dem Datum */
const firstWeekday = (y: number, m: number, d: number, wd: number) => {
  const t = utc(y, m, d);
  return t + (((wd - new Date(t).getUTCDay()) + 7) % 7) * DAY;
};

export function schoolHolidays(y: number): [number, number][] {
  const e = easter(y).getTime();
  const pentecost = e + 49 * DAY;
  const sem = firstWeekday(y, 2, 1, 1);
  return [
    [utc(y, 1, 1), utc(y, 1, 6)],
    [sem, sem + 5 * DAY],
    [e - 8 * DAY, e + DAY],
    [pentecost - DAY, pentecost + 2 * DAY],
    [firstWeekday(y, 7, 1, 6), firstWeekday(y, 9, 1, 0)],
    [utc(y, 10, 27), utc(y, 10, 31)],
    [utc(y, 12, 24), utc(y, 12, 31)],
  ];
}

export function isSchoolHoliday(d: Date): boolean {
  const t = utc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  return schoolHolidays(d.getUTCFullYear()).some(([a, b]) => t >= a && t <= b);
}

/** Ist der Tag ein "normaler" Vertreter seines Tagestyps? */
export function isTypicalDay(d: Date, type: DayType): boolean {
  const wd = (d.getUTCDay() + 6) % 7;
  if (!DAYTYPE_DAYS[type].includes(wd) || isHoliday(d)) return false;
  return type !== 'wd' || !isSchoolHoliday(d);
}

/** Nächster typischer Tag ab morgen (UTC-Mitternacht als Date) */
export function nextTypicalDay(type: DayType, from = new Date()): Date {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 1; i < 120; i++) {
    const d = new Date(start + i * 86400000);
    if (isTypicalDay(d, type)) return d;
  }
  throw new Error('kein Datum gefunden');
}

function atTime(d: Date, [h, m]: [number, number]): number {
  return naiveMinutes(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, m);
}

/** Abfragezeitpunkt (naive Minuten) für Zeitfenster + Netzmodus */
export function slotTime(slot: SlotId, net: NetMode, regularDays: Record<DayType, ReferenceDay>): number {
  const type = SLOT_DAYTYPE[slot];
  const day = net === 'regular' ? new Date(`${regularDays[type].date}T00:00:00Z`) : nextTypicalDay(type);
  return atTime(day, SLOT_TIME[slot]);
}

export function describeSlotDate(min: number): string {
  const d = new Date(min * 60000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAY[(d.getUTCDay() + 6) % 7]} ${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
