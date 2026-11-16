import { unauthorized } from '../../shared/errors';
import { isDuplicateKeyError } from '../../shared/mongo-errors';
import { signAccessToken, type JwtConfig } from './jwt';
import { createLoginState, readLoginState } from './login-state';
import {
  SteamAuthError,
  buildSteamLoginUrl,
  extractOpenIdParams,
  verifySteamAssertion,
} from './steam-openid';
import { UserModel, toPublicUser, type PublicUser } from './user.model';

export interface AuthConfig extends JwtConfig {
  apiPublicUrl: string;
  frontendUrl: string;
  fetch: typeof fetch;
}

/** Codes renvoyés au front dans `#error=` après un échec de connexion Steam. */
export type SteamLoginErrorCode =
  'STEAM_CANCELLED' | 'STEAM_AUTH_FAILED' | 'STEAM_UNAVAILABLE' | 'INVALID_STATE';

const FAILURE_CODES: Record<SteamAuthError['reason'], SteamLoginErrorCode> = {
  CANCELLED: 'STEAM_CANCELLED',
  INVALID_ASSERTION: 'STEAM_AUTH_FAILED',
  STEAM_UNAVAILABLE: 'STEAM_UNAVAILABLE',
};

export function createAuthService(config: AuthConfig) {
  // Clé dédiée (séparation de domaine) pour signer le state OpenID.
  const stateKey = `${config.secret}:steam-login-state`;
  const callbackUrl = (state: string) =>
    `${config.apiPublicUrl}/api/auth/steam/callback?state=${encodeURIComponent(state)}`;
  const frontRedirect = (fragment: Record<string, string>) =>
    `${config.frontendUrl}/auth/callback#${new URLSearchParams(fragment).toString()}`;

  /** Crée le compte à la première connexion, sinon met à jour la date de connexion. */
  async function upsertUser(steamId: string): Promise<PublicUser> {
    const run = () =>
      UserModel.findOneAndUpdate(
        { steamId },
        { $set: { lastLoginAt: new Date() } },
        { upsert: true, new: true, runValidators: true },
      ).lean();
    let user;
    try {
      user = await run();
    } catch (error) {
      // Deux premières connexions simultanées : la seconde insertion échoue, on relit.
      if (!isDuplicateKeyError(error)) throw error;
      user = await run();
    }
    return toPublicUser(user);
  }

  return {
    /** URL Steam vers laquelle rediriger le navigateur. */
    steamLoginUrl(returnPath: string): string {
      return buildSteamLoginUrl(
        callbackUrl(createLoginState(returnPath, stateKey)),
        config.apiPublicUrl,
      );
    },

    /**
     * Traite le retour de Steam et renvoie l'URL du front à atteindre :
     * `#token=…&returnTo=…` en cas de succès, `#error=…` sinon.
     */
    async handleSteamCallback(query: Record<string, unknown>): Promise<string> {
      const returnTo = readLoginState(query.state, stateKey);
      if (!returnTo) return frontRedirect({ error: 'INVALID_STATE' });

      try {
        const steamId = await verifySteamAssertion(
          extractOpenIdParams(query),
          callbackUrl(query.state as string),
          config.fetch,
        );
        const user = await upsertUser(steamId);
        return frontRedirect({ token: signAccessToken(user.id, config), returnTo });
      } catch (error) {
        if (error instanceof SteamAuthError) {
          return frontRedirect({ error: FAILURE_CODES[error.reason], returnTo });
        }
        throw error;
      }
    },

    async getUser(userId: string): Promise<PublicUser> {
      const user = await UserModel.findById(userId).lean();
      // Compte supprimé entre-temps : la session n'est plus valable.
      if (!user) throw unauthorized('Session invalide.');
      return toPublicUser(user);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
