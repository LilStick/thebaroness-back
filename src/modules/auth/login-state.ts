import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * `state` OpenID signé (HMAC-SHA256) et sans stockage serveur :
 * garantit que la réponse de Steam correspond à une connexion initiée par notre API
 * il y a moins de 10 min, et transporte le chemin de retour du front sans altération possible.
 * Non lié au navigateur (pas de cookie) : ne couvre pas entièrement le login-CSRF.
 */
const STATE_TTL_MS = 10 * 60_000;
const SAFE_PATH = /^\/(?![/\\])[\w\-./?=&%~]*$/;

interface StatePayload {
  /** Chemin relatif du front où renvoyer l'utilisateur. */
  r: string;
  /** Expiration (epoch ms). */
  e: number;
  /** Aléa pour rendre chaque state unique. */
  n: string;
}

/** N'accepte qu'un chemin relatif au front (pas d'open redirect). */
export function sanitizeReturnPath(value: unknown): string {
  return typeof value === 'string' && value.length <= 512 && SAFE_PATH.test(value) ? value : '/';
}

function sign(data: string, key: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

export function createLoginState(returnPath: string, key: string, now = Date.now()): string {
  const payload: StatePayload = {
    r: returnPath,
    e: now + STATE_TTL_MS,
    n: randomBytes(9).toString('base64url'),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data, key)}`;
}

/** Renvoie le chemin de retour si le state est authentique et non expiré, sinon `null`. */
export function readLoginState(state: unknown, key: string, now = Date.now()): string | null {
  if (typeof state !== 'string' || state.length > 1024) return null;
  const [data, signature, ...rest] = state.split('.');
  if (!data || !signature || rest.length) return null;

  const expected = Buffer.from(sign(data, key));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as StatePayload;
    return typeof payload.e === 'number' && payload.e > now ? sanitizeReturnPath(payload.r) : null;
  } catch {
    return null;
  }
}
