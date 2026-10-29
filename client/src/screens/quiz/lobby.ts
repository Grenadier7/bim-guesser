// Quiz – Lobby: Spieler, Einstellungen, Start
import type { Mode, QuizState } from '../../../../shared/types.ts';
import { icon } from '../../icons.ts';
import { MODE_ICON, MODE_LABEL } from '../../../../shared/rules.ts';
import { DEFAULT_QUIZ_SETTINGS, FREQUENCY_LABELS, QUIZ_QUESTION_COUNTS, QUIZ_TIMES, QUIZ_TYPES, QUIZ_TYPE_ORDER, type QuizSettings } from '../../../../shared/quiz.ts';
import { api } from '../../api.ts';
import { app, endSession, inviteLink, isHost, quizState, savePrefs } from '../../store.ts';
import { inviteButton } from '../../accountui.ts';
import { esc, toast } from '../../ui.ts';
import { deferWhileEditing, patchQueue, seg } from '../../widgets.ts';
import { bindKick } from '../host.ts';
import type { Screen } from '../screen.ts';
import { openSettingsDialog } from '../../settingsShare.ts';
import { areaOf, playersHtml } from './common.ts';

// ---------------------------------------------------------------- Lobby

function freqLabel(v: number): string {
  return v === 1 ? '🚫 Gar nicht' : `${'●'.repeat(v - 1)}<span class="freq-off">${'●'.repeat(7 - v)}</span> ${FREQUENCY_LABELS[v]}`;
}

