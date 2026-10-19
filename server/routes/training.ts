// Trainingsmodus (ohne Lobby): Strecke holen, eigene Route auswerten
import type { Express } from 'express';
import { h, MIN, param } from '../http.ts';
import { rateLimit } from '../security.ts';
import type { TrainingService } from '../training.ts';

export function trainingRoutes(app: Express, training: TrainingService) {
  // jede Trainingsstrecke fragt die Wiener-Linien-API ~6× ab, jede Auswertung evtl. mehrfach
  const limitTraining = rateLimit('training', 40, 10 * MIN, 'Viele Trainingsstrecken in kurzer Zeit – bitte kurz warten.');
  const limitTrainingEval = rateLimit('training-eval', 80, 10 * MIN);
  app.post('/api/training/round', limitTraining, h((req) => training.create(req.body?.settings, req.body?.pair)));
  app.post('/api/training/:id/evaluate', limitTrainingEval, h((req) => training.evaluate(param(req, 'id'), req.body?.legs)));
}
