import type { Request, RequestHandler } from 'express';
import { verifyAccessToken } from '../modules/auth/jwt';
import { unauthorized } from '../shared/errors';

declare module 'express-serve-static-core' {
  interface Request {
    /** Identifiant de l'utilisateur authentifié, issu exclusivement du JWT vérifié. */
    userId?: string;
  }
}

const BEARER = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/;

/** Exige `Authorization: Bearer <JWT>` valide ; sinon 401 `UNAUTHORIZED` (§13.3). */
export function requireAuth(secret: string): RequestHandler {
  return (req, _res, next) => {
    const match = BEARER.exec(req.headers.authorization ?? '');
    const userId = match?.[1] ? verifyAccessToken(match[1], secret) : null;
    if (!userId) {
      next(unauthorized('Session absente ou expirée.'));
      return;
    }
    req.userId = userId;
    next();
  };
}

/** Lit l'identifiant posé par `requireAuth` (erreur de programmation s'il manque). */
export function getUserId(req: Request): string {
  if (!req.userId) throw new Error('requireAuth doit précéder ce handler');
  return req.userId;
}
