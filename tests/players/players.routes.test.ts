import request from 'supertest';
import { ApiCacheModel } from '../../src/database/api-cache';
import { buildTestApp, testEnv } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const STEAM_ID = '76561198957316510';
const ACCOUNT_ID = 997050782;
const PROFILE = {
  account_id: ACCOUNT_ID,
  personaname: 'Corvid',
  avatarfull: 'https://avatars.test/corvid_full.jpg',
  avatar: 'https://avatars.test/corvid.jpg',
  countrycode: 'FR',
  last_updated: '2026-11-14T16:31:40Z',
  realname: null,
  friends: [{ account_id: 1, friend_since: '2020-01-01T00:00:00Z' }],
};

/** Entrée brute d'historique (forme Deadlock API) ; outcome 1 = victoire, 2 = défaite. */
const entry = (matchId: number, startTime: number, outcome: number, extra: object = {}) => ({
  account_id: ACCOUNT_ID,
  match_id: matchId,
  hero_id: 1,
  hero_level: 20,
  start_time: startTime,
  game_mode: 1,
  match_mode: 1,
  player_team: 0,
  player_kills: 10,
  player_deaths: 4,
  player_assists: 6,
  denies: 3,
  net_worth: 30000,
  last_hits: 100,
  match_duration_s: 1800,
  match_result: 0,
  objectives_mask_team0: 0,
  objectives_mask_team1: 0,
  player_match_outcome: outcome,
  ...extra,
});

const HISTORY = [
  entry(103, 1_794_740_700, 1, { ranked_display_badge: 113 }),
  entry(101, 1_794_740_500, 2, { hero_id: 2, ranked_display_badge: null }),
  entry(102, 1_794_740_600, 1, { ranked_display_badge: 112 }),
  // Partie non scorée (abandon/pénalité) : exclue de la liste et des statistiques.
  entry(104, 1_794_740_800, 3),
];

const RANKS = [
  {
    tier: 0,
    name: 'Obscurus',
    color: '#333333',
    images: { large: 'https://assets.test/rank0.png' },
  },
  {
    tier: 11,
    name: 'Éternus',
    color: '#5CE9A9',
    images: {
      large_webp: 'https://assets.test/rank11_lg.webp',
      large_subrank3_webp: 'https://assets.test/ranks/11/3.webp',
    },
  },
];

const HEROES = [
  {
    id: 1,
    name: 'Infernus',
    class_name: 'hero_inferno',
    images: { icon_image_small_webp: 'https://assets.test/inferno_sm.webp' },
  },
  { id: 2, name: 'Seven', class_name: 'hero_gigawatt', images: {} },
];

