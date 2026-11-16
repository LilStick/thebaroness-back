import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import { createDeadlockApi } from './integrations/deadlock/deadlock.api';
import { DeadlockClient } from './integrations/deadlock/deadlock.client';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { httpLogger } from './middleware/http-logger';
import { createRateLimiter } from './middleware/rate-limit';
import { requireAuth } from './middleware/require-auth';
import { createAuthRouter } from './modules/auth/auth.routes';
import { createAuthService } from './modules/auth/auth.service';
import { createCatalogRouter } from './modules/catalog/catalog.routes';
import { createCatalogService } from './modules/catalog/catalog.service';
import { createDocsRouter } from './modules/docs/docs.routes';
import { createGroupRouter } from './modules/groups/group.routes';
import { healthRouter } from './modules/health/health.routes';
import { createPlayersRouter } from './modules/players/players.routes';
import { createPlayersService } from './modules/players/players.service';
import { createTrackedPlayerRouter } from './modules/tracked-players/tracked-player.routes';

export interface AppDeps {
  env: Env;
  logger: Logger;
  /** Client HTTP sortant (Steam, Deadlock API) ; injectable pour les tests. */
  fetch?: typeof fetch;
}

/**
 * Construit l'application Express sans ouvrir de port,
 * pour pouvoir l'importer telle quelle dans les tests Supertest.
 */
export function createApp({ env, logger, fetch = globalThis.fetch }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  // Nombre de proxys de confiance (nginx, load balancer) pour l'IP réelle du client.
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(httpLogger(logger));
  // API JSON uniquement : en-têtes de sécurité stricts, aucune ressource à charger.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  // Origines explicites (§13.7) ; jeton en en-tête, donc pas de cookies ni `credentials`.
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '16kb' }));

  const deadlock = createDeadlockApi(
    new DeadlockClient({
      baseUrl: env.DEADLOCK_API_BASE_URL,
      apiKey: env.DEADLOCK_API_KEY,
      fetch,
      logger,
    }),
  );

  const auth = requireAuth(env.JWT_SECRET);
  const authService = createAuthService({
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    apiPublicUrl: env.API_PUBLIC_URL,
    frontUrl: env.FRONT_URL,
    fetch,
    deadlock,
    logger,
  });

  const api = express.Router();
  api.use('/health', healthRouter);
  api.use(createDocsRouter());
  // Limite globale par IP (429 `RATE_LIMITED`), en plus de celle, plus stricte, de /auth.
  api.use(createRateLimiter({ windowMs: 60_000, limit: env.API_RATE_LIMIT }));
  api.use(
    '/auth',
    createRateLimiter({ windowMs: 15 * 60_000, limit: env.AUTH_RATE_LIMIT }),
    createAuthRouter(authService, auth),
  );
  api.use('/tracked-players', createTrackedPlayerRouter(auth));
  api.use('/groups', createGroupRouter(auth));
  const catalog = createCatalogService(deadlock);
  api.use(createCatalogRouter(catalog));
  api.use('/players', createPlayersRouter(createPlayersService(deadlock, catalog)));

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
