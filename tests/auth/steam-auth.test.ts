import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createLoginState, sanitizeReturnPath } from '../../src/modules/auth/login-state';
import { STEAM_OPENID_ENDPOINT } from '../../src/modules/auth/steam-openid';
import { UserModel } from '../../src/modules/auth/user.model';
import { buildTestApp, createUser, testEnv } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const STEAM_ID = '76561198957316510';
const CALLBACK = '/api/auth/steam/callback';

/** Démarre une connexion et renvoie l'URL de retour que Steam rappellerait. */
async function startLogin(app: ReturnType<typeof buildTestApp>, returnTo = '/tracked') {
  const res = await request(app).get('/api/auth/steam').query({ returnTo });
  expect(res.status).toBe(302);
  const steamUrl = new URL(res.headers.location as string);
  return { steamUrl, returnTo: steamUrl.searchParams.get('openid.return_to') as string };
}

/** Assertion positive telle que Steam la renverrait. */
function steamAssertion(returnTo: string, overrides: Record<string, string> = {}) {
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': STEAM_OPENID_ENDPOINT,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    'openid.return_to': returnTo,
    'openid.response_nonce': `${new Date().toISOString().slice(0, 19)}Zabc123`,
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2lnbmF0dXJl',
    ...overrides,
  };
}

/** Appelle le callback avec exactement la query que Steam ajouterait au return_to. */
function callback(app: ReturnType<typeof buildTestApp>, returnTo: string, assertion: object) {
  const url = new URL(returnTo);
  for (const [key, value] of Object.entries(assertion)) url.searchParams.set(key, value);
  return request(app).get(`${url.pathname}${url.search}`);
}

const fragment = (location: string) => new URLSearchParams(new URL(location).hash.slice(1));

