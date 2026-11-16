export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'ALREADY_TRACKED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'UPSTREAM_ERROR'
  | 'SERVICE_UNAVAILABLE';

/** Erreur applicative sérialisée en `{ error: { code, message } }` par le middleware d'erreurs. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Délai en secondes renvoyé dans l'en-tête `Retry-After` (429/503). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const invalidInput = (message = 'Données invalides.') =>
  new AppError(400, 'INVALID_INPUT', message);

export const unauthorized = (message = 'Authentification requise.') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const notFound = (message = 'Ressource introuvable.') =>
  new AppError(404, 'NOT_FOUND', message);
