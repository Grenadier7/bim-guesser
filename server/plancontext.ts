// Welcher Netzplan gerade gerechnet wird – gesetzt beim Vorbereiten/Auswerten einer Runde (routing.ts), gelesen beim
// Abfragen des Fahrplans (timetable.ts). So muss die Plan-ID nicht durch jede Funktion dazwischen gereicht werden.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NetMode } from '../shared/types.ts';

const ctx = new AsyncLocalStorage<string>();

export const currentPlan = (): string => ctx.getStore() ?? 'regular';

export function withPlan<T>(plan: string, fn: () => T): T {
  return plan === currentPlan() ? fn() : ctx.run(plan, fn);
}

/** Netz-Auswahl der Lobby → Plan-ID ('regular' für „Regulär“ und „Aktuell“) */
export const planIdOf = (mode: NetMode): string => (mode.startsWith('plan:') ? mode.slice(5) : 'regular');

// Abbruch: eine Rundenvorbereitung, die nicht mehr gebraucht wird (Spiel beendet), hört bei der nächsten
// Fahrplan-Abfrage auf (efa.ts) – statt alle Runden zu Ende zu rechnen.
const cancel = new AsyncLocalStorage<() => boolean>();

export const isCancelled = (): boolean => cancel.getStore()?.() ?? false;

export function withCancel<T>(cancelled: () => boolean, fn: () => T): T {
  return cancel.run(cancelled, fn);
}
