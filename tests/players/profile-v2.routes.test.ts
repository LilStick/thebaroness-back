import request from 'supertest';
import { ApiCacheModel } from '../../src/database/api-cache';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const STEAM_ID = '76561198957316510';
const ACCOUNT_ID = 997050782;
const PROFILE = { account_id: ACCOUNT_ID, personaname: 'Corvid', avatarfull: null };
const HEROES = [
  {
    id: 1,
    name: 'Infernus',
    class_name: 'hero_inferno',
    images: { icon_image_small_webp: 'https://assets.test/1.webp' },
  },
  { id: 2, name: 'Seven', class_name: 'hero_gigawatt', images: {} },
  { id: 3, name: 'Vindicta', class_name: 'hero_hornet', images: {} },
];
const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** Partie brute (forme Deadlock API). `daysAgo` relatif à maintenant ; match_mode 1 = unranked, 4 = ranked. */
const raw = (
  id: string,
  daysAgo: number,
  extra: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  match_id: Number(id),
  hero_id: 1,
  start_time: NOW_S - Math.round(daysAgo * DAY),
  match_duration_s: 1800,
  player_kills: 10,
  player_deaths: 5,
  player_assists: 5,
  net_worth: 30000,
  player_match_outcome: 1,
  match_mode: 1,
  game_mode: 1,
  ...extra,
});

const HISTORY = [
  raw('110', 1, { match_mode: 4 }),
  raw('109', 2, { player_match_outcome: 2, hero_id: 2 }),
  raw('108', 3, { game_mode: 4, hero_id: 2 }),
  raw('107', 5, { match_mode: 4, player_deaths: null }),
  raw('106', 10, { hero_id: 3, net_worth: null }),
  raw('105', 20, { player_match_outcome: 2 }),
  raw('104', 40, { match_mode: 4, hero_id: 3 }),
  raw('103', 60),
  // Partie non scorée : jamais comptée.
  raw('102', 1, { player_match_outcome: 3 }),
];

