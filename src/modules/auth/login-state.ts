import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * `state` OpenID signé (HMAC-SHA256), sans stockage serveur : garantit que la réponse de Steam
 * correspond à une connexion initiée par notre API il y a moins de 10 min.
 * Non lié au navigateur (pas de cookie) : ne couvre pas entièrement le login-CSRF.
 */
const STATE_TTL_MS = 10 * 60_000;

function sign(data: string, key: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

export function createLoginState(key: string, now = Date.now()): string {
  const data = `${(now + STATE_TTL_MS).toString(36)}.${randomBytes(9).toString('base64url')}`;
  return `${data}.${sign(data, key)}`;
}

/** `true` si le state est authentique et non expiré. */
export function isValidLoginState(state: unknown, key: string, now = Date.now()): boolean {
  if (typeof state !== 'string' || state.length > 256) return false;
  const [expiry, nonce, signature, ...rest] = state.split('.');
  if (!expiry || !nonce || !signature || rest.length) return false;

  const expected = Buffer.from(sign(`${expiry}.${nonce}`, key));
  const received = Buffer.from(signature);
  return (
    expected.length === received.length &&
    timingSafeEqual(expected, received) &&
    parseInt(expiry, 36) > now
  );
}
