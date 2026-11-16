import type { Logger } from 'pino';
import type { DeadlockApi } from '../../integrations/deadlock/deadlock.api';
import { unauthorized } from '../../shared/errors';
import { isDuplicateKeyError } from '../../shared/mongo-errors';
import { steamIdToAccountId } from '../../shared/schemas';
import { signAccessToken, type JwtConfig } from './jwt';
import { createLoginState, isValidLoginState } from './login-state';
import {
  SteamAuthError,
  buildSteamLoginUrl,
  extractOpenIdParams,
  verifySteamAssertion,
} from './steam-openid';
import { UserModel, toPublicUser, type PublicUser } from './user.model';

export interface AuthConfig extends JwtConfig {
  apiPublicUrl: string;
  frontUrl: string;
  fetch: typeof fetch;
  deadlock: Pick<DeadlockApi, 'getSteamProfile'>;
  logger: Logger;
}

/** Codes renvoyés au front dans `?error=` après un échec de connexion Steam. */
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
  const frontCallback = `${config.frontUrl}/auth/callback`;
  // Contrat front : jeton dans le fragment (jamais transmis à un serveur), erreur en query.
  const success = (token: string) => `${frontCallback}#token=${encodeURIComponent(token)}`;
  const failure = (code: SteamLoginErrorCode) => `${frontCallback}?error=${code}`;

  /** Profil Steam via Deadlock API ; `null` si indisponible (la connexion ne doit pas échouer). */
  async function lookupProfile(steamId: string) {
    try {
      return await config.deadlock.getSteamProfile(steamIdToAccountId(steamId));
    } catch (error) {
      config.logger.warn({ err: (error as Error).message }, 'Profil Steam indisponible');
      return null;
    }
  }

  /**
   * Crée le compte à la première connexion, sinon le met à jour.
   * Profil disponible → pseudo/avatar rafraîchis ; sinon conservés (repli : steamId à la création).
   */
  async function upsertUser(steamId: string): Promise<PublicUser> {
    const profile = await lookupProfile(steamId);
    const update = profile
      ? {
          $set: {
            lastLoginAt: new Date(),
            displayName: profile.displayName || steamId,
            avatarUrl: profile.avatarUrl,
          },
        }
      : {
          $set: { lastLoginAt: new Date() },
          $setOnInsert: { displayName: steamId, avatarUrl: null },
        };
    const run = () =>
      UserModel.findOneAndUpdate({ steamId }, update, {
        upsert: true,
        new: true,
        runValidators: true,
      }).lean();

    try {
      return toPublicUser(await run());
    } catch (error) {
      // Deux premières connexions simultanées : la seconde insertion échoue, on rejoue en mise à jour.
      if (!isDuplicateKeyError(error)) throw error;
      return toPublicUser(await run());
    }
  }

  return {
    /** URL Steam vers laquelle rediriger le navigateur. */
    steamLoginUrl(): string {
      return buildSteamLoginUrl(callbackUrl(createLoginState(stateKey)), config.apiPublicUrl);
    },

    /** Traite le retour de Steam et renvoie l'URL du front à atteindre. */
    async handleSteamCallback(query: Record<string, unknown>): Promise<string> {
      if (!isValidLoginState(query.state, stateKey)) return failure('INVALID_STATE');

      try {
        const steamId = await verifySteamAssertion(
          extractOpenIdParams(query),
          callbackUrl(query.state as string),
          config.fetch,
        );
        const user = await upsertUser(steamId);
        return success(signAccessToken(user.id, config));
      } catch (error) {
        if (error instanceof SteamAuthError) return failure(FAILURE_CODES[error.reason]);
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
