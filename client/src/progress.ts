// Spielerfahrung im Browser: Tutorial gemacht? Wie viele Spiele gespielt? (für das Tutorial-Angebot auf der Startseite)
import { loadJson, saveJson } from './storage.ts';

const KEY = 'oeffi-progress-v1';
interface Progress {
  tutorialDone: boolean;
  /** abgeschlossene Routenjagd-/Quiz-Spiele und Trainings */
  played: number;
}

const read = () => loadJson<Progress>(KEY, { tutorialDone: false, played: 0 });

/** Tutorial anbieten: nicht gemacht und noch keine 2 normalen Spiele */
export const offerTutorial = () => {
  const p = read();
  return !p.tutorialDone && p.played < 2;
};

export function setTutorialDone() {
  saveJson(KEY, { ...read(), tutorialDone: true });
}

const counted = new Set<string>();

/** ein normales Spiel abgeschlossen (Endstand-Bildschirm) – mit `once`: nur einmal pro Seitenaufruf (Training) */
export function markPlayed(once?: string) {
  if (once && counted.has(once)) return;
  if (once) counted.add(once);
  const p = read();
  saveJson(KEY, { ...p, played: p.played + 1 });
}
