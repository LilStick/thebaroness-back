import jwt, { type SignOptions } from 'jsonwebtoken';

const ALGORITHM = 'HS256';
const TOKEN_TYPE = 'access';

export interface JwtConfig {
  secret: string;
  expiresIn: string;
}

/** Signe un access token dont le `sub` est l'identifiant utilisateur. */
export function signAccessToken(userId: string, { secret, expiresIn }: JwtConfig): string {
  return jwt.sign({ typ: TOKEN_TYPE }, secret, {
    algorithm: ALGORITHM,
    subject: userId,
    expiresIn: expiresIn as SignOptions['expiresIn'],
  });
}

/**
 * Vérifie signature, algorithme, expiration et type (§13.2).
 * Renvoie l'identifiant utilisateur, ou `null` si le jeton est inexploitable.
 */
export function verifyAccessToken(token: string, secret: string): string | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
    if (typeof payload === 'string' || payload.typ !== TOKEN_TYPE) return null;
    return typeof payload.sub === 'string' && /^[a-f\d]{24}$/i.test(payload.sub)
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}
