import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getUserId } from '../../middleware/require-auth';
import { objectIdSchema } from '../../shared/schemas';
import { parse } from '../../shared/validation';
import { COMPARE_PERIODS, type GroupCompare } from './group.compare';
import { createGroupSchema, updateGroupSchema } from './group.schemas';
import { groupService as service } from './group.service';

const compareQuerySchema = z.object({
  period: z.enum(COMPARE_PERIODS, 'period : 7d, 30d ou season').default('30d'),
});

export function createGroupRouter(requireAuth: RequestHandler, compare: GroupCompare): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    res.json({ items: await service.list(getUserId(req)) });
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
    const { period } = parse(compareQuerySchema, req.query);
    res.json(await compare(group, period));
  });

  // Refresh forcé de tous les membres (délai minimum par joueur), renvoie la comparaison à jour.
  router.post('/:id/refresh', async (req, res) => {
    const group = await service.get(getUserId(req), parse(objectIdSchema, req.params.id));
    const { period } = parse(compareQuerySchema, req.query);
    res.json(await compare(group, period, { refresh: true }));
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
