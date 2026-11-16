import { Router, type RequestHandler } from 'express';
import { getUserId } from '../../middleware/require-auth';
import { objectIdSchema } from '../../shared/schemas';
import { parse } from '../../shared/validation';
import { createTrackedPlayerSchema, updateTrackedPlayerSchema } from './tracked-player.schemas';
import { trackedPlayerService as service } from './tracked-player.service';

export function createTrackedPlayerRouter(requireAuth: RequestHandler): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    res.json({ items: await service.list(getUserId(req)) });
  });

  router.post('/', async (req, res) => {
    const input = parse(createTrackedPlayerSchema, req.body);
    res.status(201).json(await service.create(getUserId(req), input));
  });

  router.get('/:id', async (req, res) => {
    res.json(await service.get(getUserId(req), parse(objectIdSchema, req.params.id)));
  });

  router.patch('/:id', async (req, res) => {
    const id = parse(objectIdSchema, req.params.id);
    const input = parse(updateTrackedPlayerSchema, req.body);
    res.json(await service.update(getUserId(req), id, input));
  });

  router.delete('/:id', async (req, res) => {
    await service.remove(getUserId(req), parse(objectIdSchema, req.params.id));
    res.status(204).end();
  });

  return router;
}
