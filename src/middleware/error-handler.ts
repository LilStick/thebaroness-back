import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { AppError, notFound } from '../shared/errors';

/** Toute route non déclarée → 404 homogène. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('Route introuvable.'));
};

type HttpLikeError = Error & { status?: number; statusCode?: number; type?: string };

/** Erreurs levées par express.json() : JSON malformé, corps trop gros, encodage… */
function isBodyParserError(err: unknown): err is HttpLikeError {
  return err instanceof Error && typeof (err as HttpLikeError).type === 'string';
}

/**
 * Convertit toute erreur en enveloppe `{ error: { code, message } }` (§8.2).
 * Aucune stack trace, URL interne ou secret n'est renvoyé au client.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let appError: AppError;

    if (err instanceof AppError) {
      appError = err;
    } else if (isBodyParserError(err)) {
      const status = err.status ?? err.statusCode ?? 400;
      appError =
        status === 413
          ? new AppError(413, 'INVALID_INPUT', 'Corps de requête trop volumineux.')
          : new AppError(400, 'INVALID_INPUT', 'Corps de requête JSON invalide.');
    } else {
      logger.error({ err, method: req.method, url: req.originalUrl }, 'Erreur non gérée');
      appError = new AppError(500, 'INTERNAL_ERROR', 'Une erreur interne est survenue.');
    }

    if (appError.status >= 500 && err instanceof AppError) {
      logger.warn({ code: appError.code, url: req.originalUrl }, appError.message);
    }
    if (appError.retryAfter !== undefined) {
      res.setHeader('Retry-After', String(Math.ceil(appError.retryAfter)));
    }

    res.status(appError.status).json({ error: { code: appError.code, message: appError.message } });
  };
}
