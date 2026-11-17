import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/validation';
import { ITEM_SLOTS, ITEM_TYPES, type ItemsService } from './items.service';

const clientVersion = z.coerce
  .number('clientVersion : entier positif attendu')
  .int('clientVersion : entier positif attendu')
  .positive('clientVersion : entier positif attendu')
  .optional();

const listQuerySchema = z.object({
  type: z.enum(ITEM_TYPES, 'type : upgrade, ability ou weapon').optional(),
  slot: z.enum(ITEM_SLOTS, 'slot : weapon, vitality ou spirit').optional(),
  tier: z.coerce
    .number('tier : entier entre 1 et 5')
    .int('tier : entier entre 1 et 5')
    .min(1, 'tier : entier entre 1 et 5')
    .max(5, 'tier : entier entre 1 et 5')
    .optional(),
  shopable: z.enum(['true', 'false'], 'shopable : true ou false').optional(),
  clientVersion,
});

/** Filtres des agrégats d'items (mode de jeu normal). */
export const analyticsQuerySchema = z.object({
  period: z.enum(['7d', '30d'], 'period : 7d ou 30d').default('30d'),
  heroId: z.coerce
    .number('heroId : entier positif attendu')
    .int('heroId : entier positif attendu')
    .positive('heroId : entier positif attendu')
    .optional(),
  matchMode: z.enum(['ranked', 'unranked'], 'matchMode : ranked ou unranked').optional(),
});

const itemIdSchema = z.coerce
  .number('itemId : identifiant d’item invalide')
  .int('itemId : identifiant d’item invalide')
  .nonnegative('itemId : identifiant d’item invalide')
  .max(0xffffffff, 'itemId : identifiant d’item invalide');

/** Catalogue public des items (objets, capacités, armes), versionné par version du client. */
export function createItemsRouter(items: ItemsService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { shopable, ...filter } = parse(listQuerySchema, req.query);
    res.json(
      await items.list({
        ...filter,
        shopable: shopable === undefined ? undefined : shopable === 'true',
      }),
    );
  });

  // Statistiques d'utilisation de tous les items (avant `/:itemId`).
  router.get('/stats', async (req, res) => {
    res.json(await items.stats(parse(analyticsQuerySchema, req.query)));
  });

  router.get('/:itemId/stats', async (req, res) => {
    const itemId = parse(itemIdSchema, req.params.itemId);
    res.json(await items.itemStats(itemId, parse(analyticsQuerySchema, req.query)));
  });

  router.get('/:itemId', async (req, res) => {
    const itemId = parse(itemIdSchema, req.params.itemId);
    const { clientVersion: version } = parse(z.object({ clientVersion }), req.query);
    res.json(await items.item(itemId, version));
  });

  return router;
}