describe('Routes /api/players', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  const mockAll = () =>
    upstream
      .on(/^\/v1\/players\/steam-search$/, { body: [PROFILE] })
      .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
      .on(/^\/v1\/players\/\d+\/match-history$/, { body: HISTORY })
      .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] })
      .on(/^\/v1\/assets\/ranks$/, { body: RANKS });

  beforeEach(() => {
    upstream = createFetchMock();
    app = buildTestApp({}, upstream.fetch);
  });

  const isoDate = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/);

  describe('GET /api/players/search', () => {
    it('T-15 : réponse normalisée, aucun champ brut ni clé tierce', async () => {
      mockAll();
      const res = await request(app).get('/api/players/search').query({ q: '  Corvid ' });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        items: [
          {
            steamId: STEAM_ID,
            accountId: ACCOUNT_ID,
            displayName: 'Corvid',
            avatarUrl: PROFILE.avatarfull,
          },
        ],
        meta: { fetchedAt: isoDate, sourceUpdatedAt: null, isStale: false, isPartial: false },
      });
      expect(upstream.calls[0]?.searchParams.get('search_query')).toBe('Corvid');
      expect(JSON.stringify(res.body)).not.toMatch(/personaname|friends|deadlock\.test/);
    });

    it('recherche par SteamID64 → transmise au fournisseur en account_id', async () => {
      mockAll();
      await request(app).get('/api/players/search').query({ q: STEAM_ID }).expect(200);
      expect(upstream.calls[0]?.searchParams.get('search_query')).toBe(String(ACCOUNT_ID));
    });

    it('aucun résultat → 200 items vides', async () => {
      upstream.on(/steam-search/, { body: [] });
      const res = await request(app).get('/api/players/search').query({ q: 'personne' });
      expect(res.body.items).toEqual([]);
    });

    it('avatar absent → avatarUrl null', async () => {
      upstream.on(/steam-search/, { body: [{ ...PROFILE, avatarfull: '', avatar: null }] });
      const res = await request(app).get('/api/players/search').query({ q: 'x' });
      expect(res.body.items[0].avatarUrl).toBeNull();
    });

    it.each([
      ['absent', {}],
      ['vide après trim', { q: '   ' }],
      ['trop long', { q: 'x'.repeat(65) }],
    ])('q %s → 400 INVALID_INPUT sans appel externe', async (_label, query) => {
      const res = await request(app).get('/api/players/search').query(query);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(upstream.calls).toHaveLength(0);
    });

    it('deuxième recherche identique servie par le cache', async () => {
      mockAll();
      await request(app).get('/api/players/search').query({ q: 'Corvid' });
      await request(app).get('/api/players/search').query({ q: 'corvid' });
      expect(upstream.calls).toHaveLength(1);
    });

    it('T-16 : fournisseur indisponible sans cache → 503 SERVICE_UNAVAILABLE + Retry-After', async () => {
      upstream.on(/steam-search/, { status: 503, headers: { 'retry-after': '12' } });
      const res = await request(app).get('/api/players/search').query({ q: 'x' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.headers['retry-after']).toBe('12');
    });

    it('T-16 : fournisseur indisponible avec cache expiré → données périmées (isStale)', async () => {
      mockAll();
      await request(app).get('/api/players/search').query({ q: 'Corvid' });
      await ApiCacheModel.updateMany({}, { $set: { expiresAt: new Date(0) } });

      upstream.reset();
      upstream.on(/steam-search/, { networkError: true });
      const res = await request(app).get('/api/players/search').query({ q: 'Corvid' });
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.meta.isStale).toBe(true);
    });
  });

  describe('GET /api/players/:steamId', () => {
    it('profil complet : joueur, stats agrégées, rang, région, méta', async () => {
      mockAll();
      const res = await request(app).get(`/api/players/${STEAM_ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        player: {
          steamId: STEAM_ID,
          accountId: ACCOUNT_ID,
          displayName: 'Corvid',
          avatarUrl: PROFILE.avatarfull,
          region: 'FR',
        },
        stats: {
          matchesPlayed: 3,
          wins: 2,
          losses: 1,
          winRate: 66.67,
          kills: 30,
          deaths: 12,
          assists: 18,
          kda: 4,
        },
        rank: {
          badgeId: 113,
          name: 'Éternus 3',
          tier: 11,
          subrank: 3,
          imageUrl: 'https://assets.test/ranks/11/3.webp',
          color: '#5CE9A9',
        },
        meta: {
          fetchedAt: isoDate,
          sourceUpdatedAt: '2026-11-14T16:31:40.000Z',
          isStale: false,
          isPartial: false,
        },
      });
    });

    it('aucune partie → stats à 0 sur les compteurs et null pour les ratios', async () => {
      upstream.on(/^\/v1\/players\/steam$/, { body: [PROFILE] }).on(/match-history/, { body: [] });
      const res = await request(app).get(`/api/players/${STEAM_ID}`);
      expect(res.body.stats).toStrictEqual({
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        winRate: null,
        kills: null,
        deaths: null,
        assists: null,
        kda: null,
      });
    });

    it('historique indisponible → profil servi, stats null, isPartial', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [{ ...PROFILE, countrycode: null }] })
        .on(/match-history/, { status: 503 });
      const res = await request(app).get(`/api/players/${STEAM_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.player.region).toBeNull();
      expect(Object.values(res.body.stats).every((value) => value === null)).toBe(true);
      expect(res.body.meta.isPartial).toBe(true);
    });

    it('joueur introuvable → 404 NOT_FOUND', async () => {
      upstream.on(/^\/v1\/players\/steam$/, { body: [] }).on(/match-history/, { body: [] });
      const res = await request(app).get(`/api/players/${STEAM_ID}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it.each(['123', '76561190000000000', 'abc', '765611989573165100'])(
      'steamId invalide %s → 400',
      async (steamId) => {
        const res = await request(app).get(`/api/players/${steamId}`);
        expect(res.status).toBe(400);
        expect(upstream.calls).toHaveLength(0);
      },
    );

    it('format inattendu du fournisseur → 502 UPSTREAM_ERROR', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: { unexpected: true } })
        .on(/match-history/, { body: [] });
      const res = await request(app).get(`/api/players/${STEAM_ID}`);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    });
  });

  describe('GET /api/players/:steamId/matches', () => {
    it('liste normalisée, triée, parties non scorées exclues, nom de héros résolu', async () => {
      mockAll();
      const res = await request(app).get(`/api/players/${STEAM_ID}/matches`);

      expect(res.status).toBe(200);
      expect(res.body.items.map((m: { matchId: string }) => m.matchId)).toEqual([
        '103',
        '102',
        '101',
      ]);
      expect(res.body.items[0]).toStrictEqual({
        matchId: '103',
        playedAt: new Date(1_794_740_700 * 1000).toISOString(),
        heroId: 1,
        heroName: 'Infernus',
        heroImageUrl: 'https://assets.test/inferno_sm.webp',
        outcome: 'win',
        durationSeconds: 1800,
        kills: 10,
        deaths: 4,
        assists: 6,
        netWorth: 30000,
      });
      expect(res.body.items[2]).toMatchObject({ heroName: 'Seven', outcome: 'loss' });
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.meta).toMatchObject({ isStale: false, isPartial: false });
    });

    it('pagination par curseur opaque sans doublon ni trou', async () => {
      mockAll();
      const page1 = await request(app).get(`/api/players/${STEAM_ID}/matches`).query({ limit: 2 });
      expect(page1.body.items.map((m: { matchId: string }) => m.matchId)).toEqual(['103', '102']);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await request(app)
        .get(`/api/players/${STEAM_ID}/matches`)
        .query({ limit: 2, cursor: page1.body.nextCursor });
      expect(page2.body.items.map((m: { matchId: string }) => m.matchId)).toEqual(['101']);
      expect(page2.body.nextCursor).toBeNull();
    });

    it("un seul appel d'historique partagé entre profil et liste (cache)", async () => {
      mockAll();
      await request(app).get(`/api/players/${STEAM_ID}`);
      await request(app).get(`/api/players/${STEAM_ID}/matches`);
      const historyCalls = upstream.calls.filter((url) => url.pathname.endsWith('match-history'));
      expect(historyCalls).toHaveLength(1);
    });

    it('catalogue des héros indisponible → nom de repli et isPartial', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
        .on(/match-history/, { body: HISTORY })
        .on(/heroes/, { status: 500 });
      const res = await request(app).get(`/api/players/${STEAM_ID}/matches`);
      expect(res.status).toBe(200);
      expect(res.body.items[0].heroName).toBe('Héros #1');
      expect(res.body.meta.isPartial).toBe(true);
    });

    it('valeurs inconnues → null, jamais 0', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
        .on(/match-history/, {
          body: [entry(1, 1_794_740_000, 1, { net_worth: null, match_duration_s: null })],
        })
        .on(/heroes/, { body: HEROES });
      const res = await request(app).get(`/api/players/${STEAM_ID}/matches`);
      expect(res.body.items[0]).toMatchObject({ netWorth: null, durationSeconds: null });
    });

    it('aucune partie → items vides', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
        .on(/match-history/, { body: [] })
        .on(/heroes/, { body: HEROES });
      const res = await request(app).get(`/api/players/${STEAM_ID}/matches`);
      expect(res.body).toMatchObject({ items: [], nextCursor: null });
    });

    it('joueur introuvable → 404', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [] })
        .on(/match-history/, { body: [] })
        .on(/heroes/, { body: HEROES });
      const res = await request(app).get(`/api/players/${STEAM_ID}/matches`);
      expect(res.status).toBe(404);
    });

    it.each([
      ['limit 0', { limit: 0 }],
      ['limit 51', { limit: 51 }],
      ['limit décimal', { limit: 1.5 }],
      ['limit texte', { limit: 'abc' }],
      ['curseur illisible', { cursor: 'pas-un-curseur' }],
      ['curseur forgé', { cursor: Buffer.from('1:2:3').toString('base64url') }],
    ])('%s → 400 INVALID_INPUT', async (_label, query) => {
      mockAll();
      const res = await request(app).get(`/api/players/${STEAM_ID}/matches`).query(query);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });
  });

  it("aucune clé API Deadlock n'apparaît dans les réponses", async () => {
    upstream = createFetchMock();
    upstream.on(/steam-search/, { status: 500 });
    const keyed = buildTestApp({ DEADLOCK_API_KEY: 'super-secret' }, upstream.fetch);
    const res = await request(keyed).get('/api/players/search').query({ q: 'x' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/super-secret|deadlock\.test/);
    expect(testEnv.DEADLOCK_API_KEY).toBeUndefined();
  });
});
