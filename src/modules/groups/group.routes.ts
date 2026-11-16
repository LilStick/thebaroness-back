import { Router, type RequestHandler } from 'express';
import { getUserId } from '../../middleware/require-auth';
import { objectIdSchema } from '../../shared/schemas';
import { parse } from '../../shared/validation';
import { createGroupSchema, updateGroupSchema } from './group.schemas';
import { groupService as service } from './group.service';

export function createGroupRouter(requireAuth: RequestHandler): Router {
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
