import request from 'supertest';
import { ApiCacheModel } from '../../src/database/api-cache';
import {
  categoryLabel,
  latestVersions,
  normalizeBuild,
} from '../../src/modules/builds/builds.service';
import { analyticsFilter } from '../../src/modules/items/items.service';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const HEROES = [
  {
    id: 81,
    name: 'Celeste',
    class_name: 'hero_celeste',
    images: {},
    player_selectable: true,
    disabled: false,
    development_state: 'release',
  },
];
const ITEMS = [
  { id: 100, class_name: 'upgrade_a', name: 'A', type: 'upgrade' },
  { id: 200, class_name: 'upgrade_b', name: 'B', type: 'upgrade' },
];
const STATS = [
  {
    item_id: 200,
    wins: 30,
    losses: 10,
    matches: 40,
    players: 25,
    sold: 0,
    avg_buy_time_s: 600.4,
    avg_sell_time_s: 0,
  },
  {
    item_id: 100,
    wins: 60,
    losses: 40,
    matches: 100,
    players: 70,
    sold: 25,
    avg_buy_time_s: 300.6,
    avg_sell_time_s: 1500.2,
  },
];

const build = (id: number, version: number, extra: object = {}, buildExtra: object = {}) => ({
  num_favorites: 10,
  num_weekly_favorites: null,
  ...extra,
  hero_build: {
    hero_id: 81,
    hero_build_id: id,
    author_account_id: 5,
    last_updated_timestamp: 1_790_000_000 + version,
    publish_timestamp: 1_780_000_000,
    name: `Build ${id} v${version}`,
    description: '',
    language: 0,
    version,
    details: {
      mod_categories: [
        {
          name: '#Citadel_HeroBuilds_EarlyGame',
          description: '',
          mods: [{ ability_id: 100, annotation: '' }],
        },
        { name: 'Situational picks', mods: [{ ability_id: 200, annotation: 'vs heal' }] },
      ],
    },
    ...buildExtra,
  },
});

