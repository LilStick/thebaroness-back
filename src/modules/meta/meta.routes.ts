import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/validation';
import { heroIdSchema } from '../catalog/catalog.routes';
import { LEADERBOARD_REGIONS, type MetaService } from './meta.service';

const leaderboardQuerySchema = z.object({
  region: z
    .enum(LEADERBOARD_REGIONS, `region : ${LEADERBOARD_REGIONS.join(', ')}`)
    .default('Europe'),
});

const matchIdSchema = z.string().regex(/^\d{1,19}$/, 'matchId : identifiant de partie invalide');

/** Routes publiques P1 : classement, statistiques méta d'un héros, détail d'une partie. */
export function createMetaRouter(meta: MetaService): Router {
  const router = Router();

  router.get('/leaderboard', async (req, res) => {
    const { region } = parse(leaderboardQuerySchema, req.query);
    res.json(await meta.leaderboard(region));
  });

  router.get('/heroes/:heroId/stats', async (req, res) => {
    res.json(await meta.heroStats(parse(heroIdSchema, req.params.heroId)));
  });

  router.get('/matches/:matchId', async (req, res) => {
    res.json(await meta.match(parse(matchIdSchema, req.params.matchId)));
  });

  return router;
}
