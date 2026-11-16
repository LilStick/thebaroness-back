import { Router, type RequestHandler } from 'express';
import { getUserId } from '../../middleware/require-auth';
import type { AuthService } from './auth.service';

export function createAuthRouter(auth: AuthService, requireAuth: RequestHandler): Router {
  const router = Router();

  /** Démarre la connexion : redirection vers Steam. */
  router.get('/steam', (_req, res) => {
    res.redirect(302, auth.steamLoginUrl());
  });

  /** Retour de Steam : vérification puis redirection vers le front (JWT en fragment). */
  router.get('/steam/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, await auth.handleSteamCallback(req.query));
  });

  /** Utilisateur courant : `{ id, steamId, displayName, avatarUrl }`. */
  router.get('/me', requireAuth, async (req, res) => {
    res.json(await auth.getUser(getUserId(req)));
  });

  return router;
}
