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

/** Liste « 1,2,3 » : 1 à 64 identifiants positifs, doublons retirés, ordre conservé. */
export const heroStatsBatchQuerySchema = z.object({
  heroIds: z
    .string()
    .regex(/^\d{1,6}(,\d{1,6}){0,63}$/, 'heroIds : 1 à 64 identifiants séparés par des virgules')
    .transform((v) => [...new Set(v.split(',').map(Number))])
    .refine((ids) => ids.every((id) => id >= 1), 'heroIds : identifiants positifs attendus')
    .optional(),
});

const matchIdSchema = z.string().regex(/^\d{1,19}$/, 'matchId : identifiant de partie invalide');

/** Routes publiques P1 : classement, statistiques méta d'un héros, détail d'une partie. */
export function createMetaRouter(meta: MetaService): Router {
  const router = Router();

  router.get('/leaderboard', async (req, res) => {
    const { region } = parse(leaderboardQuerySchema, req.query);
    res.json(await meta.leaderboard(region));
  });

  // Avant `/heroes/:heroId` (catalogue) : ce routeur est monté en premier.
  router.get('/heroes/stats', async (req, res) => {
    const { heroIds } = parse(heroStatsBatchQuerySchema, req.query);
    res.json(await meta.heroStatsBatch(heroIds));
  });

  router.get('/heroes/:heroId/stats', async (req, res) => {
    res.json(await meta.heroStats(parse(heroIdSchema, req.params.heroId)));
  });

  router.get('/matches/:matchId', async (req, res) => {
    res.json(await meta.match(parse(matchIdSchema, req.params.matchId)));
  });

  return router;
}
