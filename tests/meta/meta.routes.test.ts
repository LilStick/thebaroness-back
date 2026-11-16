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

    it('région par défaut Europe ; steamId seulement si univoque ; badge null ; 3 héros max', async () => {
      upstream.on(/^\/v1\/leaderboard\/Europe$/, { body: ENTRIES });
      const res = await request(app).get('/api/leaderboard');
      expect(res.status).toBe(200);
      expect(res.body.region).toBe('Europe');
      expect(res.body.items).toStrictEqual([
        {
          rank: 1,
          displayName: 'MikaelS',
          steamId: null,
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
          badge: null,
          topHeroes: [expect.objectContaining({ heroId: 72 })],
        },
        { rank: 3, displayName: '', steamId: null, badge: null, topHeroes: [] },
      ]);
      expect(res.body.meta).toMatchObject({ isStale: false, isPartial: false });
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
          winRate: 66.67,
          kda: 5.29,
        },
        {
          heroId: 6,
          heroName: 'Abrams',
          heroImageUrl: `${ASSET}/6.webp`,
          matches: 1,
          wins: 1,
          winRate: 100,
          kda: 2,
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
