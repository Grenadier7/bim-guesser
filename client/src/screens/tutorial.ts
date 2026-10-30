// Tutorial (Punkt 17): zwei geführte Routenjagd-Runden mit festen Strecken – echte Auskunft und echte Wertung
// (über die Trainings-Schnittstelle), Sprechblasen zeigen Schritt für Schritt, was zu tun ist.
//   Runde 1: Praterstern → Stephansplatz (U1 eingeben, Ausstieg wählen, abgeben)
//   Runde 2: Reumannplatz → Rathaus („Rathaus ist doch U2“ → U2 fährt dort nicht → U1 bis Karlsplatz, dann U2)
//   Danach: wie die Punkte vergeben werden.
import type { Station, TrainingResult, TrainingRound } from '../../../shared/types.ts';
import { DEFAULT_SETTINGS } from '../../../shared/defaults.ts';
import { routeCost, scoreRoute, transfersOf } from '../../../shared/rules.ts';
import { api } from '../api.ts';
import { RouteBuilder } from '../builder.ts';
import { smoothRoute } from '../netmap.ts';
import { setTutorialDone } from '../progress.ts';
import { app, setMapBig } from '../store.ts';
import { chain, esc, h, toast } from '../ui.ts';
import { loadingHtml, type Screen } from './screen.ts';

/** Station mit diesem Namen, an der die Linie hält */
function stationOf(name: string, line: string): Station {
  return app.net.data.stations.find((s) => s.name === name && s.lines.includes(line)) ?? app.net.data.stations.find((s) => s.name === name)!;
}

interface Result {
  userMin: number | null;
  bestMin: number;
  points: number;
}

