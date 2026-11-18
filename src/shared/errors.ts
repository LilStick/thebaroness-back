export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'ALREADY_TRACKED'
  | 'TRACKED_LIMIT_REACHED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'UPSTREAM_ERROR'
  | 'SERVICE_UNAVAILABLE';

/**
 * Cause d'une indisponibilité du fournisseur : `rate_limited` (429 ou blocage par `Retry-After`
 * consécutif à un 429), `timeout` (délai dépassé), `unreachable` (réseau), `unavailable` (503/504).
 */
export type UpstreamReason = 'rate_limited' | 'timeout' | 'unreachable' | 'unavailable';

/** Erreur applicative sérialisée en `{ error: { code, message } }` par le middleware d'erreurs. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Délai en secondes renvoyé dans l'en-tête `Retry-After` (429/503). */
    readonly retryAfter?: number,
    /** Cause côté fournisseur, quand elle est connue (jamais sérialisée dans la réponse d'erreur). */
    readonly upstreamReason?: UpstreamReason,
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
