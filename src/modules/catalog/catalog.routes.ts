import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/validation';
import type { CatalogService } from './catalog.service';

export const heroIdSchema = z.coerce
  .number('heroId : identifiant de héros invalide')
  .int('heroId : identifiant de héros invalide')
  .min(1, 'heroId : identifiant de héros invalide');

/** Catalogue public : héros, rangs, carte (textes en français, URLs d'images complètes). */
export function createCatalogRouter(catalog: CatalogService): Router {
  const router = Router();

  router.get('/heroes', async (_req, res) => {
    res.json(await catalog.heroes());
  });

  router.get('/heroes/:heroId', async (req, res) => {
    res.json(await catalog.hero(parse(heroIdSchema, req.params.heroId)));
  });

  router.get('/ranks', async (_req, res) => {
    res.json({ items: (await catalog.ranks()).data });
  });

  router.get('/map', async (_req, res) => {
    res.json(await catalog.map());
  });

  return router;
}
