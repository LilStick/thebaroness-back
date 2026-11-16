import bcrypt from 'bcrypt';
import type { Types } from 'mongoose';
import { AppError } from '../../shared/errors';
import { isDuplicateKeyError } from '../../shared/mongo-errors';
import type { LoginInput, RegisterInput } from './auth.schemas';
import { signAccessToken, type JwtConfig } from './jwt';
import { UserModel, toPublicUser, type PublicUser } from './user.model';

export interface AuthConfig extends JwtConfig {
  bcryptRounds: number;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

export function createAuthService(config: AuthConfig) {
  // Hash factice : compare() s'exécute même si l'email est inconnu, pour un temps
  // de réponse comparable et ne pas révéler l'existence d'un compte (§13.6).
  const dummyHash = bcrypt.hash('timing-equalizer', config.bcryptRounds);

  const issue = (user: PublicUser): AuthResult => ({
    user,
    token: signAccessToken(user.id, config),
  });

  return {
    async register({ email, password }: RegisterInput): Promise<AuthResult> {
      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      try {
        const user = await UserModel.create({ email, passwordHash });
        return issue(toPublicUser(user));
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new AppError(409, 'EMAIL_ALREADY_USED', 'Cette adresse email est déjà utilisée.');
        }
        throw error;
      }
    },

    async login({ email, password }: LoginInput): Promise<AuthResult> {
      const user = await UserModel.findOne({ email })
        .select('+passwordHash')
        .lean<{ _id: Types.ObjectId; email: string; passwordHash: string }>();
      const valid = await bcrypt.compare(password, user?.passwordHash ?? (await dummyHash));
      if (!user || !valid) {
        throw new AppError(401, 'UNAUTHORIZED', 'Email ou mot de passe incorrect.');
      }
      return issue(toPublicUser(user));
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
