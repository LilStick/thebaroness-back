import { Router } from 'express';

export const healthRouter = Router();

/** F-15 : 200 et exactement `{ "status": "ok" }`. */
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok' });
});
