import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/validation';
import type { CatalogService } from '../catalog/catalog.service';
import { heroIdSchema } from '../catalog/catalog.routes';
import { analyticsQuerySchema } from '../items/items.routes';
import { BUILD_SORTS, type BuildsService } from './builds.service';

const buildsQuerySchema = z.object({
  sort: z
    .enum(BUILD_SORTS, 'sort : favorites, weekly_favorites, updated_at ou published_at')
    .default('favorites'),
  limit: z.coerce
    .number('limit : entier entre 1 et 50')
    .int('limit : entier entre 1 et 50')
    .min(1, 'limit : entier entre 1 et 50')
    .max(50, 'limit : entier entre 1 et 50')
    .default(10),
});

const pairsQuerySchema = analyticsQuerySchema.omit({ heroId: true }).extend({
  itemId: z.coerce
    .number('itemId : identifiant d’item invalide')
    .int('itemId : identifiant d’item invalide')
    .nonnegative('itemId : identifiant d’item invalide')
    .optional(),
  limit: z.coerce
    .number('limit : entier entre 1 et 100')
    .int('limit : entier entre 1 et 100')
    .min(1, 'limit : entier entre 1 et 100')
    .max(100, 'limit : entier entre 1 et 100')
    .default(20),
});

/** Builds publiés et paires d'items d'un héros (404 si le héros n'existe pas). */
export function createBuildsRouter(builds: BuildsService, catalog: CatalogService): Router {
  const router = Router();

  router.get('/heroes/:heroId/builds', async (req, res) => {
    const heroId = parse(heroIdSchema, req.params.heroId);
    const { sort, limit } = parse(buildsQuerySchema, req.query);
    await catalog.hero(heroId);
    res.json(await builds.builds(heroId, sort, limit));
  });

  router.get('/heroes/:heroId/item-pairs', async (req, res) => {
    const heroId = parse(heroIdSchema, req.params.heroId);
    const query = parse(pairsQuerySchema, req.query);
    await catalog.hero(heroId);
    res.json(await builds.itemPairs(heroId, query));
  });

  return router;
}