describe('Analytique des items et builds', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] })
      .on(/client-versions$/, { body: [3] })
      .on(/^\/v1\/assets\/items$/, { body: ITEMS })
      .on(/item-stats$/, { body: STATS });
    app = buildTestApp({}, upstream.fetch);
  });

  describe('GET /api/items/stats et /api/items/:itemId/stats', () => {
    it('liste triée par volume, ratios, temps arrondis, revente absente → null', async () => {
      const res = await request(app).get('/api/items/stats');
      expect(res.status).toBe(200);
      expect(res.body.filters).toMatchObject({
        period: '30d',
        heroId: null,
        matchMode: 'all',
        gameMode: 'normal',
      });
      expect(res.body.items).toEqual([
        {
          itemId: 100,
          matches: 100,
          wins: 60,
          losses: 40,
          winRate: 60,
          players: 70,
          sold: 25,
          sellRate: 25,
          avgBuyTimeSeconds: 301,
          avgSellTimeSeconds: 1500,
        },
        expect.objectContaining({
          itemId: 200,
          winRate: 75,
          sellRate: 0,
          avgSellTimeSeconds: null,
        }),
      ]);
      const call = upstream.calls.find((u) => u.pathname.endsWith('item-stats'));
      expect(call?.searchParams.get('game_mode')).toBe('normal');
      expect(Number(call?.searchParams.get('min_unix_timestamp')) % 3600).toBe(0);
      expect(call?.searchParams.has('hero_id')).toBe(false);
    });

    it('héros, type de partie et période transmis ; une requête source par jeu de filtres', async () => {
      const query = { heroId: 81, matchMode: 'ranked', period: '7d' };
      await request(app).get('/api/items/stats').query(query);
      await request(app).get('/api/items/stats').query(query);
      await request(app).get('/api/items/100/stats').query(query);
      const calls = upstream.calls.filter((u) => u.pathname.endsWith('item-stats'));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.searchParams.get('hero_id')).toBe('81');
      expect(calls[0]?.searchParams.get('match_mode')).toBe('Ranked');
      await request(app).get('/api/items/stats').query({ matchMode: 'unranked' });
      expect(
        upstream.calls
          .filter((u) => u.pathname.endsWith('item-stats'))
          .at(-1)
          ?.searchParams.get('match_mode'),
      ).toBe('Unranked');
    });

    it('un item : ligne, sous le seuil → stats null et note, inconnu → 404', async () => {
      upstream.reset();
      upstream
        .on(/client-versions$/, { body: [3] })
        .on(/^\/v1\/assets\/items$/, { body: ITEMS })
        .on(/item-stats$/, { body: STATS.slice(1) });
      let res = await request(app).get('/api/items/100/stats');
      expect(res.body).toMatchObject({ itemId: 100, stats: { matches: 100 }, notes: [] });
      res = await request(app).get('/api/items/200/stats');
      expect(res.body).toMatchObject({
        itemId: 200,
        stats: null,
        notes: ['below_source_threshold'],
      });
      expect((await request(app).get('/api/items/999/stats')).status).toBe(404);
    });

    it.each([[{ period: '90d' }], [{ heroId: 0 }], [{ matchMode: 'all' }]])(
      '%p → 400',
      async (query) => {
        expect((await request(app).get('/api/items/stats').query(query)).status).toBe(400);
      },
    );

    it('source en panne sans copie → 503', async () => {
      upstream.reset();
      upstream.on(/item-stats$/, { status: 503 });
      expect((await request(app).get('/api/items/stats')).status).toBe(503);
    });
  });

  describe('GET /api/heroes/:heroId/item-pairs', () => {
    beforeEach(() => {
      upstream.on(/item-permutation-stats$/, {
        body: [
          { item_ids: [200, 100], wins: 6, losses: 4, matches: 10 },
          { item_ids: [300, 100], wins: 30, losses: 10, matches: 40 },
          { item_ids: [400], wins: 1, losses: 1, matches: 2 },
          { item_ids: [500, 600], wins: 0, losses: 1, matches: 1 },
        ],
      });
    });

    it('paires normalisées (ids croissants), par volume, filtre d’item et limite', async () => {
      const res = await request(app).get('/api/heroes/81/item-pairs');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([
        { itemIds: [100, 300], matches: 40, wins: 30, losses: 10, winRate: 75 },
        { itemIds: [100, 200], matches: 10, wins: 6, losses: 4, winRate: 60 },
        { itemIds: [500, 600], matches: 1, wins: 0, losses: 1, winRate: 0 },
      ]);
      const call = upstream.calls.find((u) => u.pathname.endsWith('item-permutation-stats'));
      expect(call?.searchParams.get('hero_id')).toBe('81');
      expect(call?.searchParams.get('comb_size')).toBe('2');

      const withItem = await request(app).get('/api/heroes/81/item-pairs').query({ itemId: 200 });
      expect(withItem.body.items.map((p: { itemIds: number[] }) => p.itemIds)).toEqual([
        [100, 200],
      ]);
      expect(withItem.body.filters.itemId).toBe(200);
      const limited = await request(app).get('/api/heroes/81/item-pairs').query({ limit: 1 });
      expect(limited.body.items).toHaveLength(1);
      expect(
        upstream.calls.filter((u) => u.pathname.endsWith('item-permutation-stats')),
      ).toHaveLength(1);
    });

    it('héros inconnu → 404 ; paramètres invalides → 400', async () => {
      expect((await request(app).get('/api/heroes/999/item-pairs')).status).toBe(404);
      expect(
        (await request(app).get('/api/heroes/81/item-pairs').query({ limit: 101 })).status,
      ).toBe(400);
      expect((await request(app).get('/api/heroes/x/item-pairs')).status).toBe(400);
    });
  });

  describe('GET /api/heroes/:heroId/builds', () => {
    it('dernière version de chaque build, tri par favoris, catégories nommées', async () => {
      upstream.on(/^\/v1\/builds$/, {
        body: [
          build(1, 5, { num_favorites: 50 }),
          build(1, 7, { num_favorites: 40 }),
          build(2, 1, { num_favorites: 45 }),
          build(3, 1, { num_favorites: null }),
          build(4, 1, {}, { hero_id: 6 }),
        ],
      });
      const res = await request(app).get('/api/heroes/81/builds');
      expect(res.status).toBe(200);
      expect(
        res.body.items.map((b: { buildId: number; version: number }) => [b.buildId, b.version]),
      ).toEqual([
        [2, 1],
        [1, 7],
        [3, 1],
      ]);
      expect(res.body.items[1]).toMatchObject({
        name: 'Build 1 v7',
        authorSteamId: '76561197960265733',
        favorites: 40,
        description: null,
        publishedAt: new Date(1_780_000_000 * 1000).toISOString(),
        categories: [
          { name: 'Early Game', description: null, items: [{ itemId: 100, annotation: null }] },
          {
            name: 'Situational picks',
            description: null,
            items: [{ itemId: 200, annotation: 'vs heal' }],
          },
        ],
      });
      const call = upstream.calls.find((u) => u.pathname === '/v1/builds');
      expect(call?.searchParams.get('sort_by')).toBe('favorites');
      expect(call?.searchParams.has('only_latest')).toBe(false);
    });

    it('autres tris, limite, cache par tri ; héros inconnu → 404 ; tri invalide → 400', async () => {
      upstream.on(/^\/v1\/builds$/, {
        body: [
          build(1, 1, { num_favorites: null, num_weekly_favorites: 3 }),
          build(2, 1, { num_favorites: null, num_weekly_favorites: 9 }),
        ],
      });
      const res = await request(app)
        .get('/api/heroes/81/builds')
        .query({ sort: 'weekly_favorites', limit: 1 });
      expect(res.body).toMatchObject({
        sort: 'weekly_favorites',
        items: [{ buildId: 2, weeklyFavorites: 9 }],
      });
      await request(app).get('/api/heroes/81/builds').query({ sort: 'weekly_favorites' });
      await request(app).get('/api/heroes/81/builds').query({ sort: 'updated_at' });
      await request(app).get('/api/heroes/81/builds').query({ sort: 'published_at' });
      expect(upstream.calls.filter((u) => u.pathname === '/v1/builds')).toHaveLength(3);
      expect(await ApiCacheModel.exists({ key: 'builds:v2:81:weekly_favorites' })).toBeTruthy();
      expect((await request(app).get('/api/heroes/999/builds')).status).toBe(404);
      expect(
        (await request(app).get('/api/heroes/81/builds').query({ sort: 'likes' })).status,
      ).toBe(400);
    });
  });
});

