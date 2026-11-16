import express, { type Express } from 'express';
import type { Env } from './config/env';

/**
 * Construit l'application Express sans ouvrir de port,
 * pour pouvoir l'importer telle quelle dans les tests Supertest.
 */
export function createApp(_env: Env): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());

  return app;
}
