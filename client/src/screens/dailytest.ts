// Testwerkzeug für die Strecke des Tages (nur lokal: /#daily-test, Server mit --dev): beliebig oft neu ziehen –
// Start, Ziel, beste Verbindung, nur bekannte Linien und alle Versuche mit Begründung. Speichert nichts.
import { viennaDay } from '../../../shared/career.ts';
import { call } from '../account.ts';
import { netLayer, netView, smoothRoute } from '../netmap.ts';
import { app, setMobileMap } from '../store.ts';
import { chain, esc } from '../ui.ts';
import type { DailyPreview } from '../../../server/daily.ts';
import { loadingHtml, type Screen } from './screen.ts';

export function dailyTestScreen(panel: HTMLElement, onBack: () => void): Screen {
  let day = viennaDay();

  async function load() {
    setMobileMap(false);
    panel.innerHTML = loadingHtml('Strecke wird gezogen …');
    let p: DailyPreview;
    try {
      p = await call<DailyPreview>('GET', `/api/daily/preview?day=${day}`);
    } catch (e) {
      panel.innerHTML = `<div class="learn"><button class="link" id="back">← Zurück</button>
        <p class="err">${esc((e as Error).message)}</p><p class="muted">Das Testwerkzeug gibt es nur lokal: <code>npm run dev</code> (Server mit <code>--dev</code>).</p></div>`;
      panel.querySelector('#back')!.addEventListener('click', onBack);
      return;
    }
    app.map.clear();
    netLayer().render(netView({ dimAll: true, hubs: false, labels: false }));
    const routes = [...p.routes.slice(0, 1), ...(p.rail ? [{ ...p.rail, key: `rail:${p.rail.key}` }] : [])];
    app.map.showReveal(routes.map(smoothRoute), [], routes.map((r) => r.key));
    app.map.showEndpoints(p.from, p.to, true);
    const best = p.routes[0];
    panel.innerHTML = `
      <div class="learn daily-test">
        <button class="link" id="back">← Zurück</button>
        <h2>🧪 Strecke des Tages – Test</h2>
        <div class="dt-controls"><input type="date" id="day" value="${p.day}"><button class="btn btn-primary" id="again">🎲 Neu ziehen</button></div>
        <p class="muted">Zieht wie am Server, speichert aber nichts. ${p.saved ? `Echte Strecke an diesem Tag: <b>${esc(p.saved.from)} → ${esc(p.saved.to)}</b>.` : 'Für diesen Tag ist noch keine Strecke gespeichert.'}</p>
        <div class="result-card ${p.criteriaMet ? 'great' : 'meh'}"><div class="mine">
          <div class="od"><div class="od-row"><span class="pin-dot a">A</span><b>${esc(p.from.name)}</b></div><div class="od-row"><span class="pin-dot b">B</span><b>${esc(p.to.name)}</b></div></div>
          <p>${p.criteriaMet ? '✓ alle Kriterien erfüllt' : '⚠️ nächstbeste Strecke – nicht alle Kriterien erfüllt'} · ${esc(p.when)}</p>
          <p><b>Beste Verbindung:</b> <span class="chainline">${chain(best.legs)}</span> <b>${best.medianMin} min</b></p>
          <p><b>Nur bekannte Linien</b> <small class="muted">(U-Bahn, S-Stammstrecke, S45, S80)</small>: ${p.rail ? `<span class="chainline">${chain(p.rail.legs)}</span> <b>${p.rail.medianMin} min</b> → ${p.railPoints} Punkte` : 'nicht erreichbar'}
            <small class="muted">(Ziel: ${p.rules.railMin}–${p.rules.railMax})</small></p>
        </div></div>
        <h3>Versuche (${p.attempts.length} von max. ${p.rules.attempts})</h3>
        <div class="dt-table"><table><thead><tr><th>Start → Ziel</th><th>beste</th><th>bekannt</th><th>Pkt.</th><th>Ergebnis</th></tr></thead><tbody>${p.attempts
          .map(
            (a) => `<tr class="${a.result.includes('✓') ? 'ok' : ''}"><td>${esc(a.from)} → ${esc(a.to)}</td><td>${a.bestMin ?? '–'}${a.legs ? ` <small>(${a.legs - 1} Umst.)</small>` : ''}</td>
              <td>${a.railMin ?? '–'}</td><td>${a.railPoints ?? '–'}</td><td>${esc(a.result)}</td></tr>`,
          )
          .join('')}</tbody></table></div>
        <p class="muted">Kriterien: Start und Ziel an U-/S-Bahn, 3–12 km, mindestens ein Umstieg, nur mit bekannten Linien ${p.rules.railMin}–${p.rules.railMax} Punkte, Stationen der letzten ${p.rules.varietyDays} Tage ausgelassen.</p>
      </div>`;
    panel.querySelector('#back')!.addEventListener('click', onBack);
    panel.querySelector('#again')!.addEventListener('click', () => void load());
    panel.querySelector<HTMLInputElement>('#day')!.addEventListener('change', (e) => {
      day = (e.target as HTMLInputElement).value || viennaDay();
      void load();
    });
  }

  void load();
  return { destroy: () => app.map.clear() };
}
