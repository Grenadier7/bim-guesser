// Kurs-Tipp nach der Routenjagd (Logik in coach.ts): Fenster mit „Kurs starten“ / „Später“
import { api } from '../api.ts';
import { addGame, analyzeGame, loadCoach, prompted, saveCoach, suggest, TOPIC } from '../coach.ts';
import { COURSES, courseProgress } from '../learn/courses/index.ts';
import { app, endSession } from '../store.ts';
import { ask } from '../ui.ts';

export function offerCourse(gameKey: string, reveals: Parameters<typeof analyzeGame>[1]) {
  const me = app.session?.playerId;
  if (!me) return;
  const net = app.net;
  const g = analyzeGame(gameKey, reveals, me, {
    mode: (id) => net.lines.get(id)?.mode ?? null,
    district: (id) => net.stations.get(id)?.district ?? null,
  });
  const s = loadCoach();
  // je Spiel nur einmal (Endstand erscheint nach Neuladen wieder)
  if (!g || !addGame(s, g)) return;
  const progress = courseProgress();
  const tip = suggest(
    s,
    COURSES.map((c) => ({ id: c.id, done: !!progress[c.id]?.done, mastered: !!progress[c.id]?.mastered })),
  );
  saveCoach(s);
  const course = tip && COURSES.find((c) => c.id === tip.course);
  if (!tip || !course) return;
  const text =
    tip.kind === 'start'
      ? `Die schnellste Verbindung zu finden ist am Anfang nicht leicht. Willst du mit den Lernkursen starten? Der erste, „${course.title}“, dauert nur ein paar Minuten.`
      : `In deinen letzten Spielen wäre es öfter mit ${tip.lines.length ? tip.lines.join(', ') : TOPIC[course.id]} schneller gegangen. Der Kurs „${course.title}“ zeigt dir ${TOPIC[course.id] ?? 'das'} in ein paar Minuten.`;
  // erst den Endstand kurz sehen lassen
  setTimeout(async () => {
    if (!app.session || document.querySelector('dialog[open]')) return;
    const go = await ask(text, { title: `${course.icon} Kurs-Tipp`, ok: 'Kurs starten', cancel: 'Später' });
    const st = loadCoach();
    prompted(st, course.id, !go);
    saveCoach(st);
    if (!go || !app.session) return;
    const session = app.session;
    app.view = 'learn';
    app.learnStart = { course: course.id };
    endSession();
    await api.leave(session).catch(() => {});
  }, 1500);
}
