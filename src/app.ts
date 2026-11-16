import express, { type Express } from 'express';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createRateLimiter } from './middleware/rate-limit';
import { createAuthRouter } from './modules/auth/auth.routes';
import { createAuthService } from './modules/auth/auth.service';
import { healthRouter } from './modules/health/health.routes';

export interface AppDeps {
  env: Env;
  logger: Logger;
}

/**
 * Construit l'application Express sans ouvrir de port,
 * pour pouvoir l'importer telle quelle dans les tests Supertest.
 */
export function createApp({ env, logger }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(express.json({ limit: '16kb' }));

  const authService = createAuthService({
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    bcryptRounds: env.BCRYPT_ROUNDS,
  });

  const api = express.Router();
  api.use('/health', healthRouter);
  api.use(
    '/auth',
    createRateLimiter({ windowMs: 15 * 60_000, limit: env.AUTH_RATE_LIMIT }),
    createAuthRouter(authService),
  );

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
