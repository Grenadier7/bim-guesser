// Admin-Seite, Reiter „Einstellungen“: alles, was das Spiel ausmacht, ohne Code zu ändern – Hinweis für alle,
// Uhrzeiten, Netz-Auswahl, „Was zählt?“, Joker, Schwierigkeit, Standard-Einstellungen der Lobbys, Haltestellen-Auswahl,
// Adressen, Chat-Moderation. Jeder Bereich: speichern, auf Standard zurück, „geändert“-Hinweis; frühere Versionen.
import type { GameConfig, GameConfigSection, PresetId } from '../../../shared/config.ts';
import { QUIZ_QUESTION_COUNTS, QUIZ_TIMES } from '../../../shared/quiz.ts';
import { ruleMatches } from '../../../shared/pools.ts';
import { DISTANCES, MODE_LABEL, NET_MODES, RESTRICTION_FREQUENCIES, SCORING_MODES, STATION_GROUPS, STATION_KINDS, TIME_LIMITS, TIME_SLOTS, XTREME_LEVELS, scoringModeOf, type ScoringMode } from '../../../shared/rules.ts';
import type { DayType, Mode, StationKind, TipKind } from '../../../shared/types.ts';
import type { NetIndex } from '../net.ts';
import { esc, toast } from '../ui.ts';

import { adm, planNet } from './api.ts';
import { addrMap, type AddrRow } from './addrmap.ts';
import { mountPickers, pickerSlot } from './picker.ts';
import type { Tab } from './plans.ts';

interface ConfigState {
  config: GameConfig;
  changed: GameConfigSection[];
  defaults: GameConfig;
  labels: Record<GameConfigSection, string>;
}

const TIP_WHAT: Record<TipKind, string> = {
  startLines: 'Linien an der Start-Station',
  endLines: 'Linien an der Ziel-Station',
  modeChain: 'Verkehrsmittel der schnellsten Route',
  transfers: 'Umstiegsorte der schnellsten Route auf der Karte',
};

const ORDER: GameConfigSection[] = ['announcement', 'slots', 'netModes', 'scoring', 'tips', 'difficulty', 'defaults', 'pools', 'addresses', 'chat'];
const DAY_LABEL: Record<DayType, string> = { wd: 'Werktag', sa: 'Samstag', su: 'Sonntag' };
const PRESET_IDS: PresetId[] = ['easy', 'medium', 'hard', 'expert'];
const date = (t: number) => new Date(t).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' });

/** Wert an „a.b.c“ setzen */
function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const ks = path.split('.');
  let x = o;
  for (const k of ks.slice(0, -1)) x = (x[k] ??= {}) as Record<string, unknown>;
  x[ks[ks.length - 1]] = v;
}