export function tutorialScreen(panel: HTMLElement, onBack: () => void): Screen {
  const rounds = [
    { from: stationOf('Praterstern', 'U1'), to: stationOf('Stephansplatz', 'U1') },
    { from: stationOf('Reumannplatz', 'U1'), to: stationOf('Rathaus', 'U2') },
  ];
  const results: Result[] = [];
  let idx = 0;
  let round: TrainingRound | null = null;
  let builder: RouteBuilder | null = null;
  /** Runde 2: hat man die U2 schon ausprobiert (und gesehen, dass sie hier nicht fährt)? */
  let triedU2 = false;
  let guide: HTMLElement | null = null;

  async function load() {
    setMapBig(false);
    app.map.clear();
    panel.innerHTML = loadingHtml(`Runde ${idx + 1} wird vorbereitet …`, 'Der Fahrplan wird durchgerechnet.');
    try {
      round = await api.trainingRound({ ...DEFAULT_SETTINGS, slot: 'wd12', network: 'regular' }, { from: rounds[idx].from.id, to: rounds[idx].to.id });
    } catch (e) {
      panel.innerHTML = `<div class="learn"><p class="err">${esc((e as Error).message)}</p><button class="btn btn-primary" id="retry">Nochmal</button> <button class="link" id="back">← Zurück</button></div>`;
      panel.querySelector('#retry')!.addEventListener('click', load);
      panel.querySelector('#back')!.addEventListener('click', onBack);
      return;
    }
    renderRound();
  }

  function renderRound() {
    const r = round!;
    const from = app.net.station(r.from.id);
    const to = app.net.station(r.to.id);
    app.map.clear();
    app.map.showEndpoints(r.from, r.to);
    builder = new RouteBuilder(app.net, from, to, null, () => updateGuide(), submit, [], {});
    panel.innerHTML = '';
    const head = h(
      'div',
      { class: 'tut-head' },
      `<button class="link" id="tut-quit">✕ Tutorial beenden</button>
       <div class="tut-step">🎓 Tutorial · Runde ${idx + 1} von ${rounds.length}</div>
       <div class="od"><div class="od-row"><span class="pin-dot a">A</span><b>${esc(r.from.name)}</b></div>
       <div class="od-row"><span class="pin-dot b">B</span><b>${esc(r.to.name)}</b></div></div>`,
    );
    head.querySelector('#tut-quit')!.addEventListener('click', () => {
      if (confirm('Tutorial beenden? Du kannst es später nicht mehr von der Startseite starten.')) {
        setTutorialDone();
        onBack();
      }
    });
    guide = h('div', { class: 'tut-bubble', role: 'status', 'aria-live': 'polite' });
    panel.append(head, guide, builder.el);
    updateGuide();
  }

  const say = (html: string, target?: string) => {
    if (!guide || !builder) return;
    guide.innerHTML = html;
    builder.el.querySelectorAll('.tut-focus').forEach((e) => e.classList.remove('tut-focus'));
    if (target) builder.el.querySelector(target)?.classList.add('tut-focus');
  };

  /** Sprechblase passend zum Stand des Routen-Baukastens */
  function updateGuide() {
    const b = builder;
    if (!b || !round) return;
    app.map.showDraft(b.segments(), b.transferPoints());
    const legs = b.legs;
    const draft = b.draft;
    const at = legs.length ? legs[legs.length - 1].to : round.from.id;
    const arrived = at === round.to.id;
    const lineOf = (i: number) => legs[i]?.line.id;
    if (arrived) return say('🎉 Geschafft – du bist am Ziel. Drück auf <b>„Route abgeben“</b>.', '[data-act=submit]');

    if (idx === 0) {
      if (!legs.length && !draft)
        return say(
          'Du startest bei <b>A Praterstern</b> und willst nach <b>B Stephansplatz</b>. Vom Praterstern fährt die <b>U1</b> direkt dorthin. Tippe <b>U1</b> ins Feld und drück Enter.',
          '.line-input',
        );
      if (draft && draft.line.id !== 'U1') return say(`Die ${esc(draft.line.id)} bringt dich nicht direkt hin. Tipp auf <b>„andere Linie“</b> und nimm die <b>U1</b>.`, '[data-act=change]');
      if (draft) return say('Jetzt den <b>Ausstieg</b> wählen: <b>Stephansplatz</b> (mit 🏁 markiert). Die Liste ist nach Fahrtrichtung sortiert.', '.leg-form .alight-select');
      return say('Das ist noch nicht das Ziel – ändere den Ausstieg in der Teilstrecke auf <b>Stephansplatz</b>.', '.leg-alight');
    }

    // Runde 2: erst die U2 ausprobieren, merken dass sie hier nicht fährt, dann U1 + Umstieg
    if (draft?.line.id === 'U2' && !legs.length) {
      triedU2 = true;
      return say(
        '😬 Ups – die <b>U2 fährt gar nicht beim Reumannplatz</b> (siehe Warnung: der nächste U2-Halt ist weit weg). Zu Fuß gehen ginge zwar, aber das ist wohl nicht die richtige Lösung. Tipp auf <b>„andere Linie“</b>.',
        '[data-act=change]',
      );
    }
    if (!legs.length && !draft)
      return triedU2
        ? say('Am Reumannplatz fährt die <b>U1</b>. Nimm sie bis <b>Karlsplatz</b> – dort kreuzt sie die U2. Tippe <b>U1</b> ein.', '.line-input')
        : say('Ziel ist <b>Rathaus</b> – Rathaus, das ist doch die <b>U2</b>! Tippe <b>U2</b> ein.', '.line-input');
    if (draft && !legs.length && draft.line.id === 'U1') return say('Gut! Fahr mit der U1 bis <b>Karlsplatz</b> – wähle ihn als Ausstieg.', '.leg-form .alight-select');
    if (legs.length === 1 && lineOf(0) === 'U1' && at === stationOf('Karlsplatz', 'U1').id && !draft)
      return say('Du bist am Karlsplatz. Jetzt <b>umsteigen</b>: Tippe <b>U2</b> ein – sie fährt von hier zum Rathaus.', '.line-input');
    if (draft?.line.id === 'U2') return say('Ausstieg <b>Rathaus</b> 🏁 wählen – fertig ist die Route mit einem Umstieg.', '.leg-form .alight-select');
    return say('Nicht ganz – die schnelle Lösung ist <b>U1 bis Karlsplatz</b>, dann <b>U2 bis Rathaus</b>. Mit ✕ kannst du eine Teilstrecke wieder entfernen.', '.icon-btn');
  }

  async function submit() {
    const b = builder!;
    const r = round!;
    b.lock();
    let res: TrainingResult;
    try {
      res = await api.trainingEvaluate(r.id, b.userLegs());
    } catch (e) {
      toast((e as Error).message);
      b.unlock();
      return;
    }
    const best = r.routes[0];
    const s = DEFAULT_SETTINGS;
    const bestCost = routeCost(best.medianMin, transfersOf(best), s);
    const userCost = res.durationMin == null ? null : routeCost(res.durationMin, res.route ? transfersOf(res.route) : 0, s);
    const points = userCost == null ? 0 : scoreRoute(userCost, bestCost);
    results[idx] = { userMin: res.durationMin, bestMin: best.medianMin, points };
    app.map.showReveal(r.routes.slice(0, 1).map(smoothRoute), res.route ? [{ key: 'me', name: 'Du', route: smoothRoute(res.route), isMe: true }] : [], [best.key, 'me']);
    panel.innerHTML = '';
    const last = idx + 1 >= rounds.length;
    const el = h(
      'div',
      { class: 'learn' },
      `<div class="tut-step">🎓 Tutorial · Runde ${idx + 1} von ${rounds.length}</div>
       <div class="learn-card"><h3>${points >= 950 ? '🎉 Perfekt!' : points > 0 ? '👍 Gut gemacht' : '🤔 Nicht ganz'}</h3>
         <p>Deine Route: <b>${res.durationMin ?? '–'} min</b>${res.route ? ` <span class="chainline">${chain(res.route.legs)}</span>` : ''}<br>
            Beste Verbindung: <b>${best.medianMin} min</b> <span class="chainline">${chain(best.legs)}</span></p>
         ${res.error ? `<p class="err">${esc(res.error)}</p>` : ''}
         <p><b>${points}</b> von 1000 Routenpunkten – ${idx === 0 ? 'je näher an der besten Verbindung, desto mehr.' : 'mit Umstieg genauso schnell wie die Auskunft.'}</p>
         <p class="muted">Auf der Karte: durchgezogen die beste Verbindung, gestrichelt deine Route.</p></div>
       <button class="btn btn-primary btn-big" id="tut-next">${last ? 'Wie gibt es Punkte? →' : 'Runde 2 →'}</button>`,
    );
    panel.append(el);
    el.querySelector('#tut-next')!.addEventListener('click', () => {
      if (last) return explain();
      idx++;
      void load();
    });
  }

  /** Abschluss: Punktevergabe mit den eigenen Ergebnissen */
  function explain() {
    app.map.clear();
    const total = results.reduce((a, r) => a + r.points, 0);
    panel.innerHTML = '';
    const el = h(
      'div',
      { class: 'learn' },
      `<div class="tut-step">🎓 Tutorial · So gibt es Punkte</div>
       <div class="learn-card">
         <p>Du hast in den zwei Runden <b>${total}</b> Routenpunkte geholt. Im echten Spiel kommt pro Runde dazu:</p>
         <ul class="facts">
           <li><b>Route: bis 1000 Punkte</b> – so schnell wie die beste Verbindung der Auskunft = 1000, bei 70 % länger = 0. Findest du sogar eine schnellere: bis 1300.</li>
           <li><b>⏱ Zeitbonus:</b> bis +10 %, je schneller du abgibst.</li>
           <li><b>💡 Joker</b> (Linien am Start, Umstiegsorte …) helfen, kosten aber 40–50 % der Routenpunkte.</li>
           <li><b>📍 Wo liegt das?</b> Vor der Runde Start und Ziel auf der Karte antippen: bis +150.</li>
           <li><b>Schwierigkeit:</b> mehr Haltestellen-Arten, längere Strecken und mehr Umstiege → Punkte ×0,8 bis ×1,7.</li>
         </ul>
         <p class="muted">Warten zählt mit: Linien, die selten fahren, kosten Zeit – Umsteigen auch (je 2 min).</p></div>
       <div class="learn-actions"><button class="btn btn-primary btn-big" id="tut-done">Fertig – los geht's!</button></div>`,
    );
    panel.append(el);
    el.querySelector('#tut-done')!.addEventListener('click', () => {
      setTutorialDone();
      toast('Tutorial geschafft – viel Spaß bei der Routenjagd!', 'info');
      onBack();
    });
  }

  void load();
  return {
    destroy: () => {
      setMapBig(false);
      app.map.clear();
    },
  };
}
