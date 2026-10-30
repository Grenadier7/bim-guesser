// Anfragen der Admin-Seite: wie alle Account-Anfragen (Cookie, JSON) – „gesperrt“ (423) wird zu LockedError,
// dann zeigt die Seite die Passwort-Abfrage
import { call } from '../account.ts';
import { ApiError } from '../api.ts';
import type { NetworkPublic } from '../../../shared/types.ts';
import { NetIndex } from '../net.ts';

export class LockedError extends Error {}

/** wird aufgerufen, wenn der Admin-Bereich gesperrt ist (Sitzung abgelaufen) */
let onLocked: () => void = () => {};
export const setOnLocked = (fn: () => void) => (onLocked = fn);

export async function adm<T>(method: string, url: string, body?: unknown): Promise<T> {
  try {
    return await call<T>(method, url, body ?? (method === 'GET' ? undefined : {}));
  } catch (e) {
    if (e instanceof ApiError && e.status === 423) {
      onLocked();
      throw new LockedError(e.message);
    }
    throw e;
  }
}

/** Netz eines Netzplans (für Auswahl von Linien und Stationen) – je Plan zwischengespeichert, nach Änderungen neu */
const nets = new Map<string, Promise<NetIndex>>();
export function planNet(plan: string): Promise<NetIndex> {
  let p = nets.get(plan);
  if (!p) {
    p = call<NetworkPublic>('GET', plan === 'regular' ? '/api/network' : `/api/network?plan=${encodeURIComponent(plan)}`).then((d) => new NetIndex(d));
    p.catch(() => nets.delete(plan));
    nets.set(plan, p);
  }
  return p;
}
export const forgetPlanNet = (plan?: string) => (plan ? nets.delete(plan) : nets.clear());