describe('Profil V2', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  const mock = (history: unknown[] = HISTORY, seasonStart: number | null = NOW_S - 35 * DAY) =>
    upstream
      .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
      .on(/match-history$/, { body: history })
      .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] })
      .on(/^\/v1\/assets\/ranked-seasons$/, {
        body:
          seasonStart === null
            ? []
            : [{ intervals: [{ start_timestamp: seasonStart, end_timestamp: null }] }],
      });

  beforeEach(() => {
    upstream = createFetchMock();
    app = buildTestApp({}, upstream.fetch);
  });

  const get = (path: string, query: object = {}) =>
    request(app).get(`/api/players/${STEAM_ID}${path}`).query(query);
  const historyCalls = () =>
    upstream.calls.filter((u) => u.pathname.endsWith('match-history')).length;

  describe('GET /overview', () => {
    it('30 jours par défaut : résumé cohérent, modes, top héros, couverture', async () => {
      mock();
      const res = await get('/overview');
      expect(res.status).toBe(200);
      const { filters, summary, modes, topHeroes, coverage, meta } = res.body;
      expect(filters).toEqual({ period: '30d', gameMode: 'all', matchMode: 'all' });
      // 110..105 (6 parties sur 30 jours ; 102 non scorée exclue).
      expect(summary).toMatchObject({
        matches: 6,
        wins: 4,
        losses: 2,
        winRate: 66.67,
        // Partie 107 sans D : exclue des trois totaux.
        kills: 50,
        deaths: 25,
        assists: 25,
        kda: 3,
        kdaSampleSize: 5,
        avgNetWorthPerMinute: 1000,
        netWorthPerMinuteSampleSize: 5,
        avgDurationSeconds: 1800,
        durationSampleSize: 6,
        lastMatchAt: new Date((NOW_S - DAY) * 1000).toISOString(),
      });
      const sum = (key: string) =>
        (modes as Record<string, number>[]).reduce((t, x) => t + (x[key] ?? 0), 0);
      expect(sum('matches')).toBe(6);
      expect(modes[0]).toEqual({
        gameMode: 'normal',
        matchMode: 'unranked',
        matches: 3,
        wins: 1,
        losses: 2,
        winRate: 33.33,
      });
      expect(topHeroes.map((h: { heroId: number }) => h.heroId)).toEqual([1, 2, 3]);
      expect(topHeroes[0]).toEqual({
        heroId: 1,
        heroName: 'Infernus',
        heroImageUrl: 'https://assets.test/1.webp',
        matches: 3,
        wins: 2,
        losses: 1,
        winRate: 66.67,
        kda: 3,
        kdaSampleSize: 2,
      });
      expect(coverage).toMatchObject({
        includedMatches: 6,
        excludedUnknownMode: 0,
        unknownModeMatches: 0,
        isPartial: false,
        notes: [],
        observedTo: new Date((NOW_S - DAY) * 1000).toISOString(),
        observedFrom: new Date((NOW_S - 20 * DAY) * 1000).toISOString(),
      });
      expect(Date.parse(coverage.requestedTo) - Date.parse(coverage.requestedFrom)).toBe(
        30 * DAY * 1000,
      );
      expect(meta).toMatchObject({ isStale: false, isPartial: false });
    });

    it('filtres combinés : 7 jours, normal, classées', async () => {
      mock();
      const res = await get('/overview', { period: '7d', gameMode: 'normal', matchMode: 'ranked' });
      expect(res.body.summary).toMatchObject({ matches: 2, wins: 2 });
      expect(res.body.modes).toEqual([
        { gameMode: 'normal', matchMode: 'ranked', matches: 2, wins: 2, losses: 0, winRate: 100 },
      ]);
    });

    it('Street Brawl seul : indépendant du type de partie', async () => {
      mock();
      const res = await get('/overview', { gameMode: 'street_brawl' });
      expect(res.body.summary.matches).toBe(1);
      expect(res.body.modes[0]).toMatchObject({ gameMode: 'street_brawl', matchMode: 'unranked' });
    });

    it('saison : depuis le début de saison (35 jours), inconnue → tout l’historique et isPartial', async () => {
      mock();
      let res = await get('/overview', { period: 'season' });
      expect(res.body.summary.matches).toBe(6);
      expect(res.body.coverage.requestedFrom).toBe(
        new Date((NOW_S - 35 * DAY) * 1000).toISOString(),
      );

      await ApiCacheModel.deleteMany({ key: 'catalog:season-start' });
      upstream.reset();
      mock(HISTORY, null);
      res = await get('/overview', { period: 'season' });
      expect(res.body.summary.matches).toBe(8);
      expect(res.body.coverage).toMatchObject({
        requestedFrom: null,
        isPartial: true,
        notes: ['season_start_unknown'],
      });
      expect(res.body.meta.isPartial).toBe(true);
    });

    it('source des saisons en panne → saison inconnue sur overview, matches et heroes', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
        .on(/match-history$/, { body: HISTORY })
        .on(/^\/v1\/assets\/ranked-seasons$/, { status: 503 })
        .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
        .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] });
      const overview = await get('/overview', { period: 'season' });
      expect(overview.status).toBe(200);
      expect(overview.body.coverage.notes).toContain('season_start_unknown');
      const matches = await get('/matches', { period: 'season', limit: 50 });
      expect(matches.body.items).toHaveLength(8);
      expect(matches.body.meta.isPartial).toBe(true);
      const heroes = await get('/heroes', { period: 'season' });
      expect(heroes.body.meta.isPartial).toBe(true);
    });

    it('aucune partie dans la période → 200, compteurs à 0, ratios null', async () => {
      mock([raw('1', 90)]);
      const res = await get('/overview', { period: '7d' });
      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({
        matches: 0,
        winRate: null,
        kda: null,
        kdaSampleSize: 0,
        lastMatchAt: null,
      });
      expect(res.body).toMatchObject({ modes: [], topHeroes: [] });
      expect(res.body.coverage).toMatchObject({
        observedFrom: null,
        observedTo: null,
        includedMatches: 0,
      });
    });

    it('modes inconnus (cache ancien) : comptés sous « all », exclus d’un filtre précis', async () => {
      mock([raw('1', 1, { match_mode: null, game_mode: 0 }), raw('2', 1)]);
      let res = await get('/overview');
      expect(res.body.summary.matches).toBe(2);
      expect(res.body.modes).toHaveLength(1);
      expect(res.body.coverage).toMatchObject({
        unknownModeMatches: 1,
        notes: ['unknown_mode_included'],
      });

      res = await get('/overview', { gameMode: 'normal' });
      expect(res.body.summary.matches).toBe(1);
      expect(res.body.coverage).toMatchObject({
        excludedUnknownMode: 1,
        notes: ['unknown_mode_excluded'],
      });
    });

    it('catalogue des héros indisponible → noms de repli et isPartial', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
        .on(/match-history$/, { body: HISTORY })
        .on(/^\/v1\/assets\//, { status: 503 });
      const res = await get('/overview');
      expect(res.body.topHeroes[0]).toMatchObject({ heroName: 'Héros #1', heroImageUrl: null });
      expect(res.body.meta.isPartial).toBe(true);
    });

    it('un seul appel d’historique pour plusieurs périodes et filtres (cache partagé)', async () => {
      mock();
      await get('/overview');
      await get('/overview', { period: '7d' });
      await get('/overview', { period: 'season', matchMode: 'ranked' });
      await get('/matches', { period: '7d' });
      await get('/heroes', { gameMode: 'normal' });
      expect(historyCalls()).toBe(1);
    });

    it.each([[{ period: '1y' }], [{ gameMode: 'sandbox' }], [{ matchMode: 'coop_bot' }]])(
      '%p → 400 sans appel externe',
      async (query) => {
        const res = await get('/overview', query);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_INPUT');
        expect(upstream.calls).toHaveLength(0);
      },
    );

    it('joueur introuvable → 404', async () => {
      mock();
      upstream.reset();
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [] })
        .on(/match-history$/, { body: [] })
        .on(/assets/, { body: [] });
      expect((await get('/overview')).status).toBe(404);
    });
  });

  describe('GET /matches filtré', () => {
    it('sans filtre : identique à v1.8 (tout l’historique), appliedFilters neutres', async () => {
      mock();
      const res = await get('/matches', { limit: 50 });
      expect(res.body.items).toHaveLength(8);
      expect(res.body.appliedFilters).toEqual({
        period: null,
        gameMode: 'all',
        matchMode: 'all',
        heroId: null,
        outcome: 'all',
      });
    });

    it('filtre appliqué avant la pagination, curseur lié aux filtres, aucune perte ni doublon', async () => {
      mock();
      const query = { matchMode: 'unranked', limit: 2 };
      const page1 = await get('/matches', query);
      expect(page1.body.items.map((m: { matchId: string }) => m.matchId)).toEqual(['109', '108']);
      const page2 = await get('/matches', { ...query, cursor: page1.body.nextCursor });
      expect(page2.body.items.map((m: { matchId: string }) => m.matchId)).toEqual(['106', '105']);
      const page3 = await get('/matches', { ...query, cursor: page2.body.nextCursor });
      expect(page3.body.items.map((m: { matchId: string }) => m.matchId)).toEqual(['103']);
      expect(page3.body.nextCursor).toBeNull();
    });

    it('curseur d’autres filtres ou de la v1.8 → 400 ; curseur filtré sans filtre → 400', async () => {
      mock();
      const filtered = await get('/matches', { period: '7d', limit: 1 });
      const plain = await get('/matches', { limit: 1 });
      const other = await get('/matches', { period: '30d', cursor: filtered.body.nextCursor });
      expect(other.status).toBe(400);
      expect(other.body.error.message).toMatch(/autres filtres/);
      expect((await get('/matches', { period: '7d', cursor: plain.body.nextCursor })).status).toBe(
        400,
      );
      expect((await get('/matches', { cursor: filtered.body.nextCursor })).status).toBe(400);
      // Curseur v1.8 sans filtre : toujours valable.
      expect((await get('/matches', { cursor: plain.body.nextCursor })).status).toBe(200);
    });

    it('même date de début : départage par matchId décroissant, pagination sans doublon', async () => {
      const big = ['136927165', '136927163', '136927164'];
      mock(big.map((id) => raw(id, 1)));
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await get('/matches', {
          outcome: 'win',
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...res.body.items.map((m: { matchId: string }) => m.matchId));
        cursor = res.body.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toEqual(['136927165', '136927164', '136927163']);
    });

    it('héros, résultat et période combinés ; aucun résultat → items vides', async () => {
      mock();
      let res = await get('/matches', { heroId: 2, outcome: 'win', period: '7d' });
      expect(res.body.items.map((m: { matchId: string }) => m.matchId)).toEqual(['108']);
      expect(res.body.appliedFilters).toMatchObject({ heroId: 2, outcome: 'win', period: '7d' });
      res = await get('/matches', { heroId: 99 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ items: [], nextCursor: null });
    });

    it.each([[{ heroId: 0 }], [{ outcome: 'draw' }], [{ period: 'all' }]])(
      '%p → 400',
      async (query) => {
        expect((await get('/matches', query)).status).toBe(400);
      },
    );
  });

  describe('GET /heroes filtré', () => {
    it('période et modes ; champs ajoutés (pertes, échantillons, net worth/min)', async () => {
      mock();
      const res = await get('/heroes', { period: '7d', gameMode: 'normal' });
      expect(res.status).toBe(200);
      // 7 jours, normal : 110, 109, 107 (108 est en Street Brawl).
      expect(res.body.items).toEqual([
        {
          heroId: 1,
          heroName: 'Infernus',
          heroImageUrl: 'https://assets.test/1.webp',
          matches: 2,
          wins: 2,
          losses: 0,
          winRate: 100,
          kda: 3,
          kdaSampleSize: 1,
          avgNetWorthPerMinute: 1000,
          netWorthPerMinuteSampleSize: 2,
          globalMeta: null,
          winRateVsMeta: null,
        },
        expect.objectContaining({ heroId: 2, matches: 1, wins: 0, losses: 1, winRate: 0 }),
      ]);
      expect(res.body.appliedFilters).toMatchObject({ period: '7d', gameMode: 'normal' });
    });

    it('sans filtre : tout l’historique, comme en v1.8', async () => {
      mock();
      const res = await get('/heroes');
      const total = res.body.items.reduce((t: number, h: { matches: number }) => t + h.matches, 0);
      expect(total).toBe(8);
    });
  });
});
