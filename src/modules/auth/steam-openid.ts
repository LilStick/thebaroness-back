/**
 * Vérification d'une assertion Steam OpenID 2.0 (mode stateless / « dumb »).
 * Spécification : https://openid.net/specs/openid-authentication-2_0.html §11.
 */

export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';

const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const REQUIRED_SIGNED = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce'];
/** Âge maximal accepté pour `openid.response_nonce`. */
const NONCE_MAX_AGE_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 8_000;

export type SteamAuthFailure = 'CANCELLED' | 'INVALID_ASSERTION' | 'STEAM_UNAVAILABLE';

export class SteamAuthError extends Error {
  constructor(readonly reason: SteamAuthFailure) {
    super(reason);
    this.name = 'SteamAuthError';
  }
}

/** URL de redirection vers Steam pour démarrer l'authentification. */
export function buildSteamLoginUrl(returnTo: string, realm: string): string {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

/** Extrait les paramètres `openid.*` en refusant toute valeur non scalaire. */
export function extractOpenIdParams(query: Record<string, unknown>): Map<string, string> {
  const params = new Map<string, string>();
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('openid.')) continue;
    if (typeof value !== 'string') throw new SteamAuthError('INVALID_ASSERTION');
    params.set(key, value);
  }
  return params;
}

function nonceIsFresh(nonce: string, now: number): boolean {
  // Format : 2026-11-16T09:00:00Z<suffixe unique>
  const timestamp = Date.parse(nonce.slice(0, 20));
  return Number.isFinite(timestamp) && Math.abs(now - timestamp) <= NONCE_MAX_AGE_MS;
}

/**
 * Valide l'assertion localement puis la fait confirmer par Steam.
 * Renvoie le SteamID64 authentifié.
 */
export async function verifySteamAssertion(
  params: Map<string, string>,
  expectedReturnTo: string,
  fetchImpl: typeof fetch,
  now = Date.now(),
): Promise<string> {
  const get = (key: string) => params.get(`openid.${key}`);

  if (get('mode') === 'cancel') throw new SteamAuthError('CANCELLED');

  const claimed = CLAIMED_ID.exec(get('claimed_id') ?? '');
  const signed = new Set((get('signed') ?? '').split(','));
  const valid =
    get('mode') === 'id_res' &&
    get('ns') === OPENID_NS &&
    get('op_endpoint') === STEAM_OPENID_ENDPOINT &&
    get('return_to') === expectedReturnTo &&
    claimed !== null &&
    get('identity') === get('claimed_id') &&
    REQUIRED_SIGNED.every((field) => signed.has(field)) &&
    nonceIsFresh(get('response_nonce') ?? '', now);
  if (!valid || !claimed?.[1]) throw new SteamAuthError('INVALID_ASSERTION');

  const body = new URLSearchParams(params);
  body.set('openid.mode', 'check_authentication');

  let text: string;
  try {
    const res = await fetchImpl(STEAM_OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch {
    throw new SteamAuthError('STEAM_UNAVAILABLE');
  }

  // Réponse « key-value form » : une paire clé:valeur par ligne.
  if (!/^is_valid:true$/m.test(text)) throw new SteamAuthError('INVALID_ASSERTION');
  return claimed[1];
}
