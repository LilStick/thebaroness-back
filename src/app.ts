import express, { type Express } from 'express';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { healthRouter } from './modules/health/health.routes';

export interface AppDeps {
  env: Env;
  logger: Logger;
}

/**
 * Construit l'application Express sans ouvrir de port,
 * pour pouvoir l'importer telle quelle dans les tests Supertest.
 */
export function createApp({ logger }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(express.json({ limit: '16kb' }));

  const api = express.Router();
  api.use('/health', healthRouter);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
