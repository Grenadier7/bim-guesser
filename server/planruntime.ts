// Netzpläne zur Laufzeit: je Plan ein eigenes Netz (Stationen, Linien, Haltefolgen) und ein eigener Fahrplan.
// Der Standard-Netzplan („regular“) verändert das Haupt-Netz direkt – alles, was es kennt (Quiz, Training, Karten,
// /api/network), sieht die Änderungen sofort. Weitere Netzpläne entstehen erst, wenn sie gebraucht werden.
import type { LineEdit, NetMode } from '../shared/types.ts';
import { Network } from './network.ts';
import { planIdOf } from './plancontext.ts';
import type { PlanStore } from './plans.ts';
import { configureTimetable, forgetTimetable, reloadTimetable, type PlanContext } from './timetable.ts';

type AddressCfg = Parameters<Network['applyAddresses']>[0];

export class PlanRuntime {
  readonly base: Network;
  private plans: PlanStore;
  private others = new Map<string, Network>();
  private json = new Map<string, string>();
  private addresses: () => AddressCfg;
  /** nach jeder Änderung (z.B. Quiz-Netz neu aufbauen) */
  onChange: () => void = () => {};

  constructor(base: Network, plans: PlanStore, addresses: () => AddressCfg) {
    this.base = base;
    this.plans = plans;
    this.addresses = addresses;
    configureTimetable((id) => this.context(id));
  }

  /** Netz eines Plans (null = unbekannt) */
  planNet(id: string): Network | null {
    if (id === 'regular') return this.base;
    const plan = this.plans.get(id);
    if (!plan) return null;
    let n = this.others.get(id);
    if (!n) {
      n = Network.load();
      n.planId = id;
      n.applyEdits(plan.edits);
      n.applyAddresses(this.addresses());
      this.others.set(id, n);
    }
    return n;
  }

  /** Netz zur Netz-Auswahl einer Lobby („Regulär“, „Aktuell“ → Haupt-Netz) */
  net(mode: NetMode): Network {
    return this.planNet(planIdOf(mode)) ?? this.base;
  }

  /** öffentliche Netzdaten eines Plans (für /api/network?plan=…) */
  networkJson(id: string): string | null {
    const n = this.planNet(id);
    if (!n) return null;
    let j = this.json.get(id);
    if (!j) this.json.set(id, (j = JSON.stringify(n.publicData())));
    return j;
  }

  /** was der Fahrplan eines Plans braucht */
  context(id: string): PlanContext | null {
    const plan = this.plans.get(id);
    const n = this.planNet(id);
    if (!plan || !n) return null;
    return {
      params: this.plans.params(id),
      edits: plan.edits,
      stations: {
        stationOf: (efaId) => n.stationOfEfa(efaId),
        station: (sid) => {
          const st = n.stations.get(sid);
          return st ? { name: st.name, lat: st.lat, lon: st.lon, efaId: n.mainEfaId(sid) } : null;
        },
      },
    };
  }

  /** Änderungen eines Plans (oder aller) anwenden: Netz und Fahrplan neu; liefert den Bericht je Plan */
  apply(id?: string): Record<string, string[]> {
    const ids = id ? [id] : this.plans.list().map((p) => p.id);
    const report: Record<string, string[]> = {};
    for (const pid of ids) {
      this.json.delete(pid);
      if (pid === 'regular') {
        this.base.applyEdits(this.plans.get('regular')?.edits ?? []);
        this.base.applyAddresses(this.addresses());
      } else this.others.delete(pid);
      forgetTimetable(pid);
      if (!this.plans.get(pid)) continue;
      // reguläres Netz sofort, weitere Pläne erst bei Bedarf – aber hier schon, damit der Bericht stimmt
      report[pid] = reloadTimetable(pid);
    }
    // gelöschte Pläne vergessen
    for (const k of [...this.others.keys()]) if (!this.plans.get(k)) (this.others.delete(k), this.json.delete(k), forgetTimetable(k));
    this.onChange();
    return report;
  }

  /** Adressen geändert: in allen geladenen Netzen */
  refreshAddresses() {
    this.base.applyAddresses(this.addresses());
    for (const n of this.others.values()) n.applyAddresses(this.addresses());
    this.json.clear();
  }

  /** Netz eines Plans mit vorläufigen Änderungen (zum Prüfen, ohne zu speichern) */
  static preview(edits: LineEdit[]): Network {
    const n = Network.load();
    n.applyEdits(edits);
    return n;
  }
}
