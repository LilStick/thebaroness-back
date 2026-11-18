import { ApiCacheModel } from '../../src/database/api-cache';
import { accountIdToSteamId } from '../../src/shared/schemas';
import request from 'supertest';
import { computeHeroMetaStats, MIN_TIER_SAMPLE } from '../../src/modules/meta/meta.service';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const ASSET = 'https://assets.test';
const playable = {
  player_selectable: true,
  disabled: false,
  in_development: false,
  development_state: 'release',
};
const HEROES = [
  {
    id: 6,
    name: 'Abrams',
    hero_type: 'brawler',
    images: { icon_image_small_webp: `${ASSET}/6.webp` },
    ...playable,
  },
  {
    id: 72,
    name: 'Billy',
    hero_type: 'brawler',
    images: { icon_image_small_webp: `${ASSET}/72.webp` },
    ...playable,
  },
];

const STEAM_ID = '76561198040753956';
const ACCOUNT_ID = 80488228;

describe('Routes P1 (classement, stats méta, partie, héros d’un joueur)', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] });
    app = buildTestApp({}, upstream.fetch);
  });

  describe('GET /api/leaderboard', () => {
    const ENTRIES = {
      entries: [
        {
          account_name: 'MikaelS',
          possible_account_ids: [1, 2, 3],
          rank: 1,
          top_hero_ids: [72, 6, 72, 99, 5],
        },
        { account_name: 'soÿer', possible_account_ids: [ACCOUNT_ID], rank: 2, top_hero_ids: [72] },
        { account_name: null, possible_account_ids: [], rank: null, top_hero_ids: [] },
      ],
    };

    const RANKS = [
      {
        tier: 10,
        name: 'Phantom',
        color: '#C8A2C8',
        images: { large_webp: `${ASSET}/r10.webp`, large_subrank4_webp: `${ASSET}/r10_4.webp` },
      },
    ];

    it('région par défaut Europe ; compte univoque, homonyme sans rang ; 3 héros max', async () => {
      upstream
        .on(/^\/v1\/leaderboard\/Europe$/, { body: ENTRIES })
        .on(/^\/v1\/players\/rank$/, { body: [{ account_id: ACCOUNT_ID, badge: 104 }] })
        .on(/^\/v1\/players\/steam$/, {
          body: [
            { account_id: ACCOUNT_ID, personaname: 'soÿer', avatarfull: 'https://a.test/s.jpg' },
          ],
        })
        .on(/^\/v1\/assets\/ranks$/, { body: RANKS });
      const res = await request(app).get('/api/leaderboard');
      expect(res.status).toBe(200);
      expect(res.body.region).toBe('Europe');
      expect(res.body.items).toStrictEqual([
        {
          rank: 1,
          displayName: 'MikaelS',
          steamId: null,
          avatarUrl: null,
          inferred: false,
          badge: null,
          topHeroes: [
            { heroId: 72, name: 'Billy', imageUrl: `${ASSET}/72.webp` },
            { heroId: 6, name: 'Abrams', imageUrl: `${ASSET}/6.webp` },
            { heroId: 99, name: 'Héros #99', imageUrl: null },
          ],
        },
        {
          rank: 2,
          displayName: 'soÿer',
          steamId: STEAM_ID,
          // Ajouts v1.12.0 : avatar (un appel groupé), badgeId et couleur du rang.
          avatarUrl: 'https://a.test/s.jpg',
          inferred: false,
          badge: {
            tier: 10,
            subrank: 4,
            name: 'Phantom 4',
            imageUrl: `${ASSET}/r10_4.webp`,
            badgeId: 104,
            color: '#C8A2C8',
          },
          topHeroes: [expect.objectContaining({ heroId: 72 })],
        },
        {
          rank: 3,
          displayName: '',
          steamId: null,
          avatarUrl: null,
          inferred: false,
          badge: null,
          topHeroes: [],
        },
      ]);
      expect(res.body.coverage).toEqual({
        entries: 3,
        withSteamId: 1,
        inferredSteamId: 0,
        withBadge: 1,
        withAvatar: 1,
        ranksComplete: true,
      });
      // Avatars : un seul appel groupé, puis servis par le cache.
      await request(app).get('/api/leaderboard');
      expect(upstream.calls.filter((u) => u.pathname === '/v1/players/steam')).toHaveLength(1);
      expect(res.body.meta).toMatchObject({ isStale: false, isPartial: false });
      // Un seul appel de rangs pour tous les comptes candidats.
      const rankCalls = upstream.calls.filter((u) => u.pathname === '/v1/players/rank');
      expect(rankCalls.map((u) => u.searchParams.get('account_ids'))).toEqual([
        `1,2,3,${ACCOUNT_ID}`,
      ]);
    });

    it('homonyme dont un candidat est invérifiable → aucune déduction, isPartial', async () => {
      const many = Array.from({ length: 600 }, (_, i) => i + 1);
      upstream
        .on(/^\/v1\/leaderboard\/Europe$/, {
          body: { entries: [{ account_name: 'X', possible_account_ids: many, rank: 1 }] },
        })
        .on(/^\/v1\/players\/rank$/, (url) =>
          url.searchParams.get('account_ids')?.startsWith('1,')
            ? { body: [{ account_id: 1, badge: 104 }] }
            : { status: 500 },
        )
        .on(/^\/v1\/assets\/ranks$/, { body: RANKS });
      const res = await request(app).get('/api/leaderboard');
      expect(res.body.items[0]).toMatchObject({ steamId: null, inferred: false, badge: null });
      expect(res.body.meta.isPartial).toBe(true);
      // Copie incomplète gardée 1 min seulement (au lieu de 30) pour retenter vite.
      const entry = await ApiCacheModel.findOne({ key: /^leaderboard:/ }).lean();
      expect(entry && entry.expiresAt.getTime() - entry.fetchedAt.getTime()).toBe(60_000);
    });

    describe('repli sur l’historique (dernière partie classée sans rang)', () => {
      const history = (badges: (number | null)[]) =>
        badges.map((badge, i) => ({
          match_id: i + 1,
          hero_id: 6,
          start_time: 1000 - i,
          player_match_outcome: 1,
          match_mode: 4,
          ranked_display_badge: badge,
        }));
      const mockBoard = (rank: object, historyHandler: object) =>
        upstream
          .on(/^\/v1\/leaderboard\/Europe$/, {
            body: {
              entries: [{ account_name: 'soÿer', possible_account_ids: [ACCOUNT_ID], rank: 3 }],
            },
          })
          .on(/^\/v1\/players\/rank$/, { body: [{ account_id: ACCOUNT_ID, badge: 0, ...rank }] })
          .on(/match-history/, historyHandler)
          .on(/^\/v1\/assets\/ranks$/, { body: RANKS });

      it('badge 0 mais partie classée connue → dernier rang de l’historique', async () => {
        mockBoard({ last_match: { start_time: 1000 } }, { body: history([null, 104, 103]) });
        const res = await request(app).get('/api/leaderboard');
        expect(res.body.items[0]).toMatchObject({ inferred: false, badge: { name: 'Phantom 4' } });
        expect(res.body.meta.isPartial).toBe(false);
      });

      it('jamais joué en classé (last_match null) → pas de lecture d’historique', async () => {
        mockBoard({ last_match: null }, { body: [] });
        const res = await request(app).get('/api/leaderboard');
        expect(res.body.items[0].badge).toBeNull();
        expect(upstream.calls.some((u) => u.pathname.includes('match-history'))).toBe(false);
      });

      it('historique sans aucun rang → null ; historique en échec → null et isPartial', async () => {
        mockBoard({ last_match: { start_time: 1000 } }, { body: history([null, null]) });
        let res = await request(app).get('/api/leaderboard');
        expect(res.body.items[0].badge).toBeNull();
        expect(res.body.meta.isPartial).toBe(false);

        await ApiCacheModel.deleteMany({});
        upstream.reset();
        mockBoard({ last_match: { start_time: 1000 } }, { status: 500 });
        res = await request(app).get('/api/leaderboard');
        expect(res.body.items[0].badge).toBeNull();
        expect(res.body.meta.isPartial).toBe(true);
      });
    });

    it('homonymes : compte au rang le plus élevé, puis partie classée la plus récente ; inferred', async () => {
      upstream
        .on(/^\/v1\/leaderboard\/Europe$/, { body: ENTRIES })
        .on(/^\/v1\/players\/rank$/, {
          body: [
            { account_id: 1, badge: 104, last_match: { start_time: 10 } },
            { account_id: 2, badge: 104, last_match: { start_time: 20 } },
            { account_id: 3, badge: 0, last_match: null },
          ],
        })
        .on(/^\/v1\/assets\/ranks$/, { body: RANKS });
      const res = await request(app).get('/api/leaderboard');
      expect(res.body.items[0]).toMatchObject({
        steamId: accountIdToSteamId(2),
        inferred: true,
        badge: { name: 'Phantom 4' },
      });
      expect(res.body.meta.isPartial).toBe(false);
    });

    it.each([
      ['rangs indisponibles', { status: 503 }, { body: RANKS }],
      [
        'catalogue des rangs indisponible',
        { body: [{ account_id: ACCOUNT_ID, badge: 104 }] },
        { status: 503 },
      ],
    ])('%s → badge null et isPartial', async (_label, rankHandler, catalogHandler) => {
      upstream
        .on(/^\/v1\/leaderboard\/Europe$/, { body: ENTRIES })
        .on(/^\/v1\/players\/rank$/, rankHandler)
        .on(/^\/v1\/assets\/ranks$/, catalogHandler);
      const res = await request(app).get('/api/leaderboard');
      expect(res.status).toBe(200);
      expect(res.body.items.every((i: { badge: unknown }) => i.badge === null)).toBe(true);
      expect(res.body.meta.isPartial).toBe(true);
    });

    it('compte sans rang connu (badge 0 ou absent) → badge null, réponse complète', async () => {
      upstream
        .on(/^\/v1\/leaderboard\/Europe$/, { body: ENTRIES })
        .on(/^\/v1\/players\/rank$/, { body: [{ account_id: ACCOUNT_ID, badge: 0 }] })
        .on(/^\/v1\/assets\/ranks$/, { body: RANKS });
      const res = await request(app).get('/api/leaderboard');
      expect(res.body.items[1].badge).toBeNull();
      expect(res.body.meta.isPartial).toBe(false);
    });

    it('autre région transmise telle quelle', async () => {
      upstream.on(/^\/v1\/leaderboard\/NAmerica$/, { body: { entries: [] } });
      const res = await request(app).get('/api/leaderboard').query({ region: 'NAmerica' });
      expect(res.body).toMatchObject({ region: 'NAmerica', items: [] });
    });

    it.each(['europe', 'Mars'])('région %p invalide → 400 sans appel externe', async (region) => {
      const res = await request(app).get('/api/leaderboard').query({ region });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(upstream.calls.some((u) => u.pathname.includes('leaderboard'))).toBe(false);
    });
  });

  describe('GET /api/heroes/:heroId/stats', () => {
    const ANALYTICS = [
      // Palier 0 (non classé) : gros échantillon.
      {
        hero_id: 6,
        bucket: 0,
        matches: 1000,
        wins: 520,
        total_kills: 7000,
        total_deaths: 7000,
        total_assists: 12000,
      },
      // Palier 11 (badges 111 à 116) : échantillon cumulé 150 < seuil.
      {
        hero_id: 6,
        bucket: 113,
        matches: 100,
        wins: 60,
        total_kills: 900,
        total_deaths: 600,
        total_assists: 1300,
      },
      {
        hero_id: 6,
        bucket: 116,
        matches: 50,
        wins: 20,
        total_kills: 400,
        total_deaths: 500,
        total_assists: 700,
      },
      {
        hero_id: 72,
        bucket: 0,
        matches: 650,
        wins: 300,
        total_kills: 5000,
        total_deaths: 4000,
        total_assists: 9000,
      },
    ];

    it('agrégats du héros, palier sous le seuil → winRate null', async () => {
      upstream.on(/^\/v1\/analytics\/hero-stats$/, { body: ANALYTICS });
      const res = await request(app).get('/api/heroes/6/stats');
      expect(res.status).toBe(200);
      const { stats } = res.body;
      expect(stats).toMatchObject({
        heroId: 6,
        matches: 1150,
        winRate: 52.17,
        avgKills: 7.22,
        avgDeaths: 7.04,
        avgAssists: 12.17,
      });
      expect(stats.winRateByTier).toHaveLength(12);
      expect(stats.winRateByTier[0]).toEqual({ tier: 0, winRate: 52, matches: 1000 });
      expect(stats.winRateByTier[11]).toEqual({ tier: 11, winRate: null, matches: 150 });
      expect(stats.winRateByTier[5]).toEqual({ tier: 5, winRate: null, matches: null });
      expect(
        upstream.calls.find((u) => u.pathname.includes('analytics'))?.searchParams.get('bucket'),
      ).toBe('avg_badge');
    });

    it('héros jouable sans données → stats null', async () => {
      upstream.on(/analytics/, { body: [] });
      const res = await request(app).get('/api/heroes/72/stats');
      expect(res.body.stats).toMatchObject({
        heroId: 72,
        matches: null,
        winRate: null,
        pickRate: null,
      });
    });

    it('héros inconnu → 404 ; id invalide → 400', async () => {
      upstream.on(/analytics/, { body: [] });
      expect((await request(app).get('/api/heroes/999/stats')).status).toBe(404);
      expect((await request(app).get('/api/heroes/abc/stats')).status).toBe(400);
    });
  });

  describe('GET /api/matches/:matchId', () => {
    const player = (account: number, team: number, hero: number, netWorth: number) => ({
      account_id: account,
      team,
      hero_id: hero,
      kills: 5,
      deaths: 2,
      assists: 9,
      net_worth: netWorth,
      last_hits: 200,
      denies: 10,
      level: 30,
      items: [{ item_id: 1 }],
    });
    const METADATA = {
      match_info: {
        match_id: 138252082,
        start_time: 1794785573,
        duration_s: 2205,
        winning_team: 1,
        match_mode: 4,
        game_mode: 1,
        players: [
          player(10, 0, 6, 30000),
          player(11, 0, 72, 40000),
          player(12, 1, 6, 35000),
          player(0, 1, 72, 20000),
        ],
      },
    };

    it('équipes amber/sapphire, gagnant, joueurs triés par valeur nette, pseudos résolus en un appel', async () => {
      upstream
        .on(/^\/v1\/matches\/138252082\/metadata$/, { body: METADATA })
        .on(/^\/v1\/players\/steam$/, {
          body: [{ account_id: 11, personaname: 'Corvid', avatar: null }],
        });
      const res = await request(app).get('/api/matches/138252082');
      expect(res.status).toBe(200);
      const { match } = res.body;
      expect(match).toMatchObject({
        matchId: '138252082',
        playedAt: '2026-11-15T23:32:53.000Z',
        durationSeconds: 2205,
        matchMode: 'ranked',
        gameMode: 'normal',
        winningSide: 'sapphire',
      });
      expect(
        match.teams.map((t: { side: string; outcome: string }) => `${t.side}:${t.outcome}`),
      ).toEqual(['amber:loss', 'sapphire:win']);
      expect(match.teams[0].players[0]).toStrictEqual({
        steamId: '76561197960265739',
        displayName: 'Corvid',
        heroId: 72,
        heroName: 'Billy',
        heroImageUrl: `${ASSET}/72.webp`,
        level: 30,
        kills: 5,
        deaths: 2,
        assists: 9,
        netWorth: 40000,
        lastHits: 200,
        denies: 10,
        // Ajouts v1.10.0 : source sans MVP ni relevés, catalogue d'items absent → null.
        mvpRank: null,
        // (5 + 9) / 10 éliminations de l'équipe
        killParticipation: 140,
        stats: null,
        purchases: null,
        finalItemIds: null,
        abilityUpgrades: null,
        // Ajouts v1.12.0 : métriques calculées, champs bruts inchangés.
        kda: 7,
        netWorthRank: 1,
        teamNetWorthRank: 1,
        lastHitsPerMinute: 5.44,
        performanceTags: ['match_top_net_worth', 'match_best_kda'],
      });
      // Profil introuvable → SteamID ; compte inconnu (0) → steamId null.
      expect(match.teams[0].players[1].displayName).toBe('76561197960265738');
      expect(match.teams[1].players[1]).toMatchObject({
        steamId: null,
        displayName: 'Joueur inconnu',
      });
      const profileCall = upstream.calls.find((u) => u.pathname === '/v1/players/steam');
      expect(profileCall?.searchParams.get('account_ids')).toBe('10,11,12');
    });

    it('partie terminée mise en cache : un seul appel à la source', async () => {
      upstream.on(/metadata/, { body: METADATA }).on(/players\/steam/, { body: [] });
      await request(app).get('/api/matches/138252082');
      await request(app).get('/api/matches/138252082');
      expect(upstream.calls.filter((u) => u.pathname.includes('metadata'))).toHaveLength(1);
    });

    it('partie inconnue → 404 ; id non numérique → 400', async () => {
      upstream.on(/metadata/, { status: 404 });
      expect((await request(app).get('/api/matches/1')).status).toBe(404);
      expect((await request(app).get('/api/matches/12a')).status).toBe(400);
    });
  });

  describe('GET /api/players/:steamId/heroes', () => {
    const match = (id: number, hero: number, outcome: number, k: number, d: number, a: number) => ({
      match_id: id,
      hero_id: hero,
      start_time: 1_794_700_000 + id,
      match_duration_s: 1800,
      player_kills: k,
      player_deaths: d,
      player_assists: a,
      net_worth: 30000,
      player_match_outcome: outcome,
    });

    it('méta globale jointe en une lecture de cache, période 30 jours explicite', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [{ account_id: ACCOUNT_ID, personaname: 'soÿer' }] })
        .on(/match-history/, {
          body: [match(1, 72, 1, 10, 2, 10), match(2, 72, 2, 2, 5, 3), match(3, 72, 1, 8, 0, 4)],
        })
        .on(/^\/v1\/analytics\/hero-stats$/, {
          body: [{ hero_id: 72, bucket: 0, matches: 650, wins: 300 }],
        });
      const res = await request(app).get(`/api/players/${STEAM_ID}/heroes`);
      expect(res.body.items[0]).toMatchObject({
        heroId: 72,
        winRate: 66.67,
        globalMeta: { matches: 650, winRate: 46.15, pickRate: expect.any(Number) },
        // 66.67 − 46.15
        winRateVsMeta: 20.52,
      });
      // Sans période 30 jours en mode normal, la comparaison n'est pas directe.
      expect(res.body.metaContext).toMatchObject({
        period: '30d',
        gameMode: 'normal',
        matchMode: 'all',
        comparable: false,
        isStale: false,
      });
      await request(app).get(`/api/players/${STEAM_ID}/heroes`).query({ period: '30d' });
      const scoped = await request(app)
        .get(`/api/players/${STEAM_ID}/heroes`)
        .query({ period: '30d', gameMode: 'normal' });
      expect(scoped.body.metaContext.comparable).toBe(true);
      // Une seule lecture source pour tous les héros et toutes les requêtes.
      expect(upstream.calls.filter((u) => u.pathname.includes('analytics'))).toHaveLength(1);
    });

    it('regroupe les parties par héros, trié par nombre de parties', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [{ account_id: ACCOUNT_ID, personaname: 'soÿer' }] })
        .on(/match-history/, {
          body: [
            match(1, 72, 1, 10, 2, 10),
            match(2, 72, 2, 2, 5, 3),
            match(3, 72, 1, 8, 0, 4),
            match(4, 6, 1, 1, 1, 1),
          ],
        });
      const res = await request(app).get(`/api/players/${STEAM_ID}/heroes`);
      expect(res.status).toBe(200);
      expect(res.body.items).toStrictEqual([
        {
          heroId: 72,
          heroName: 'Billy',
          heroImageUrl: `${ASSET}/72.webp`,
          matches: 3,
          wins: 2,
          // Ajouts v1.9.0 (valeurs v1.8 inchangées).
          losses: 1,
          winRate: 66.67,
          kda: 5.29,
          kdaSampleSize: 3,
          avgNetWorthPerMinute: 1000,
          netWorthPerMinuteSampleSize: 3,
          // Ajouts v1.12.0 : méta globale indisponible ici (source non simulée) → null.
          globalMeta: null,
          winRateVsMeta: null,
        },
        {
          heroId: 6,
          heroName: 'Abrams',
          heroImageUrl: `${ASSET}/6.webp`,
          matches: 1,
          wins: 1,
          losses: 0,
          winRate: 100,
          kda: 2,
          kdaSampleSize: 1,
          avgNetWorthPerMinute: 1000,
          netWorthPerMinuteSampleSize: 1,
          globalMeta: null,
          winRateVsMeta: null,
        },
      ]);
    });

    it('joueur introuvable → 404 ; steamId invalide → 400', async () => {
      upstream.on(/^\/v1\/players\/steam$/, { body: [] }).on(/match-history/, { body: [] });
      expect((await request(app).get(`/api/players/${STEAM_ID}/heroes`)).status).toBe(404);
      expect((await request(app).get('/api/players/123/heroes')).status).toBe(400);
    });
  });
});

describe('computeHeroMetaStats', () => {
  it('taux de sélection = parties du héros / parties totales (12 héros par partie)', () => {
    // 100 parties : 12 participations chacune → 1200 lignes-participations.
    // Le héros 1 est présent dans 50 parties, les 1150 autres participations sont réparties.
    const rows = [
      { hero_id: 1, bucket: 0, matches: 50, wins: 25 },
      ...Array.from({ length: 23 }, (_, i) => ({
        hero_id: i + 2,
        bucket: 0,
        matches: 50,
        wins: 25,
      })),
    ];
    const stats = computeHeroMetaStats(rows);
    expect(stats['1']?.pickRate).toBe(50);
    expect(stats['1']?.winRate).toBe(50);
    expect(stats['1']?.avgKills).toBe(0);
  });

  it(`palier au seuil de ${MIN_TIER_SAMPLE} parties → winRate calculé`, () => {
    const stats = computeHeroMetaStats([
      { hero_id: 1, bucket: 41, matches: MIN_TIER_SAMPLE, wins: 100 },
    ]);
    expect(stats['1']?.winRateByTier[4]).toEqual({
      tier: 4,
      winRate: 50,
      matches: MIN_TIER_SAMPLE,
    });
  });
});