export function quizLobbyScreen(panel: HTMLElement): Screen {
  app.map.clear();
  let advancedOpen = false;
  let lastArea = -1;

  const send = patchQueue(async (patch: Partial<QuizSettings>) => {
    try {
      const st = (await api.settings(app.session!, patch)) as QuizState;
      app.prefs.quiz = st.settings;
      savePrefs();
    } catch (e) {
      toast((e as Error).message);
    }
  });

  function render() {
    const st = quizState();
    const s = st.settings;
    const host = isHost();
    const ro = !host;
    if (s.area !== lastArea) {
      lastArea = s.area;
      app.map.clearLearn();
      app.map.showLearnArea(areaOf(s), true, true);
    }
    const scroll = panel.scrollTop;
    const typeRows = QUIZ_TYPE_ORDER.map(
      (t) => `<div class="qtype ${s.weights[t] === 1 ? 'off' : ''}"><div class="qt-label"><b>${QUIZ_TYPES[t].icon} ${QUIZ_TYPES[t].label}</b><small>${QUIZ_TYPES[t].hint}</small></div>
        <label class="freq"><input type="range" min="1" max="7" step="1" value="${s.weights[t]}" data-w="${t}" ${ro ? 'disabled' : ''}>
          <b class="freq-label">${freqLabel(s.weights[t])}</b></label></div>`,
    ).join('');
    const isDefault = QUIZ_TYPE_ORDER.every((t) => s.weights[t] === DEFAULT_QUIZ_SETTINGS.weights[t]);
    const active = QUIZ_TYPE_ORDER.filter((t) => s.weights[t] > 1).map((t) => QUIZ_TYPES[t].icon).join(' ');
    panel.innerHTML = `
      <div class="lobby">
        <div class="lobby-code">
          <div><small>🧠 Quiz · Lobby-Code</small><div class="code">${st.id}</div></div>
          <div class="code-actions"><button class="btn btn-ghost btn-icon" id="copy">${icon('link')}<span>Link kopieren</span></button>${inviteButton()}</div>
        </div>
        <h3>Spieler <small>(${st.players.length})</small></h3>
        <ul class="players">${playersHtml(st)}</ul>
        <h3>Einstellungen ${ro ? '<small>– nur der Host kann sie ändern</small>' : ''}</h3>
        <div class="setting"><span>Fragen</span>${seg('questions', QUIZ_QUESTION_COUNTS.map((n) => ({ value: String(n), label: String(n) })), String(s.questions), ro)}</div>
        <div class="setting"><span>Zeit pro Frage</span>${seg('timeSec', QUIZ_TIMES.map((n) => ({ value: String(n), label: `${n} s` })), String(s.timeSec), ro)}
          <small class="hint">Richtig gibt 500–1000 Punkte – je schneller, desto mehr.</small></div>
        <div class="setting"><span>Gebiet</span>
          <select id="area" aria-label="Gebiet" ${ro ? 'disabled' : ''}><option value="0">Ganz Wien</option>${app.net.data.districts.map((d) => `<option value="${d.id}" ${d.id === s.area ? 'selected' : ''}>${d.id}. ${esc(d.name)}</option>`).join('')}</select></div>
        <div class="setting"><span>Verkehrsmittel</span><div class="quiz-modes">${(['U', 'S', 'T', 'B', 'N'] as Mode[])
          .map((m) => `<button data-mode="${m}" class="${s.modes.includes(m) ? 'on' : ''}" ${ro ? 'disabled' : ''}>${MODE_ICON[m]} ${MODE_LABEL[m]}</button>`)
          .join('')}</div></div>
        <details class="advanced" ${advancedOpen ? 'open' : ''}>
          <summary>⚙️ Fragetypen & Häufigkeit <small>${active}</small></summary>
          <p class="hint">Regler ganz links = <b>gar nicht</b>, Mitte = normal, ganz rechts = sehr häufig.</p>
          <div class="qtypes">${typeRows}</div>
          ${host ? `<button class="btn btn-ghost" id="resetW" ${isDefault ? 'disabled' : ''}>↺ Standard-Häufigkeiten</button>` : ''}
        </details>
        <div class="settings-tools"><button class="link" id="shareSettings">⇅ Einstellungen teilen</button>${host ? '<button class="link reset-settings" id="resetAll">↺ Alle Einstellungen zurücksetzen</button>' : ''}</div>
        ${
          host
            ? `<button class="btn btn-primary btn-big" id="start">${st.players.length > 1 ? `Quiz starten (${st.players.length} Spieler)` : 'Quiz starten'}</button>`
            : `<div class="waiting-host">Warte, bis ${esc(st.players.find((p) => p.isHost)?.name ?? 'der Host')} startet …</div>`
        }
        <button class="link leave" id="leave">Lobby verlassen</button>
      </div>`;
    panel.scrollTop = scroll;

    panel.querySelector<HTMLDetailsElement>('details.advanced')!.addEventListener('toggle', (e) => {
      advancedOpen = (e.target as HTMLDetailsElement).open;
    });
    bindKick(panel);
    panel.querySelector('#copy')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteLink(st.id));
        toast('Einladungslink kopiert', 'info');
      } catch {
        toast(`Code: ${st.id}`, 'info');
      }
    });
    panel.querySelectorAll<HTMLButtonElement>('button[data-k]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.k!;
        const v = Number(b.dataset.v);
        send({ [k]: v } as Partial<QuizSettings>);
      }),
    );
    panel.querySelectorAll<HTMLInputElement>('input[data-w]').forEach((r) => {
      const t = r.dataset.w as keyof QuizSettings['weights'];
      r.addEventListener('input', () => {
        r.nextElementSibling!.innerHTML = freqLabel(Number(r.value));
        r.closest('.qtype')!.classList.toggle('off', r.value === '1');
      });
      r.addEventListener('change', () => send({ weights: { ...s.weights, [t]: Number(r.value) } as QuizSettings['weights'] }));
    });
    panel.querySelector('#resetW')?.addEventListener('click', () => send({ weights: { ...DEFAULT_QUIZ_SETTINGS.weights } }));
    panel.querySelector('#shareSettings')?.addEventListener('click', () =>
      openSettingsDialog(
        'quiz',
        quizState().settings,
        host
          ? async (x) => {
              const st = (await api.settings(app.session!, x as Partial<QuizSettings>)) as QuizState;
              app.prefs.quiz = st.settings;
              savePrefs();
              return st.settings as unknown as Record<string, unknown>;
            }
          : null,
      ),
    );
    panel.querySelector('#resetAll')?.addEventListener('click', () => {
      if (!confirm('Alle Quiz-Einstellungen auf den Standard zurücksetzen?')) return;
      send(structuredClone(DEFAULT_QUIZ_SETTINGS));
    });
    panel.querySelector<HTMLSelectElement>('#area')!.addEventListener('change', (e) => send({ area: Number((e.target as HTMLSelectElement).value) }));
    panel.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = b.dataset.mode as Mode;
        const modes = s.modes.includes(m) ? s.modes.filter((x) => x !== m) : [...s.modes, m];
        if (modes.length) send({ modes });
      }),
    );
    panel.querySelector('#start')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      try {
        await api.start(app.session!);
      } catch (err) {
        toast((err as Error).message);
        btn.disabled = false;
      }
    });
    panel.querySelector('#leave')!.addEventListener('click', async () => {
      await api.leave(app.session!).catch(() => {});
      endSession();
    });
  }

  render();
  return { update: deferWhileEditing(panel, render) };
}
