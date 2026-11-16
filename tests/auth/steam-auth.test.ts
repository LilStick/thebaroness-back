import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createLoginState } from '../../src/modules/auth/login-state';
import { STEAM_OPENID_ENDPOINT } from '../../src/modules/auth/steam-openid';
import { UserModel } from '../../src/modules/auth/user.model';
import { buildTestApp, createUser, testEnv } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const STEAM_ID = '76561198957316510';
const ACCOUNT_ID = 997050782;
const CALLBACK = '/api/auth/steam/callback';
const FRONT_CALLBACK = `${testEnv.FRONT_URL}/auth/callback`;
const STEAM_VALID = 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n';
const PROFILE = {
  account_id: ACCOUNT_ID,
  personaname: 'Corvid',
  avatarfull: 'https://avatars.steamstatic.com/corvid_full.jpg',
  avatar: 'https://avatars.steamstatic.com/corvid.jpg',
  countrycode: 'FR',
  last_updated: '2026-11-14T16:31:40Z',
  profileurl: `https://steamcommunity.com/profiles/${STEAM_ID}/`,
  friends: [],
};

type App = ReturnType<typeof buildTestApp>;

/** Démarre une connexion et renvoie le return_to que Steam rappellerait. */
async function startLogin(app: App) {
  const res = await request(app).get('/api/auth/steam');
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
function callback(app: App, returnTo: string, assertion: object) {
  const url = new URL(returnTo);
  for (const [key, value] of Object.entries(assertion)) url.searchParams.set(key, value);
  return request(app).get(`${url.pathname}${url.search}`);
}

/** Connexion complète réussie ; renvoie le JWT. */
async function login(app: App): Promise<string> {
  const { returnTo } = await startLogin(app);
  const res = await callback(app, returnTo, steamAssertion(returnTo));
  const location = new URL(res.headers.location as string);
  return new URLSearchParams(location.hash.slice(1)).get('token') as string;
}

/** Code d'erreur transmis au front en query (`?error=`). */
const errorOf = (location: string) => new URL(location).searchParams.get('error');

describe('Connexion Steam OpenID (contrat back-steam-contract.md)', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: App;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/^\/openid\/login$/, { body: STEAM_VALID })
      .on(/^\/v1\/players\/steam$/, { body: [PROFILE] });
    app = buildTestApp({}, upstream.fetch);
  });

  describe('GET /api/auth/steam', () => {
    it('redirige vers Steam OpenID 2.0 avec return_to = callback du back', async () => {
      const { steamUrl, returnTo } = await startLogin(app);
      expect(`${steamUrl.origin}${steamUrl.pathname}`).toBe(STEAM_OPENID_ENDPOINT);
      expect(steamUrl.searchParams.get('openid.mode')).toBe('checkid_setup');
      expect(steamUrl.searchParams.get('openid.realm')).toBe(testEnv.API_PUBLIC_URL);
      expect(returnTo).toMatch(new RegExp(`^${testEnv.API_PUBLIC_URL}${CALLBACK}\\?state=`));
    });
  });

  describe('GET /api/auth/steam/callback', () => {
    it('succès → 302 <FRONT_URL>/auth/callback#token=<JWT>, rien en query', async () => {
      const { returnTo } = await startLogin(app);
      const res = await callback(app, returnTo, steamAssertion(returnTo));

      expect(res.status).toBe(302);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      const location = new URL(res.headers.location as string);
      expect(`${location.origin}${location.pathname}`).toBe(FRONT_CALLBACK);
      expect(location.search).toBe('');

      const fragment = new URLSearchParams(location.hash.slice(1));
      expect([...fragment.keys()]).toEqual(['token']);
      const payload = jwt.verify(fragment.get('token') as string, testEnv.JWT_SECRET, {
        algorithms: ['HS256'],
      }) as jwt.JwtPayload;
      const user = await UserModel.findById(payload.sub).lean();
      expect(user).toMatchObject({
        steamId: STEAM_ID,
        displayName: 'Corvid',
        avatarUrl: PROFILE.avatarfull,
      });
    });

    it('vérifie auprès de Steam en check_authentication et récupère le profil par account_id', async () => {
      await login(app);
      const [steamCall, profileCall] = upstream.calls;
      expect(steamCall?.pathname).toBe('/openid/login');
      expect(profileCall?.searchParams.get('account_ids')).toBe(String(ACCOUNT_ID));
    });

    it('reconnexion : même compte, profil rafraîchi', async () => {
      await login(app);
      upstream.reset();
      upstream
        .on(/^\/openid\/login$/, { body: STEAM_VALID })
        .on(/^\/v1\/players\/steam$/, { body: [{ ...PROFILE, personaname: 'Corvid v2' }] });
      await login(app);

      const users = await UserModel.find({ steamId: STEAM_ID }).lean();
      expect(users).toHaveLength(1);
      expect(users[0]?.displayName).toBe('Corvid v2');
    });

    it('profil Steam indisponible → connexion réussie avec repli sur le steamId', async () => {
      upstream.reset();
      upstream
        .on(/^\/openid\/login$/, { body: STEAM_VALID })
        .on(/^\/v1\/players\/steam$/, { status: 503 });
      expect(await login(app)).toEqual(expect.any(String));

      const user = await UserModel.findOne({ steamId: STEAM_ID }).lean();
      expect(user).toMatchObject({ displayName: STEAM_ID, avatarUrl: null });
    });

    it('profil indisponible à la reconnexion → pseudo existant conservé', async () => {
      await login(app);
      upstream.reset();
      upstream
        .on(/^\/openid\/login$/, { body: STEAM_VALID })
        .on(/^\/v1\/players\/steam$/, { networkError: true });
      await login(app);
      const user = await UserModel.findOne({ steamId: STEAM_ID }).lean();
      expect(user?.displayName).toBe('Corvid');
    });

    const rejected: Array<[string, (rt: string) => Record<string, string>, string]> = [
      [
        'annulation',
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

    it.each(rejected)('%s → ?error=%s, sans jeton ni compte', async (_label, build, expected) => {
      const { returnTo } = await startLogin(app);
      const res = await callback(app, returnTo, build(returnTo));
      const location = new URL(res.headers.location as string);
      expect(res.status).toBe(302);
      expect(`${location.origin}${location.pathname}`).toBe(FRONT_CALLBACK);
      expect(errorOf(location.toString())).toBe(expected);
      expect(location.hash).toBe('');
      expect(await UserModel.countDocuments()).toBe(0);
    });

    it('Steam répond is_valid:false → STEAM_AUTH_FAILED', async () => {
      upstream.reset();
      upstream.on(/openid/, { body: 'ns:http://specs.openid.net/auth/2.0\nis_valid:false\n' });
      const { returnTo } = await startLogin(app);
      const res = await callback(app, returnTo, steamAssertion(returnTo));
      expect(errorOf(res.headers.location as string)).toBe('STEAM_AUTH_FAILED');
    });

    it.each([
      ['erreur réseau', { networkError: true }],
      ['HTTP 503', { status: 503 }],
    ])('Steam injoignable (%s) → STEAM_UNAVAILABLE', async (_label, response) => {
      upstream.reset();
      upstream.on(/openid/, response);
      const { returnTo } = await startLogin(app);
      const res = await callback(app, returnTo, steamAssertion(returnTo));
      expect(errorOf(res.headers.location as string)).toBe('STEAM_UNAVAILABLE');
    });

    it.each([
      ['absent', ''],
      ['falsifié', 'lzz.abc.signature-bidon'],
      [
        'expiré',
        createLoginState(`${testEnv.JWT_SECRET}:steam-login-state`, Date.now() - 3_600_000),
      ],
      ['signé avec une autre clé', createLoginState('autre-cle')],
    ])('state %s → INVALID_STATE sans appel à Steam', async (_label, state) => {
      const rt = `${testEnv.API_PUBLIC_URL}${CALLBACK}?state=${encodeURIComponent(state)}`;
      const res = await callback(app, rt, steamAssertion(rt));
      expect(errorOf(res.headers.location as string)).toBe('INVALID_STATE');
      expect(upstream.calls).toHaveLength(0);
    });

    it('paramètre openid dupliqué (tableau) → STEAM_AUTH_FAILED', async () => {
      const { returnTo } = await startLogin(app);
      const url = new URL(returnTo);
      const res = await request(app).get(
        `${url.pathname}${url.search}&openid.mode=id_res&openid.mode=id_res`,
      );
      expect(errorOf(res.headers.location as string)).toBe('STEAM_AUTH_FAILED');
    });
  });

  describe('GET /api/auth/me', () => {
    it('200 → PublicUser { id, steamId, displayName, avatarUrl } sans enveloppe', async () => {
      const token = await login(app);
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        id: expect.stringMatching(/^[a-f\d]{24}$/),
        steamId: STEAM_ID,
        displayName: 'Corvid',
        avatarUrl: PROFILE.avatarfull,
      });
    });

    it('sans jeton → 401 UNAUTHORIZED', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('compte supprimé → 401 UNAUTHORIZED', async () => {
      const { auth, userId } = await createUser();
      await UserModel.deleteOne({ _id: userId });
      const res = await request(app).get('/api/auth/me').set(auth);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });
});

describe('CORS', () => {
  const app = buildTestApp();

  it('origine autorisée : preflight accepté pour Authorization', async () => {
    const res = await request(app)
      .options('/api/tracked-players')
      .set('Origin', 'http://front.test')
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://front.test');
    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it("origine non autorisée : aucun en-tête d'autorisation", async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.test');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
