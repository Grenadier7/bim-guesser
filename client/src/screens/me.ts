// „Mein Wien“: Fortschritt auf einen Blick – Level, Serie (mit Joker), Wochenziel, Medaillen und die Sammelkarte
// aller Linien und Stationen, die man auf eigenen Routen schon benutzt hat. Geht auch ohne Account.
import type { LevelInfo, Mode } from '../../../shared/types.ts';
import { JOKER_DAYS, WEEK_GOAL } from '../../../shared/career.ts';
import { MODE_ICON, MODE_LABEL, isSpecialLine } from '../../../shared/rules.ts';
import { openAccount, medalsHtml } from '../accountui.ts';
import { progressSummary } from '../career.ts';
import { netLayer, netView } from '../netmap.ts';
import { app, setMobileMap } from '../store.ts';
import { lineChip } from '../ui.ts';
import type { Screen } from './screen.ts';

export function levelBar(l: LevelInfo): string {
  const pct = Math.round(((l.xp - l.levelXp) / Math.max(1, l.nextXp - l.levelXp)) * 100);
  return `<div class="lvl"><span class="lvl-badge">Lv ${l.level}</span><div class="lvl-bar" role="progressbar" aria-label="Fortschritt bis Level ${l.level + 1}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <small>${l.xp - l.levelXp} / ${l.nextXp - l.levelXp} XP bis Level ${l.level + 1}</small></div>`;
}

/** kurze Zeile für die Startseite: Level · Serie · Woche */
export function progressStrip(): string {
  const p = progressSummary();
  const streak = p.streak.days
    ? `🔥 <b>${p.streak.days}</b> ${p.streak.days === 1 ? 'Tag' : 'Tage'}${p.streak.today ? '' : ' <small>– heute noch spielen!</small>'}`
    : '🔥 <small>Serie starten</small>';
  return `<button class="progress-strip" data-mode="me" aria-label="Mein Wien: Fortschritt ansehen">
    <span class="ps-lvl">Lv ${p.level.level}</span>
    <span>${streak}</span>
    <span>📆 ${Math.min(p.week, WEEK_GOAL)}/${WEEK_GOAL} diese Woche</span>
    <span class="ps-more">🗺️ Mein Wien ›</span></button>`;
}

const MODES: Mode[] = ['U', 'S', 'T', 'B'];

export function meScreen(panel: HTMLElement, onBack: () => void): Screen {
  const net = app.net;
  setMobileMap(false);
  const p = progressSummary();
  const used = new Set(p.career.lines);
  const regular = net.data.lines.filter((l) => !isSpecialLine(l) && l.mode !== 'N' && net.patterns(l).length);
  const stationsTotal = new Set(regular.flatMap((l) => net.patterns(l).flat())).size;
  const stationsUsed = p.career.stations.filter((id) => net.stations.has(id));

  // Karte: benutzte Linien kräftig, alles andere blass; benutzte Stationen als Punkte
  app.map.clear();
  netLayer().render(netView({ focus: new Set([...used].filter((id) => net.lines.has(id))), hubs: false, labels: used.size < 40, bothEnds: true }));
  app.map.showMarkedStops(
    stationsUsed.slice(0, 1500).map((id) => net.station(id)),
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e3000f',
  );
  app.map.cityView();

  const weekPct = Math.min(100, Math.round((p.week / WEEK_GOAL) * 100));
  const perMode = MODES.map((m) => {
    const all = regular.filter((l) => l.mode === m);
    const mine = all.filter((l) => used.has(l.id));
    return { m, all: all.length, mine };
  });

  panel.innerHTML = `
    <div class="learn me">
      <button class="link" id="back">← Zurück</button>
      <h2>🗺️ Mein Wien</h2>
      ${levelBar(p.level)}
      <div class="me-cards">
        <div class="me-card"><b class="big">🔥 ${p.streak.days}</b><span>${p.streak.days === 1 ? 'Tag' : 'Tage'} in Folge</span>
          <small class="muted">${p.streak.today ? 'heute schon gespielt ✓' : p.streak.days ? 'heute noch spielen, dann hält die Serie' : 'ein Spiel startet die Serie'}</small>
          <small class="muted">🃏 ${p.streak.jokerReady ? 'Joker bereit: ein verpasster Tag reißt die Serie nicht' : `Joker verbraucht – wieder in höchstens ${JOKER_DAYS} Tagen`}</small>
          <small class="muted">Rekord: ${p.best} ${p.best === 1 ? 'Tag' : 'Tage'}</small></div>
        <div class="me-card"><b class="big">📆 ${Math.min(p.week, WEEK_GOAL)}/${WEEK_GOAL}</b><span>Wochenziel</span>
          <div class="lvl-bar" role="progressbar" aria-label="Wochenziel" aria-valuenow="${weekPct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${weekPct}%"></i></div>
          <small class="muted">${p.week >= WEEK_GOAL ? '🎉 geschafft!' : `noch ${WEEK_GOAL - p.week} Spiele oder Strecken bis Sonntag`}</small></div>
      </div>
      ${p.guest ? '<p class="guest-hint">💾 Dein Fortschritt liegt nur in diesem Browser. <button class="link" id="signup">Mit Account auf allen Geräten behalten</button></p>' : ''}

      <h3>🗺️ Sammelkarte</h3>
      <p><b>${stationsUsed.length.toLocaleString('de-AT')}</b> von ${stationsTotal.toLocaleString('de-AT')} Stationen und <b>${perMode.reduce((n, x) => n + x.mine.length, 0)}</b> von ${perMode.reduce((n, x) => n + x.all, 0)} Linien auf eigenen Routen benutzt.</p>
      <div class="me-modes">${perMode
        .map(
          (x) => `<details class="me-mode"><summary>${MODE_ICON[x.m]} ${MODE_LABEL[x.m]} <b>${x.mine.length}/${x.all}</b>
            <span class="lvl-bar"><i style="width:${x.all ? Math.round((x.mine.length / x.all) * 100) : 0}%"></i></span></summary>
            <div class="chips">${x.mine.length ? x.mine.map((l) => lineChip(l.mode, l.id, l.color)).join('') : '<small class="muted">noch keine</small>'}</div></details>`,
        )
        .join('')}</div>
      <p class="me-legend"><span class="ml-line"></span> farbig: Linien, mit denen du schon gefahren bist ·
        <span class="ml-dot"></span> Stationen, die du dabei befahren hast (Ein-, Aus- und Durchfahrt) – nur der Abschnitt, den du selbst gefahren bist.
        Zählt bei Routenjagd, Training und Strecke des Tages, jede gültige eigene Route.</p>
      ${medalsHtml(p.medals)}
    </div>`;
  panel.querySelector('#back')!.addEventListener('click', onBack);
  panel.querySelector('#signup')?.addEventListener('click', () => openAccount());
  return {
    destroy: () => {
      app.map.clear();
      app.map.clearLearn();
    },
  };
}

