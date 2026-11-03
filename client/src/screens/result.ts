// Gemeinsame Bausteine der Endstände (Routenjagd und Quiz): gleiches Urteil, gleiche Knöpfe, Revanche,
// Vorschlag für die nächste Schwierigkeitsstufe.
import type { Difficulty } from '../../../shared/types.ts';
import { DIFFICULTY_PRESETS } from '../../../shared/rules.ts';
import { api } from '../api.ts';
import { app, endSession, isHost } from '../store.ts';
import { accountTag, esc, toast } from '../ui.ts';

/** ein Urteil für beide Modi – nach Anteil der möglichen Punkte */
export function verdict(pct: number): string {
  if (pct >= 85) return 'Öffi-Profi! 🏆';
  if (pct >= 60) return 'Stark – du kennst dich aus.';
  if (pct >= 35) return 'Solide – mit etwas Übung geht mehr.';
  return 'Guter Anfang – mit etwas Übung wird das schnell besser.';
}

/** Allein gespielt: Punkte mit Balken und Urteil */
export function soloCard(score: number, max: number): string {
  const pct = max ? Math.round((score / max) * 100) : 0;
  return `<div class="solo-result">
    <div class="sr-score"><b>${score.toLocaleString('de-AT')}</b><span>von ${max.toLocaleString('de-AT')} Punkten</span></div>
    <div class="sr-bar" role="progressbar" aria-label="Anteil der möglichen Punkte" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.min(100, pct)}%"></i></div>
    <p class="sr-verdict">${pct} % · ${verdict(pct)}</p></div>`;
}

/** Mehrere Spieler: Siegertreppchen */
export function podium(players: { id: string; name: string; score: number; account?: string }[], myId: string): string {
  const ranking = [...players].sort((a, b) => b.score - a.score);
  return `<ol class="podium">${ranking
    .map((p, i) => `<li class="${p.id === myId ? 'is-me' : ''}"><span>${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`}</span><b>${esc(p.name)}${accountTag(p)}</b><span class="pts">${p.score.toLocaleString('de-AT')}</span></li>`)
    .join('')}</ol>`;
}

/** vorzeitig beendet? Hinweis „nach Runde 2 von 5“ */
export const earlyNote = (played: number, planned: number, word: 'Runde' | 'Frage') =>
  played < planned ? `<p class="muted early-end">Vorzeitig beendet nach ${word} ${played} von ${planned}.</p>` : '';

/** Wer oft stark ist, bekommt die nächste Stufe vorgeschlagen – wer sich schwertut, die leichtere */
export function levelSuggestion(pct: number, difficulty: Difficulty): { id: Difficulty; label: string; up: boolean } | null {
  const i = DIFFICULTY_PRESETS.findIndex((d) => d.id === difficulty);
  if (i < 0) return null;
  if (pct >= 70 && i < DIFFICULTY_PRESETS.length - 1) return { ...DIFFICULTY_PRESETS[i + 1], up: true };
  if (pct < 25 && i > 0) return { ...DIFFICULTY_PRESETS[i - 1], up: false };
  return null;
}

/**
 * Knöpfe unter dem Endstand: Host → 🔁 Revanche (gleiche Einstellungen, sofort los) und „Zurück zur Lobby“,
 * optional mit vorgeschlagener Stufe; alle → Lobby verlassen.
 */
export function endActions(opts: { suggestion?: { id: Difficulty; label: string; up: boolean } | null } = {}): string {
  const sug = opts.suggestion;
  return `${
    isHost()
      ? `<div class="end-actions">
          <button class="btn btn-primary btn-big" id="rematch">🔁 Revanche</button>
          ${sug ? `<button class="btn btn-ghost" id="level-up" data-level="${sug.id}">${sug.up ? '⬆️ Zu leicht? Weiter mit' : '⬇️ Lieber etwas leichter:'} <b>${esc(sug.label)}</b></button>` : ''}
          <button class="btn btn-ghost" id="again">Zurück zur Lobby</button>
        </div>`
      : `<div class="waiting-host">Der Host kann eine Revanche oder ein neues Spiel starten.</div>`
  }
  <button class="link leave" id="leave">Lobby verlassen</button>`;
}

export function bindEndActions(root: HTMLElement) {
  const run = async (fn: () => Promise<unknown>, btn: HTMLButtonElement) => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message);
      btn.disabled = false;
    }
  };
  const s = () => app.session!;
  root.querySelector<HTMLButtonElement>('#rematch')?.addEventListener('click', (e) =>
    run(async () => {
      await api.lobby(s());
      await api.start(s());
    }, e.currentTarget as HTMLButtonElement),
  );
  root.querySelector<HTMLButtonElement>('#level-up')?.addEventListener('click', (e) =>
    run(async () => {
      const b = e.currentTarget as HTMLButtonElement;
      await api.lobby(s());
      await api.settings(s(), { difficulty: b.dataset.level as Difficulty });
    }, e.currentTarget as HTMLButtonElement),
  );
  root.querySelector<HTMLButtonElement>('#again')?.addEventListener('click', (e) => run(() => api.lobby(s()), e.currentTarget as HTMLButtonElement));
  root.querySelector('#leave')!.addEventListener('click', async () => {
    await api.leave(s()).catch(() => {});
    endSession();
  });
}
