import { Router, type RequestHandler } from 'express';
import { getUserId } from '../../middleware/require-auth';
import { sanitizeReturnPath } from './login-state';
import type { AuthService } from './auth.service';

export function createAuthRouter(auth: AuthService, requireAuth: RequestHandler): Router {
  const router = Router();

  /** Démarre la connexion : redirection vers Steam. */
  router.get('/steam', (req, res) => {
    res.redirect(302, auth.steamLoginUrl(sanitizeReturnPath(req.query.returnTo)));
  });

  /** Retour de Steam : vérification puis redirection vers le front avec le JWT en fragment. */
  router.get('/steam/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, await auth.handleSteamCallback(req.query));
  });

  /** Utilisateur courant, à appeler par le front juste après la redirection. */
  router.get('/me', requireAuth, async (req, res) => {
    res.json({ user: await auth.getUser(getUserId(req)) });
  });

  return router;
}