describe('Connexion Steam OpenID', () => {
  useTestDb();
  let steam: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    steam = createFetchMock().on(/^\/openid\/login$/, {
      body: 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n',
    });
    app = buildTestApp({}, steam.fetch);
  });

  describe('GET /api/auth/steam', () => {
    it('redirige vers Steam avec les paramètres OpenID 2.0', async () => {
      const { steamUrl, returnTo } = await startLogin(app);
      expect(`${steamUrl.origin}${steamUrl.pathname}`).toBe(STEAM_OPENID_ENDPOINT);
      expect(steamUrl.searchParams.get('openid.mode')).toBe('checkid_setup');
      expect(steamUrl.searchParams.get('openid.realm')).toBe(testEnv.API_PUBLIC_URL);
      expect(returnTo).toMatch(new RegExp(`^${testEnv.API_PUBLIC_URL}${CALLBACK}\\?state=`));
    });
  });

  describe('GET /api/auth/steam/callback', () => {
    it('succès : crée le compte, redirige vers le front avec JWT et returnTo en fragment', async () => {
      const { returnTo } = await startLogin(app, '/players/123');
      const res = await callback(app, returnTo, steamAssertion(returnTo));

      expect(res.status).toBe(302);
      expect(res.headers['cache-control']).toBe('no-store');
      const location = res.headers.location as string;
      expect(location.startsWith(`${testEnv.FRONTEND_URL}/auth/callback#`)).toBe(true);

      const params = fragment(location);
      expect(params.get('returnTo')).toBe('/players/123');
      const payload = jwt.verify(
        params.get('token') as string,
        testEnv.JWT_SECRET,
      ) as jwt.JwtPayload;
      const user = await UserModel.findById(payload.sub).lean();
      expect(user?.steamId).toBe(STEAM_ID);

      // Vérification directe auprès de Steam, en mode check_authentication.
      expect(steam.calls).toHaveLength(1);
    });

    it('reconnexion : réutilise le même compte', async () => {
      for (let i = 0; i < 2; i++) {
        const { returnTo } = await startLogin(app);
        await callback(app, returnTo, steamAssertion(returnTo)).expect(302);
      }
      expect(await UserModel.countDocuments({ steamId: STEAM_ID })).toBe(1);
    });

    it('le JWT obtenu donne accès à GET /api/auth/me', async () => {
      const { returnTo } = await startLogin(app);
      const res = await callback(app, returnTo, steamAssertion(returnTo));
      const token = fragment(res.headers.location as string).get('token');

      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(200);
      expect(me.body).toStrictEqual({
        user: { id: expect.stringMatching(/^[a-f\d]{24}$/), steamId: STEAM_ID },
      });
    });

    const rejected: Array<[string, (rt: string) => Record<string, string>, string]> = [
      [
        'annulation par l’utilisateur',
        (rt) => ({ ...steamAssertion(rt), 'openid.mode': 'cancel' }),
        'STEAM_CANCELLED',
      ],
      [
        'op_endpoint étranger',
        (rt) => steamAssertion(rt, { 'openid.op_endpoint': 'https://evil.test/openid/login' }),
        'STEAM_AUTH_FAILED',
      ],
      [
        'claimed_id invalide',
        (rt) =>
          steamAssertion(rt, {
            'openid.claimed_id': 'https://evil.test/id/1',
            'openid.identity': 'https://evil.test/id/1',
          }),
        'STEAM_AUTH_FAILED',
      ],
      [
        'identity ≠ claimed_id',
        (rt) =>
          steamAssertion(rt, {
            'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
          }),
        'STEAM_AUTH_FAILED',
      ],
      [
        'return_to altéré',
        (rt) => steamAssertion(rt, { 'openid.return_to': `${rt}x` }),
        'STEAM_AUTH_FAILED',
      ],
      [
        'champ requis non signé',
        (rt) => steamAssertion(rt, { 'openid.signed': 'signed,op_endpoint,identity' }),
        'STEAM_AUTH_FAILED',
      ],
      [
        'nonce périmé',
        (rt) => steamAssertion(rt, { 'openid.response_nonce': '2020-01-01T00:00:00Zold' }),
        'STEAM_AUTH_FAILED',
      ],
    ];

    it.each(rejected)('%s → #error=%s sans compte créé', async (_label, build, expected) => {
      const { returnTo } = await startLogin(app);
      const res = await callback(app, returnTo, build(returnTo));
      expect(res.status).toBe(302);
      expect(fragment(res.headers.location as string).get('error')).toBe(expected);
      expect(fragment(res.headers.location as string).has('token')).toBe(false);
      expect(await UserModel.countDocuments()).toBe(0);
    });

    it('Steam répond is_valid:false → STEAM_AUTH_FAILED', async () => {
      steam.reset();
      steam.on(/openid/, { body: 'ns:http://specs.openid.net/auth/2.0\nis_valid:false\n' });
      const { returnTo } = await startLogin(app);
      const res = await callback(app, returnTo, steamAssertion(returnTo));
      expect(fragment(res.headers.location as string).get('error')).toBe('STEAM_AUTH_FAILED');
    });

    it.each([
      ['erreur réseau', { networkError: true }],
      ['HTTP 503', { status: 503 }],
    ])('Steam injoignable (%s) → STEAM_UNAVAILABLE', async (_label, response) => {
      steam.reset();
      steam.on(/openid/, response);
      const { returnTo } = await startLogin(app);
      const res = await callback(app, returnTo, steamAssertion(returnTo));
      expect(fragment(res.headers.location as string).get('error')).toBe('STEAM_UNAVAILABLE');
    });

    it.each([
      ['absent', ''],
      ['falsifié', 'eyJyIjoiLyJ9.signature-bidon'],
      [
        'expiré',
        createLoginState('/', `${testEnv.JWT_SECRET}:steam-login-state`, Date.now() - 3_600_000),
      ],
    ])('state %s → INVALID_STATE sans appel à Steam', async (_label, state) => {
      const rt = `${testEnv.API_PUBLIC_URL}${CALLBACK}?state=${encodeURIComponent(state)}`;
      const res = await callback(app, rt, steamAssertion(rt));
      expect(fragment(res.headers.location as string).get('error')).toBe('INVALID_STATE');
      expect(steam.calls).toHaveLength(0);
    });

    it('paramètre openid dupliqué (tableau) → STEAM_AUTH_FAILED', async () => {
      const { returnTo } = await startLogin(app);
      const url = new URL(returnTo);
      const res = await request(app).get(
        `${url.pathname}${url.search}&openid.mode=id_res&openid.mode=id_res`,
      );
      expect(fragment(res.headers.location as string).get('error')).toBe('STEAM_AUTH_FAILED');
    });
  });

  describe('GET /api/auth/me', () => {
    it('sans jeton → 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('compte supprimé → 401', async () => {
      const { auth, userId } = await createUser();
      await UserModel.deleteOne({ _id: userId });
      const res = await request(app).get('/api/auth/me').set(auth);
      expect(res.status).toBe(401);
    });
  });
});

describe('sanitizeReturnPath (anti open-redirect)', () => {
  it.each([
    ['/tracked', '/tracked'],
    ['/players/765?tab=matches', '/players/765?tab=matches'],
    ['//evil.test', '/'],
    ['/\\evil.test', '/'],
    ['https://evil.test', '/'],
    ['javascript:alert(1)', '/'],
    [undefined, '/'],
    [['/a', '/b'], '/'],
  ])('%p → %p', (input, expected) => {
    expect(sanitizeReturnPath(input)).toBe(expected);
  });
});
