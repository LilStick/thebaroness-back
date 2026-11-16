import { rateLimit } from 'express-rate-limit';
import { AppError } from '../shared/errors';

/**
 * Limiteur par IP renvoyant l'enveloppe d'erreur homogène 429 `RATE_LIMITED`
 * (et l'en-tête `Retry-After`).
 */
export function createRateLimiter({ windowMs, limit }: { windowMs: number; limit: number }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(
        new AppError(
          429,
          'RATE_LIMITED',
          'Trop de requêtes, réessayez dans quelques instants.',
          windowMs / 1000,
        ),
      );
    },
  });
}