describe('Fonctions analytiques', () => {
  it('analyticsFilter : borne arrondie à l’heure, filtres reportés', () => {
    const now = Date.UTC(2026, 10, 17, 15, 42, 10);
    const filter = analyticsFilter({ period: '7d', heroId: 3, matchMode: 'ranked' }, now);
    expect(new Date(filter.minTimestamp * 1000).toISOString()).toBe('2026-11-10T15:00:00.000Z');
    expect(filter).toMatchObject({ heroId: 3, matchMode: 'ranked' });
  });

  it('categoryLabel : clés Valve lisibles, nom libre conservé, vide → null', () => {
    expect(categoryLabel('#Citadel_HeroBuilds_LateGame')).toBe('Late Game');
    expect(categoryLabel('Mid Core')).toBe('Mid Core');
    expect(categoryLabel('')).toBeNull();
    expect(categoryLabel(undefined)).toBeNull();
  });

  it('normalizeBuild et latestVersions : champs absents → null, version la plus haute gardée', () => {
    const minimal = normalizeBuild({ hero_build: { hero_id: 1, hero_build_id: 9 } } as never);
    expect(minimal).toMatchObject({
      name: null,
      authorSteamId: null,
      version: null,
      publishedAt: null,
      favorites: null,
      categories: [],
    });
    const kept = latestVersions([
      { ...minimal, version: null },
      { ...minimal, version: 2 },
      { ...minimal, version: 1 },
    ]);
    expect(kept).toEqual([{ ...minimal, version: 2 }]);
  });
});
