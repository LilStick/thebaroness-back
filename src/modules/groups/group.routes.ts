import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getUserId } from '../../middleware/require-auth';
import { objectIdSchema } from '../../shared/schemas';
import { parse } from '../../shared/validation';
import { GAME_MODE_FILTERS, MATCH_MODE_FILTERS } from '../players/profile-stats';
import type { PlayersService } from '../players/players.service';
import { COMPARE_PERIODS, type GroupCompare } from './group.compare';

/** Identité de repli : profil non résolu (`resolved: false`), pseudo = SteamID64. */
const fallback = (steamId: string) => ({
  steamId,
  displayName: steamId,
  avatarUrl: null,
  resolved: false,
});
import { createGroupSchema, updateGroupSchema } from './group.schemas';
import { groupService as service } from './group.service';

const compareQuerySchema = z.object({
  period: z.enum(COMPARE_PERIODS, 'period : 7d, 30d ou season').default('30d'),
  // v1.15.0 : mêmes valeurs et défauts qu'`/overview` ; sans eux, comportement v1.14.
  gameMode: z.enum(GAME_MODE_FILTERS, 'gameMode : all, normal ou street_brawl').default('all'),
  matchMode: z.enum(MATCH_MODE_FILTERS, 'matchMode : all, ranked ou unranked').default('all'),
  include: z.enum(['pairs'], 'include : pairs').optional(),
});

const listQuerySchema = z.object({
  include: z.enum(['members'], 'include : members').optional(),
});

const compareOptions = (query: z.infer<typeof compareQuerySchema>) => ({
  filter: { gameMode: query.gameMode, matchMode: query.matchMode },
  includePairs: query.include === 'pairs',
});

export function createGroupRouter(
  requireAuth: RequestHandler,
  compare: GroupCompare,
  identities?: Pick<PlayersService, 'identities'>,
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const { include } = parse(listQuerySchema, req.query);
    const items = await service.list(getUserId(req));
    if (include !== 'members' || !identities) return void res.json({ items });
    // Une seule résolution groupée pour tous les membres de tous les groupes (dédoublonnés).
    const resolved = await identities.identities(items.flatMap((g) => g.steamIds));
    res.json({
      items: items.map((g) => ({
        ...g,
        members: g.steamIds.map((steamId) => resolved.members.get(steamId) ?? fallback(steamId)),
      })),
      membersCoverage: resolved.coverage,
      meta: resolved.meta,
    });
  });

  router.post('/', async (req, res) => {
    const input = parse(createGroupSchema, req.body);
    res.status(201).json(await service.create(getUserId(req), input));
  });

  router.get('/:id', async (req, res) => {
    res.json(await service.get(getUserId(req), parse(objectIdSchema, req.params.id)));
  });

  // Ordre des contrôles du contrat : id (400), groupe du compte (404), période (400).
  router.get('/:id/compare', async (req, res) => {
    const group = await service.get(getUserId(req), parse(objectIdSchema, req.params.id));
    const query = parse(compareQuerySchema, req.query);
    res.json(await compare(group, query.period, compareOptions(query)));
  });

  // Refresh forcé de tous les membres (délai minimum par joueur), renvoie la comparaison à jour.
  router.post('/:id/refresh', async (req, res) => {
    const group = await service.get(getUserId(req), parse(objectIdSchema, req.params.id));
    const query = parse(compareQuerySchema, req.query);
    res.json(await compare(group, query.period, { ...compareOptions(query), refresh: true }));
  });

  router.patch('/:id', async (req, res) => {
    const id = parse(objectIdSchema, req.params.id);
    const input = parse(updateGroupSchema, req.body);
    res.json(await service.update(getUserId(req), id, input));
  });

  router.delete('/:id', async (req, res) => {
    await service.remove(getUserId(req), parse(objectIdSchema, req.params.id));
    res.status(204).end();
  });

  return router;
}
