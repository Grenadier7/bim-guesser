// Trainingsmodus (ohne Lobby): Strecke holen, eigene Route auswerten
import type { Express, Request } from 'express';
import type { AccountUser, Accounts } from '../accounts.ts';
import { h, MIN, param } from '../http.ts';
import { cleanLegs } from '../settings.ts';
import { rateLimit } from '../security.ts';
import type { TrainingService } from '../training.ts';

export function trainingRoutes(app: Express, training: TrainingService, account?: { accounts: Accounts; optionalUser: (req: Request) => AccountUser | null }) {
  // jede Trainingsstrecke fragt die Wiener-Linien-API ~6× ab, jede Auswertung evtl. mehrfach
  const limitTraining = rateLimit('training', 40, 10 * MIN, 'Viele Trainingsstrecken in kurzer Zeit – nächste {wait}.');
  const limitTrainingEval = rateLimit('training-eval', 80, 10 * MIN);
  app.post('/api/training/round', limitTraining, h((req) => training.create(req.body?.settings, req.body?.pair)));
  app.post(
    '/api/training/:id/evaluate',
    limitTrainingEval,
    h(async (req) => {
      const id = param(req, 'id');
      const res = await training.evaluate(id, req.body?.legs);
      // angemeldet: Strecke zählt für Statistik und Lieblingslinien
      const u = account?.optionalUser(req);
      if (u) account!.accounts.recordTraining(u.id, id, cleanLegs(req.body?.legs), res, training.bestMin(id));
      return res;
    }),
  );
}
