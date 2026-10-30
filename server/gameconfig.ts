// Spiel-Konfiguration der Admin-Seite auf dem Server: speichern (mit Versionen), prüfen, anwenden.
// Gespeichert werden nur die Abschnitte, die jemand geändert hat – alles andere bleibt beim Standard aus dem Code.
import {
  applyGameConfig,
  ConfigError,
  defaultGameConfig,
  publicConfig,
  sanitizeSection,
  type GameConfig,
  type GameConfigSection,
  type MenuPlan,
  type PublicConfig,
} from '../shared/config.ts';
import { sanitizeQuizSettings } from '../shared/quiz.ts';
import { DIFFICULTY_PRESETS, isSlotId } from '../shared/rules.ts';
import { GameError } from './lobby.ts';
import { setBadWords } from './moderation.ts';
import type { Network } from './network.ts';
import { sanitizeSettings } from './settings.ts';
import { VersionedJson } from './versioned.ts';

export const SECTION_LABEL: Record<GameConfigSection, string> = {
  slots: 'Uhrzeiten',
  netModes: 'Netz-Auswahl',
  scoring: 'Was zählt?',
  tips: 'Joker',
  difficulty: 'Schwierigkeit',
  defaults: 'Standard-Einstellungen',
  pools: 'Haltestellen-Auswahl',
  addresses: 'Adressen',
  chat: 'Chat-Moderation',
  announcement: 'Hinweis für alle',
};
const SECTIONS = Object.keys(SECTION_LABEL) as GameConfigSection[];

export class GameConfigStore {
  private net: Network;
  private menu: () => MenuPlan[];
  private store: VersionedJson<Partial<GameConfig>>;
  /** nach jeder Änderung (Adressen ins Netz übernehmen …) */
  onChange: (section: GameConfigSection | null) => void = () => {};

  constructor(net: Network, menu: () => MenuPlan[]) {
    this.net = net;
    this.menu = menu;
    this.store = new VersionedJson('game', (v) => this.clean(v), () => ({}));
  }

  /** gespeicherte Datei: jeden Abschnitt prüfen, kaputte weglassen (dort gilt der Standard) */
  private clean(v: unknown): Partial<GameConfig> {
    const out: Partial<GameConfig> = {};
    for (const [k, val] of Object.entries((v ?? {}) as Record<string, unknown>)) {
      if (!SECTIONS.includes(k as GameConfigSection)) continue;
      try {
        (out as Record<string, unknown>)[k] = this.validate(k as GameConfigSection, val);
      } catch (e) {
        console.warn(`⚠ Spiel-Konfiguration „${k}“ ungültig, Standard gilt: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** prüfen wie jede Eingabe – mit Server-Wissen (Stationen, Lobby-Regeln) */
  validate<K extends GameConfigSection>(key: K, value: unknown): GameConfig[K] {
    try {
      if (key === 'defaults') return this.validateDefaults(value) as GameConfig[K];
      const v = sanitizeSection(key, value);
      if (key === 'pools') {
        // nur bekannte Stationen (oder neue aus Netzplänen „n…“)
        const ok = (id: string) => this.net.stations.has(id) || /^n\d+$/.test(id);
        const p = v as GameConfig['pools'];
        for (const side of ['add', 'remove'] as const) for (const k of Object.keys(p[side]) as (keyof typeof p.add)[]) p[side][k] = p[side][k]!.filter(ok);
      }
      return v;
    } catch (e) {
      if (e instanceof ConfigError) throw new GameError(e.message);
      throw e;
    }
  }

  private validateDefaults(value: unknown): GameConfig['defaults'] {
    const code = defaultGameConfig().defaults;
    const v = (value ?? {}) as Record<string, Record<string, unknown>>;
    const route = sanitizeSettings(v.route as never, code.route);
    const quiz = sanitizeQuizSettings(v.quiz as never, code.quiz);
    const t = v.training ?? {};
    const training = {
      slot: isSlotId(t.slot) ? t.slot : code.training.slot,
      preset: DIFFICULTY_PRESETS.some((p) => p.id === t.preset) ? (t.preset as typeof code.training.preset) : code.training.preset,
      area: Number.isInteger(t.area) && Number(t.area) >= 0 && Number(t.area) <= 23 ? Number(t.area) : code.training.area,
      coach: typeof t.coach === 'boolean' ? t.coach : code.training.coach,
    };
    return { route, quiz, training };
  }

  stored(): Partial<GameConfig> {
    return this.store.get();
  }

  effective(): GameConfig {
    return { ...defaultGameConfig(), ...this.store.get() };
  }

  /** auf die Spiel-Konstanten übertragen (beim Start, nach Änderungen an Konfiguration oder Netzplänen) */
  apply() {
    const c = this.effective();
    applyGameConfig(c, this.menu());
    setBadWords(c.chat.words);
  }

  save<K extends GameConfigSection>(key: K, value: unknown, by: string): GameConfig {
    const v = this.validate(key, value);
    this.store.save({ ...this.store.get(), [key]: v }, by, `${SECTION_LABEL[key]} geändert`);
    this.apply();
    this.onChange(key);
    return this.effective();
  }

  /** Abschnitt auf den Standard aus dem Code zurück */
  reset(key: GameConfigSection, by: string): GameConfig {
    const next = { ...this.store.get() };
    delete next[key];
    this.store.save(next, by, `${SECTION_LABEL[key]} auf Standard`);
    this.apply();
    this.onChange(key);
    return this.effective();
  }

  versions() {
    return this.store.versions();
  }

  rollback(id: string, by: string): GameConfig {
    this.store.rollback(id, by);
    this.apply();
    this.onChange(null);
    return this.effective();
  }

  public(): PublicConfig {
    return publicConfig(this.effective(), this.menu());
  }
}