export function settingsTab(rerender: () => void): Tab {
  let st: ConfigState | null = null;
  let open: GameConfigSection | null = 'announcement';
  /** Entwurf je Bereich (erst „Speichern“ übernimmt) */
  const drafts = new Map<GameConfigSection, unknown>();
  let net: NetIndex | null = null;
  let addrQuery = '';
  let addrHits: { id: string; name: string; district: number; removed: boolean; own: boolean }[] = [];
  /** alle Adressen für die Karte (einmal geladen) und wo die Karte zuletzt stand */
  let addrAll: AddrRow[] | null = null;
  let addrView: { lat: number; lon: number; zoom: number } | null = null;
  let addrShow: ((id: string) => void) | null = null;
  let versions: { id: string; at: number; by: string; note: string }[] | null = null;
  /** zuletzt bearbeitete Haltestellen-Gruppe bleibt offen */
  let openPool = '';

  const draft = <K extends GameConfigSection>(k: K): GameConfig[K] => {
    if (!drafts.has(k)) drafts.set(k, structuredClone(st!.config[k]));
    return drafts.get(k) as GameConfig[K];
  };

  // -------------------------------------------------------------- Bereiche

  const inp = (path: string, value: string | number, attrs = '') => `<input data-cfg="${path}" value="${esc(String(value))}" ${attrs}>`;
  const num = (path: string, value: number, attrs = '') => `<input type="number" data-cfg="${path}" data-type="num" value="${value}" ${attrs}>`;
  const chk = (path: string, on: boolean, label: string) => `<label class="check"><input type="checkbox" data-cfg="${path}" data-type="bool" ${on ? 'checked' : ''}> ${label}</label>`;
  const sel = (path: string, value: string, opts: [string, string][], type = '') =>
    `<select data-cfg="${path}" ${type ? `data-type="${type}"` : ''}>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  function section(k: GameConfigSection): string {
    switch (k) {
      case 'announcement': {
        const d = draft('announcement');
        return `<label class="field"><span>Text oben für alle Spieler (leer = kein Hinweis)</span><textarea data-cfg="text" maxlength="300" rows="2" placeholder="z.B. Heute 20 Uhr: Turnier – Code kommt im Chat">${esc(d.text)}</textarea></label>`;
      }
      case 'slots': {
        const d = draft('slots');
        const ids = Object.keys(d);
        return `<table class="adm-table adm-slots"><thead><tr><th>Kurzname (Knopf)</th><th>Name (Tooltip)</th><th>Tag</th><th>Uhrzeit</th><th></th></tr></thead><tbody>${ids
          .map(
            (id, i) =>
              `<tr><td>${inp(`${id}.short`, d[id].short, 'maxlength="20"')}</td><td>${inp(`${id}.label`, d[id].label, 'maxlength="40"')}</td><td>${sel(`${id}.day`, d[id].day, Object.entries(DAY_LABEL) as [string, string][])}</td><td><input type="time" data-cfg="${id}.time" value="${d[id].time}"></td>
              <td class="adm-slotbtns"><button type="button" class="icon-btn" data-slotmove="${i}|-1" ${i ? '' : 'disabled'} aria-label="nach oben">↑</button><button type="button" class="icon-btn" data-slotmove="${i}|1" ${i < ids.length - 1 ? '' : 'disabled'} aria-label="nach unten">↓</button><button type="button" class="icon-btn" data-rmslot="${esc(id)}" ${ids.length > 1 ? '' : 'disabled'} aria-label="Uhrzeit entfernen" title="${ids.length > 1 ? 'Uhrzeit entfernen' : 'Mindestens eine Uhrzeit bleibt'}">✕</button></td></tr>`,
          )
          .join('')}</tbody></table>
          <div class="adm-row">${ids.length < 8 ? '<button type="button" class="btn btn-ghost btn-small" id="slot-add">+ Uhrzeit hinzufügen</button>' : '<small class="muted">Höchstens 8 Uhrzeiten.</small>'}</div>
          <p class="muted">1 bis 8 Uhrzeiten – so viele Knöpfe gibt es in der Lobby und im Training. Gespielt wird am Referenztag des gewählten Tagestyps zur angegebenen Uhrzeit; zwischen 0 und 5 Uhr nur mit Stationen, an denen U-Bahn oder Nachtbus fährt. Lobbys mit einer entfernten Uhrzeit spielen mit der ersten.</p>`;
      }
      case 'netModes': {
        const d = draft('netModes');
        return `<div class="adm-grid2"><label class="field"><span>„Regulär“ – Name</span>${inp('regular.label', d.regular.label, 'maxlength="20"')}</label>
          <label class="field"><span>Erklärung</span>${inp('regular.hint', d.regular.hint, 'maxlength="200"')}</label>
          <label class="field"><span><span class="adm-live-badge"><i></i>LIVE</span> „Aktuell“ – Name</span>${inp('current.label', d.current.label, 'maxlength="20"')}</label>
          <label class="field"><span>Erklärung</span>${inp('current.hint', d.current.hint, 'maxlength="200"')}</label></div>
          ${chk('current.enabled', d.current.enabled, '„Aktuell“ (nächster echter Tag mit Baustellen) wählbar')}
          <p class="muted">„Aktuell“ spielt am nächsten echten Tag mit Baustellen und Ersatzverkehr – was gerade anders fährt, steht unter „Netzpläne“ → „Aktuell“. Weitere Netze: unter „Netzpläne“ einen Plan anlegen und „In der Lobby wählbar“ setzen.</p>`;
      }
      case 'scoring': {
        const d = draft('scoring');
        const ex = 30 + 2 * d.transferPenalty;
        return `<p class="muted">Drei Wertungen – jede mit Name, Symbol, Erklärung (Tooltip in der Lobby) und Kurztext, der bei den Minuten steht (Runde, Auflösung). Was gerechnet wird, bleibt je Wertung gleich: <b>Realistisch</b> = Tür zu Tür mit Ø-Wartezeit, <b>Wie die Auskunft</b> = echte Abfahrten ab Startzeit, <b>Nur Fahrzeit</b> = ab dem Einsteigen.</p>
          ${(Object.keys(d.modes) as ScoringMode[])
            .map(
              (id) => `<div class="adm-box adm-mode ${d.modes[id].enabled ? '' : 'off'}"><div class="adm-modehead"><span class="adm-modeprev">${esc(d.modes[id].icon)} ${esc(d.modes[id].label)}</span>${chk(`modes.${id}.enabled`, d.modes[id].enabled, 'in der Lobby wählbar')}</div>
            <div class="adm-grid3"><label class="field"><span>Symbol</span>${inp(`modes.${id}.icon`, d.modes[id].icon, 'maxlength="8"')}</label><label class="field"><span>Name</span>${inp(`modes.${id}.label`, d.modes[id].label, 'maxlength="30"')}</label><label class="field"><span>Kurztext bei den Minuten</span>${inp(`modes.${id}.unit`, d.modes[id].unit, 'maxlength="30"')}</label></div>
            <label class="field"><span>Erklärung (Tooltip)</span><textarea data-cfg="modes.${id}.hint" rows="2" maxlength="400">${esc(d.modes[id].hint)}</textarea></label>
            ${
              id === 'realistic'
                ? `<div class="adm-sub"><div class="adm-modehead"><b>Zusatz: ${esc(d.avoid.label)}</b>${chk('avoid.enabled', d.avoid.enabled, 'anbieten')}</div>
                <div class="adm-grid2"><label class="field"><span>Name</span>${inp('avoid.label', d.avoid.label, 'maxlength="30"')}</label>
                <label class="field adm-inline"><span>Aufschlag je Umstieg</span>${num('transferPenalty', d.transferPenalty, 'min="0" max="15"')} min</label></div>
                <label class="field"><span>Erklärung – <code>{min}</code> wird durch den Aufschlag ersetzt</span><textarea data-cfg="avoid.hint" rows="2" maxlength="400">${esc(d.avoid.hint)}</textarea></label>
                <small class="muted">Beispiel in der Lobby: 30 min mit 2 Umstiegen zählen als ${ex} min – eine direkte Verbindung mit ${ex - 1} min gewinnt. Wie viel der Wartezeit an der ersten Haltestelle zählt, steht je Netzplan unter „Netzpläne“ → „Plan & Routenberechnung“.</small></div>`
                : ''
            }</div>`,
            )
            .join('')}`;
      }
      case 'tips': {
        const d = draft('tips');
        return `<table class="adm-table"><thead><tr><th>Zeigt</th><th>Name</th><th>Abzug</th></tr></thead><tbody>${(Object.keys(d.kinds) as TipKind[])
          .map((k) => `<tr><td><small class="muted">${TIP_WHAT[k]}</small></td><td>${inp(`kinds.${k}.label`, d.kinds[k].label, 'maxlength="40"')}</td><td>${num(`kinds.${k}.share`, Math.round(d.kinds[k].share * 100), 'min="0" max="90" data-pct="1"')} %</td></tr>`)
          .join('')}</tbody></table>
          <div class="adm-grid2"><label class="field adm-inline"><span>Stufe „Günstig“</span>${num('levels.cheap', Math.round(d.levels.cheap * 100), 'min="-50" max="50" data-pct="1"')} Prozentpunkte</label>
          <label class="field adm-inline"><span>Stufe „Teuer“</span>${num('levels.expensive', Math.round(d.levels.expensive * 100), 'min="-50" max="50" data-pct="1"')} Prozentpunkte</label></div>
          <p class="muted">Abzug = Anteil der Routenpunkte, der für den Joker wegfällt; die Stufen verschieben alle Joker gleich.</p>`;
      }
      case 'difficulty': {
        const d = draft('difficulty');
        return `<table class="adm-table adm-presets"><thead><tr><th>Schnellwahl</th><th>Haltestellen</th><th>Entfernung</th><th>Umstiege</th></tr></thead><tbody>${PRESET_IDS.map((id) => {
          const p = d.presets[id];
          return `<tr><td>${inp(`presets.${id}.label`, p.label, 'maxlength="20"')}</td><td class="adm-kindbox">${STATION_KINDS.map(
            (k) => `<label class="check"><input type="checkbox" data-kind-of="${id}" value="${k.id}" ${p.stations.includes(k.id) ? 'checked' : ''}> ${esc(k.label)}</label>`,
          ).join('')}</td><td>${sel(`presets.${id}.distance`, p.distance, DISTANCES.map((x) => [x.id, x.label]))}</td><td>${sel(`presets.${id}.minTransfers`, String(p.minTransfers), [['0', '0'], ['1', 'mind. 1'], ['2', 'mind. 2']], 'num')}</td></tr>`;
        }).join('')}</tbody></table>
        <h4>Punkte-Faktoren</h4><div class="adm-grid3">${STATION_KINDS.map((k) => `<label class="field adm-inline"><span>${esc(k.label)}</span>${num(`stationFactors.${k.id}`, d.stationFactors[k.id], 'step="0.05" min="0.3" max="3"')}</label>`).join('')}
        ${DISTANCES.map((x) => `<label class="field adm-inline"><span>Entfernung ${esc(x.label)}</span>${num(`distanceFactors.${x.id}`, d.distanceFactors[x.id], 'step="0.05" min="0.3" max="3"')}</label>`).join('')}</div>`;
      }
      case 'defaults': {
        const d = draft('defaults');
        const r = d.route;
        const mode = scoringModeOf(r) ?? 'realistic';
        return `<h4>🏁 Routenjagd</h4><div class="adm-grid3">
          <label class="field"><span>Uhrzeit</span>${sel('route.slot', r.slot, TIME_SLOTS.map((t) => [t.id, t.short]))}</label>
          <label class="field"><span>Netz</span>${sel('route.network', r.network, NET_MODES.map((n) => [n.id, n.label]))}</label>
          <label class="field"><span>Schwierigkeit</span>${sel('route.difficulty', r.difficulty === 'custom' ? 'medium' : r.difficulty, PRESET_IDS.map((id) => [id, draft('difficulty').presets[id].label]))}</label>
          <label class="field"><span>Runden</span>${sel('route.rounds', String(r.rounds), [3, 5, 7, 10].map((n) => [String(n), String(n)]), 'num')}</label>
          <label class="field"><span>Zeitlimit</span>${sel('route.roundTimeLimitSec', String(r.roundTimeLimitSec), [...TIME_LIMITS.map((n) => [String(n), `${n / 60}:00`] as [string, string]), ['null', 'ohne']], 'numnull')}</label>
          <label class="field"><span>Was zählt?</span>${sel('route.scoring', mode, SCORING_MODES.map((m) => [m.id, m.label]), 'scoring')}</label>
          <label class="field"><span>Tipps</span>${sel('route.tips', r.tips, [['off', 'Keine'], ['cheap', 'Günstig'], ['expensive', 'Teuer']])}</label>
          <label class="field"><span>Challenges</span>${sel('route.restrictions', r.restrictions, RESTRICTION_FREQUENCIES.map((x) => [x.id, x.label]))}</label>
          <label class="field"><span>X-TREME</span>${sel('route.xtreme', r.xtreme, XTREME_LEVELS.map((x) => [x.id, x.label]))}</label>
          <label class="field"><span>Start & Ziel</span>${sel('route.endpoints', r.endpoints, [['stations', 'Haltestellen'], ['addresses', 'Adressen']])}</label></div>
          ${chk('route.locate', r.locate, '„Wo liegt das?“')} ${chk('route.avoidTransfers', r.goal === 'best', 'Umstiege vermeiden')}
          <h4>🧠 Quiz</h4><div class="adm-grid3">
          <label class="field"><span>Fragen</span>${sel('quiz.questions', String(d.quiz.questions), QUIZ_QUESTION_COUNTS.map((n) => [String(n), String(n)]), 'num')}</label>
          <label class="field"><span>Zeit pro Frage</span>${sel('quiz.timeSec', String(d.quiz.timeSec), QUIZ_TIMES.map((n) => [String(n), `${n} s`]), 'num')}</label>
          <label class="field"><span>Gebiet (0 = ganz Wien)</span>${num('quiz.area', d.quiz.area, 'min="0" max="23"')}</label></div>
          <div class="adm-row">${(['U', 'S', 'T', 'B', 'N'] as Mode[]).map((m) => `<label class="check"><input type="checkbox" data-quizmode="${m}" ${d.quiz.modes.includes(m) ? 'checked' : ''}> ${MODE_LABEL[m]}</label>`).join('')}</div>
          <h4>🏋️ Training</h4><div class="adm-grid3">
          <label class="field"><span>Uhrzeit</span>${sel('training.slot', d.training.slot, TIME_SLOTS.map((t) => [t.id, t.short]))}</label>
          <label class="field"><span>Schwierigkeit</span>${sel('training.preset', d.training.preset, PRESET_IDS.map((id) => [id, draft('difficulty').presets[id].label]))}</label>
          <label class="field"><span>Gebiet (0 = ganz Wien)</span>${num('training.area', d.training.area, 'min="0" max="23"')}</label></div>
          ${chk('training.coach', d.training.coach, 'Coach-Rückmeldungen')}
          <p class="muted">Gilt für neue Lobbys. Wer schon einmal gespielt hat, startet mit seinen eigenen letzten Einstellungen.</p>`;
      }
      case 'pools': {
        const d = draft('pools');
        if (!net) return '';
        const n = net;
        const modeOf: Record<string, Mode> = { Ukey: 'U', U: 'U', Skey: 'S', S: 'S', Tkey: 'T', T: 'T' };
        return STATION_GROUPS.map(
          (g) => `<h4>${g.icon} ${esc(g.label)}</h4>${g.levels
            .map((k) => {
              const add = new Set(d.add[k.id] ?? []);
              const rem = new Set(d.remove[k.id] ?? []);
              const member = (s: (typeof n.data.stations)[number]) => add.has(s.id) || (!rem.has(s.id) && ruleMatches(s, k.id, (id) => n.lines.get(id)));
              const mode = modeOf[k.id];
              const count = n.data.stations.filter(member).length;
              const changes = add.size + rem.size;
              // Schiene: alle Stationen dieses Verkehrsmittels zum An-/Abwählen; Bus (Tausende): nur Suche
              const chips = mode
                ? `<div class="adm-poolchips">${n.data.stations
                    .filter((s) => s.modes.includes(mode))
                    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
                    .map((s) => {
                      const on = member(s);
                      const why = add.has(s.id) ? 'added' : rem.has(s.id) ? 'removed' : '';
                      return `<button type="button" class="adm-pool ${on ? 'on' : ''} ${why}" data-pooltoggle="${k.id}:${s.id}" title="${on ? 'dabei – klicken zum Ausnehmen' : 'nicht dabei – klicken zum Aufnehmen'}">${why === 'added' ? '✚ ' : why === 'removed' ? '✕ ' : ''}${esc(s.name)}</button>`;
                    })
                    .join('')}</div>`
                : `<div class="adm-grid2"><div class="field"><span>Zusätzlich dabei</span><div class="adm-tags">${
                    [...add].map((id) => `<span class="adm-tag">${esc(n.stations.get(id)?.name ?? id)}<button type="button" data-pool="add:${k.id}:${esc(id)}" aria-label="entfernen">✕</button></span>`).join('') || '<small class="muted">–</small>'
                  }</div>${pickerSlot('station', `add:${k.id}`, '', 'Station hinzufügen …')}</div>
                  <div class="field"><span>Ausgenommen</span><div class="adm-tags">${
                    [...rem].map((id) => `<span class="adm-tag">${esc(n.stations.get(id)?.name ?? id)}<button type="button" data-pool="remove:${k.id}:${esc(id)}" aria-label="entfernen">✕</button></span>`).join('') || '<small class="muted">–</small>'
                  }</div>${pickerSlot('station', `remove:${k.id}`, '', 'Station ausnehmen …')}</div></div>`;
              return `<details class="adm-box adm-poolbox" ${openPool === k.id ? 'open' : ''}><summary><b>${esc(k.label)}</b> <small class="muted">${count} Stationen${changes ? ` · ${changes} von Hand geändert` : ''} · ${esc(k.hint)}</small></summary>${chips}</details>`;
            })
            .join('')}`,
        ).join('');
      }
      case 'addresses': {
        const d = draft('addresses');
        return `<p class="adm-addrlegend"><b>${(addrAll?.length ?? 0) + d.added.length - d.removed.length}</b> Adressen als Start/Ziel ·
            <span><i class="on"></i>aktiv</span><span><i class="off"></i>ausgenommen (<span id="ad-count">${d.removed.length}</span>)</span><span><i class="own"></i>eigene (${d.added.length})</span></p>
          <div class="adm-addrmap" id="ad-map"></div>
          <p class="muted">Punkt anklicken: ausnehmen oder wieder aufnehmen (eigene: entfernen). Leere Stelle anklicken: dort eine eigene Adresse anlegen. Ab Zoom 15 lassen sich einzelne Häuser gut treffen. Erst „Speichern“ übernimmt.</p>
          <div class="field"><span>Adresse suchen</span><input class="line-input" id="ad-q" value="${esc(addrQuery)}" placeholder="z.B. Hauptstraße" autocomplete="off"></div>
          ${addrHits.length ? `<ul class="adm-list">${addrHits.map((a) => {
            const off = d.removed.includes(a.id);
            return `<li><span>${esc(a.name)} <small class="muted">${a.district}. Bezirk${a.own ? ' · eigene' : ''}${off ? ' · ausgenommen' : ''}</small></span><span class="adm-row"><button type="button" class="link" data-addrshow="${a.id}">auf der Karte</button><button type="button" class="btn btn-ghost btn-small" data-addr="${a.id}">${off ? 'Wieder aufnehmen' : 'Ausnehmen'}</button></span></li>`;
          }).join('')}</ul>` : ''}
          <h4>Eigene Adressen</h4>${d.added.length ? `<ul class="adm-list">${d.added.map((a, i) => `<li><span>${esc(a.name)} <small class="muted">${a.district}. Bezirk</small></span><span class="adm-row"><button type="button" class="link" data-addrshow="own:${i}">auf der Karte</button><button type="button" class="icon-btn" data-rmaddr="${i}" aria-label="entfernen">✕</button></span></li>`).join('')}</ul>` : '<p class="muted">Keine – auf der Karte eine leere Stelle anklicken.</p>'}
          `;
      }
      case 'chat': {
        const d = draft('chat');
        const missing = st!.defaults.chat.words.filter((w) => !d.words.includes(w));
        return `<label class="field"><span>Gesperrte Wörter und Ausdrücke – einer pro Zeile (${d.words.length})</span><textarea id="chat-words" rows="10">${esc(d.words.join('\n'))}</textarea></label>
          ${missing.length ? `<div class="adm-row"><button type="button" class="btn btn-ghost btn-small" id="chat-merge">${missing.length} fehlende Standard-Wörter ergänzen</button><small class="muted">Deutsch, Englisch, Türkisch, Serbisch/Kroatisch/Bosnisch – deine eigenen bleiben.</small></div>` : ''}
          <p class="muted">Im Chat werden sie durch Sternchen ersetzt, als Spieler- oder Account-Name abgelehnt. Erkennt auch Tarnung wie Ziffern (f1ck), Punkte (f.u.c.k) oder gedehnte Buchstaben. Wörter bis 4 Buchstaben nur als ganzes Wort.</p>`;
      }
    }
  }

  async function html(): Promise<string> {
    st ??= await adm<ConfigState>('GET', '/api/admin/config');
    net ??= await planNet('regular');
    if (open === 'addresses') addrAll ??= await adm<AddrRow[]>('GET', '/api/admin/addresses/all');
    return `<p class="muted">Gilt sofort für neue Lobbys und alle, die die Seite neu laden. „Standard“ = Wert aus dem Spiel selbst.</p>
      ${ORDER.map(
        (k) => `<details class="adm-sec" data-sec="${k}" ${open === k ? 'open' : ''}><summary>${esc(st!.labels[k])}${st!.changed.includes(k) ? ' <span class="adm-badge adm-badge-mod">geändert</span>' : ''}</summary>
          ${open === k ? `<div class="adm-sec-body">${section(k)}<div class="adm-row adm-save"><button class="btn btn-primary" data-save="${k}">Speichern</button>${st!.changed.includes(k) ? `<button class="btn btn-ghost" data-reset="${k}">Auf Standard</button>` : ''}${drafts.has(k) && JSON.stringify(drafts.get(k)) !== JSON.stringify(st!.config[k]) ? `<button class="btn btn-ghost" data-discard="${k}">Verwerfen</button>` : ''}</div></div>` : ''}</details>`,
      ).join('')}
      <details class="adm-versions" ${versions ? 'open' : ''}><summary>Frühere Versionen</summary>${
        versions
          ? versions.length
            ? `<ul class="adm-list">${versions.map((v) => `<li><span>${date(v.at)} · ${esc(v.by)} · ${esc(v.note)}</span><button class="btn btn-ghost btn-small" data-restore="${v.id}">Wiederherstellen</button></li>`).join('')}</ul>`
            : '<p class="muted">Noch keine.</p>'
          : '<p class="muted">Lädt …</p>'
      }</details>`;
  }

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message);
    }
    rerender();
  };

  /** Entwurf für den Server: Lobby-Standard „Was zählt?“ und „Umstiege vermeiden“ in die eigentlichen Felder */
  function value(k: GameConfigSection): unknown {
    const d = structuredClone(draft(k)) as Record<string, unknown>;
    if (k === 'defaults') {
      const r = d.route as Record<string, unknown>;
      const m = SCORING_MODES.find((x) => x.id === (r.scoring ?? scoringModeOf(r as never) ?? 'realistic'))!;
      Object.assign(r, m.settings, { goal: r.avoidTransfers && m.id === 'realistic' ? 'best' : 'fastest' });
      delete r.scoring;
      delete r.avoidTransfers;
    }
    return d;
  }

  function bind(root: HTMLElement) {
    root.querySelectorAll<HTMLDetailsElement>('details.adm-sec').forEach((d) =>
      d.addEventListener('toggle', () => {
        if (d.open && open !== d.dataset.sec) {
          open = d.dataset.sec as GameConfigSection;
          rerender();
        } else if (!d.open && open === d.dataset.sec) open = null;
      }),
    );
    if (!open) return bindVersions(root);
    const k = open;
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-cfg]').forEach((el) =>
      el.addEventListener('change', () => {
        const t = el.dataset.type;
        const raw = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
        let v: unknown = raw;
        if (t === 'num') v = Number(raw);
        if (t === 'numnull') v = raw === 'null' ? null : Number(raw);
        if (el.dataset.pct) v = Number(raw) / 100;
        setPath(draft(k) as unknown as Record<string, unknown>, el.dataset.cfg!, v);
      }),
    );
    // Schnellwahl: Haltestellen-Arten
    root.querySelectorAll<HTMLInputElement>('[data-kind-of]').forEach((el) =>
      el.addEventListener('change', () => {
        const p = draft('difficulty').presets[el.dataset.kindOf as PresetId];
        const set = new Set(p.stations);
        if (el.checked) set.add(el.value as StationKind);
        else set.delete(el.value as StationKind);
        p.stations = STATION_KINDS.map((x) => x.id).filter((x) => set.has(x));
      }),
    );
    root.querySelectorAll<HTMLInputElement>('[data-quizmode]').forEach((el) =>
      el.addEventListener('change', () => {
        const q = draft('defaults').quiz;
        const m = el.dataset.quizmode as Mode;
        q.modes = el.checked ? [...new Set([...q.modes, m])] : q.modes.filter((x) => x !== m);
      }),
    );
    root.querySelector('#chat-merge')?.addEventListener('click', () => {
      const d = draft('chat');
      d.words = [...d.words, ...st!.defaults.chat.words.filter((w) => !d.words.includes(w))];
      rerender();
    });
    root.querySelector<HTMLTextAreaElement>('#chat-words')?.addEventListener('change', (e) => {
      draft('chat').words = (e.target as HTMLTextAreaElement).value
        .split('\n')
        .map((w) => w.trim())
        .filter(Boolean);
    });
    // Haltestellen-Auswahl
    if (net)
      mountPickers(root, net, (key, id) => {
        const [side, kind] = key.split(':') as ['add' | 'remove', StationKind];
        const p = draft('pools');
        p[side][kind] = [...new Set([...(p[side][kind] ?? []), id])];
        rerender();
      });
    // Station in einer Gruppe an-/abwählen: Regel-Mitglied → ausnehmen, sonst aufnehmen; Ausnahme wieder aufheben
    root.querySelectorAll<HTMLButtonElement>('[data-pooltoggle]').forEach((b) =>
      b.addEventListener('click', () => {
        const [kind, id] = b.dataset.pooltoggle!.split(':') as [StationKind, string];
        const p = draft('pools');
        const add = new Set(p.add[kind] ?? []);
        const rem = new Set(p.remove[kind] ?? []);
        const st = net!.stations.get(id)!;
        const rule = ruleMatches(st, kind, (x) => net!.lines.get(x));
        if (add.has(id)) add.delete(id);
        else if (rem.has(id)) rem.delete(id);
        else if (rule) rem.add(id);
        else add.add(id);
        p.add[kind] = [...add];
        p.remove[kind] = [...rem];
        openPool = kind;
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-pool]').forEach((b) =>
      b.addEventListener('click', () => {
        const [side, kind, id] = b.dataset.pool!.split(':') as ['add' | 'remove', StationKind, string];
        const p = draft('pools');
        p[side][kind] = (p[side][kind] ?? []).filter((x) => x !== id);
        rerender();
      }),
    );
    // Adressen
    const q = root.querySelector<HTMLInputElement>('#ad-q');
    let t: ReturnType<typeof setTimeout>;
    q?.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(
        () =>
          void run(async () => {
            addrQuery = q.value;
            addrHits = await adm('GET', `/api/admin/addresses?q=${encodeURIComponent(q.value)}`);
          }).then(() => {
            const n = root.ownerDocument.querySelector<HTMLInputElement>('#ad-q');
            n?.focus();
            n?.setSelectionRange(n.value.length, n.value.length);
          }),
        300,
      );
    });
    root.querySelectorAll<HTMLButtonElement>('[data-addr]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = draft('addresses');
        const id = b.dataset.addr!;
        a.removed = a.removed.includes(id) ? a.removed.filter((x) => x !== id) : [...a.removed, id];
        rerender();
      }),
    );
    // Uhrzeiten: hinzufügen, entfernen, Reihenfolge (Reihenfolge der Schlüssel = Reihenfolge der Knöpfe)
    root.querySelector('#slot-add')?.addEventListener('click', () => {
      const d = draft('slots');
      d[`s${Date.now().toString(36).slice(-6)}`] = { short: 'Neu', label: 'Neue Uhrzeit', day: 'wd', time: '08:00' };
      rerender();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-rmslot]').forEach((b) =>
      b.addEventListener('click', () => {
        delete draft('slots')[b.dataset.rmslot!];
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-slotmove]').forEach((b) =>
      b.addEventListener('click', () => {
        const [i, dir] = b.dataset.slotmove!.split('|').map(Number);
        const d = draft('slots');
        const list = Object.entries(d);
        [list[i], list[i + dir]] = [list[i + dir], list[i]];
        drafts.set('slots', Object.fromEntries(list));
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-rmaddr]').forEach((b) => b.addEventListener('click', () => (draft('addresses').added.splice(Number(b.dataset.rmaddr), 1), rerender())));
    const map = root.querySelector<HTMLElement>('#ad-map');
    if (map && addrAll) {
      const d = draft('addresses');
      const removed = new Set(d.removed);
      addrShow = addrMap(map, {
        all: addrAll,
        removed,
        own: d.added,
        view: addrView,
        onToggle: (id) => {
          if (removed.has(id)) removed.delete(id);
          else removed.add(id);
          d.removed = [...removed];
          const c = root.querySelector('#ad-count');
          if (c) c.textContent = String(removed.size);
        },
        onRemoveOwn: (i) => (d.added.splice(i, 1), rerender()),
        onAdd: (a) => (d.added.push(a), rerender()),
        onView: (v) => (addrView = v),
      }).show;
    }
    root.querySelectorAll<HTMLButtonElement>('[data-addrshow]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.addrshow!;
        // eigene stehen in der Suche als „a:<gebaute + Nr>“
        const i = Number(id.slice(2));
        addrShow?.(id.startsWith('a:') && addrAll && i >= addrAll.length ? `own:${i - addrAll.length}` : id);
        root.querySelector('#ad-map')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }),
    );
    // speichern / Standard / verwerfen
    root.querySelector<HTMLButtonElement>(`[data-save="${k}"]`)?.addEventListener('click', () =>
      run(async () => {
        st = await adm<ConfigState>('PUT', `/api/admin/config/${k}`, { value: value(k) });
        drafts.delete(k);
        versions = null;
        toast('Gespeichert – gilt ab sofort', 'info');
      }),
    );
    root.querySelector<HTMLButtonElement>(`[data-reset="${k}"]`)?.addEventListener('click', () => {
      if (!confirm(`„${st!.labels[k]}“ auf den Standard zurücksetzen?`)) return;
      void run(async () => {
        st = await adm<ConfigState>('DELETE', `/api/admin/config/${k}`);
        drafts.delete(k);
        versions = null;
      });
    });
    root.querySelector<HTMLButtonElement>(`[data-discard="${k}"]`)?.addEventListener('click', () => (drafts.delete(k), rerender()));
    bindVersions(root);
  }

  function bindVersions(root: HTMLElement) {
    const vd = root.querySelector<HTMLDetailsElement>('details.adm-versions');
    vd?.addEventListener('toggle', () => {
      if (vd.open && !versions)
        void run(async () => {
          versions = await adm('GET', '/api/admin/config-versions');
        });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!confirm('Alle Einstellungen auf diesen Stand zurücksetzen?')) return;
        void run(async () => {
          st = await adm<ConfigState>('POST', `/api/admin/config-versions/${b.dataset.restore}/restore`);
          drafts.clear();
          versions = null;
          toast('Wiederhergestellt', 'info');
        });
      }),
    );
  }

  return { html, bind };
}
