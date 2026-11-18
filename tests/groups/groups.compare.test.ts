import { ApiCacheModel } from '../../src/database/api-cache';
import request from 'supertest';
import { bestMatchOf, longestWinStreak } from '../../src/modules/groups/group.compare';
import { accountIdToSteamId } from '../../src/shared/schemas';
import { buildTestApp, createUser } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const A = 1001;
const B = 1002;
const C = 1003;

/** Partie brute de l'historique, `daysAgo` jours avant maintenant. */
const match = (
  id: number,
  daysAgo: number,
  outcome: 1 | 2,
  [k, d, a]: [number, number, number],
  badge: number | null = null,
  hero = 6,
) => ({
  match_id: id,
  hero_id: hero,
  start_time: NOW_S - daysAgo * DAY,
  match_duration_s: 1800,
  player_kills: k,
  player_deaths: d,
  player_assists: a,
  net_worth: 30000 + id,
  player_match_outcome: outcome,
  ranked_display_badge: badge,
});

const HISTORIES: Record<number, unknown[]> = {
  [A]: [
    match(1, 1, 1, [10, 2, 10], 92),
    match(2, 2, 1, [5, 5, 5], 91),
    match(3, 3, 2, [1, 8, 2], 91),
    match(4, 4, 1, [3, 1, 3], null),
    match(5, 5, 1, [4, 2, 4], 86),
    match(6, 6, 1, [2, 2, 2], 86),
    // Hors 7 jours, dans 30 jours.
    match(7, 20, 2, [0, 10, 0], 85),
    // Hors 30 jours, dans la saison.
    match(8, 40, 1, [20, 0, 10], 84),
  ],
  [B]: [],
};

const PROFILES = [A, B].map((id) => ({
  account_id: id,
  personaname: `Joueur ${id}`,
  avatarfull: id === A ? 'https://avatars.test/a.jpg' : '',
}));

const RANKS = [
  { tier: 8, name: 'Oracle', color: '#955138', images: { large_webp: 'https://r.test/8.webp' } },
  {
    tier: 9,
    name: 'Augure',
    color: '#7C7C7C',
    images: { large_webp: 'https://r.test/9.webp', large_subrank2_webp: 'https://r.test/9-2.webp' },
  },
];

const HEROES = [
  {
    id: 6,
    name: 'Abrams',
    images: { icon_image_small_webp: 'https://h.test/6.webp' },
    player_selectable: true,
    development_state: 'release',
  },
];

describe('GET /api/groups/:id/compare', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;
  let owner: Awaited<ReturnType<typeof createUser>>;
  let groupId: string;

  const compare = (query: object = {}, id = groupId, auth = owner.auth) =>
    request(app).get(`/api/groups/${id}/compare`).query(query).set(auth);

  beforeEach(async () => {
    upstream = createFetchMock()
      .on(/^\/v1\/players\/steam$/, (url) => ({
        body: PROFILES.filter((p) => url.searchParams.get('account_ids') === String(p.account_id)),
      }))
      .on(/^\/v1\/players\/(\d+)\/match-history$/, (url) => ({
        body: HISTORIES[Number(url.pathname.split('/')[3])] ?? [],
      }))
      .on(/^\/v1\/assets\/ranks$/, { body: RANKS })
      .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] })
      .on(/^\/v1\/assets\/ranked-seasons$/, {
        body: [
          { intervals: [{ start_timestamp: NOW_S - 400 * DAY, end_timestamp: NOW_S - 60 * DAY }] },
          { intervals: [{ start_timestamp: NOW_S - 60 * DAY, end_timestamp: NOW_S + 60 * DAY }] },
        ],
      });
    app = buildTestApp({}, upstream.fetch);
    owner = await createUser();
    const res = await request(app)
      .post('/api/groups')
      .set(owner.auth)
      .send({ name: 'Duo', steamIds: [accountIdToSteamId(A), accountIdToSteamId(B)] });
    groupId = res.body.id;
  });

  describe('POST /api/groups/:id/refresh', () => {
    const refresh = (query: object = {}, id = groupId, auth = owner.auth) =>
      request(app).post(`/api/groups/${id}/refresh`).query(query).set(auth);
    const historyCalls = () =>
      upstream.calls.filter((url) => url.pathname.endsWith('match-history')).length;

    it('relit chaque membre dont la copie a plus de 60 s, même réponse que compare', async () => {
      const before = await compare({ period: '7d' });
      expect(historyCalls()).toBe(2);
      await ApiCacheModel.updateMany(
        {},
        [{ $set: { fetchedAt: { $subtract: ['$fetchedAt', 61_000] } } }],
        { updatePipeline: true },
      );
      const res = await refresh({ period: '7d' });
      expect(res.status).toBe(200);
      expect(historyCalls()).toBe(4);
      expect(res.body.members).toStrictEqual(before.body.members);
      expect(res.body.period).toBe('7d');
    });

    it('moins de 60 s → aucun appel au fournisseur', async () => {
      await compare();
      await refresh();
      expect(historyCalls()).toBe(2);
    });

    it('sans JWT → 401 ; groupe d’un autre compte → 404 ; période invalide → 400', async () => {
      expect((await request(app).post(`/api/groups/${groupId}/refresh`)).status).toBe(401);
      expect((await refresh({}, groupId, (await createUser()).auth)).status).toBe(404);
      expect((await refresh({ period: '1y' })).status).toBe(400);
      expect((await refresh({}, 'abc')).status).toBe(400);
    });
  });

  it('30 jours par défaut : stats, série, meilleure partie, rang et historique de rang', async () => {
    const res = await compare();
    expect(res.status).toBe(200);
    expect(res.body.period).toBe('30d');
    expect(res.body.group).toMatchObject({ id: groupId, name: 'Duo' });
    expect(res.body.meta).toMatchObject({ isStale: false, isPartial: false });

    const [a, b] = res.body.members;
    expect(a).toStrictEqual({
      steamId: accountIdToSteamId(A),
      displayName: `Joueur ${A}`,
      avatarUrl: 'https://avatars.test/a.jpg',
      rank: {
        badgeId: 92,
        name: 'Augure 2',
        tier: 9,
        subrank: 2,
        imageUrl: 'https://r.test/9-2.webp',
        color: '#7C7C7C',
      },
      matches: 7,
      wins: 5,
      losses: 2,
      winRate: 71.43,
      // (25 + 26) / 30
      kda: 1.7,
      // Chronologique : L(20j) W W L W W W → 3
      longestWinStreak: 3,
      bestMatch: {
        matchId: '1',
        playedAt: new Date((NOW_S - DAY) * 1000).toISOString(),
        heroName: 'Abrams',
        heroImageUrl: 'https://h.test/6.webp',
        kills: 10,
        deaths: 2,
        assists: 10,
        netWorth: 30001,
        kda: 10,
      },
      rankHistory: [85, 86, 86, 91, 91, 92].map((badge) => ({
        at: expect.any(String),
        score: Math.floor(badge / 10) * 6 + (badge % 10),
        badge,
        // v1.15.0 : saison classée de la source (2e intervalle, le seul dans la fenêtre simulée).
        season: 2,
      })),
      // Ajouts v1.12.0 : score actuel (92 → 9*6+2), progression 92 − 85 en score, échantillon.
      currentRankScore: 56,
      rankDelta: 3,
      kdaSampleSize: 7,
      // Ajouts v1.15.0 : filtres « all », fenêtre précédente de 30 jours (1 partie : écarts
      // de ratio null sous 5 parties de chaque côté).
      excludedUnknownModeMatches: 0,
      previous: {
        from: expect.any(String),
        to: expect.any(String),
        matches: 1,
        wins: 1,
        winRate: 100,
        kda: 30,
        kdaSampleSize: 1,
      },
      deltaVsPrevious: { matches: 6, winRate: null, kda: null },
    });
    // Ordre chronologique.
    const times = a.rankHistory.map((p: { at: string }) => Date.parse(p.at));
    expect([...times].sort((x, y) => x - y)).toEqual(times);

    expect(b).toMatchObject({
      matches: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      kda: null,
      longestWinStreak: 0,
      bestMatch: null,
      rank: null,
      rankHistory: [],
      avatarUrl: null,
      currentRankScore: null,
      rankDelta: null,
      kdaSampleSize: 0,
      previous: { matches: 0, winRate: null, kda: null },
      deltaVsPrevious: { matches: 0, winRate: null, kda: null },
    });
    // v1.15.0 : filtres appliqués, aucun membre indisponible, pas de paires sans `include`.
    expect(res.body.appliedFilters).toEqual({ period: '30d', gameMode: 'all', matchMode: 'all' });
    expect(res.body.unavailable).toEqual([]);
    expect(res.body).not.toHaveProperty('pairs');
    // Highlights calculés par le back : forme stable, un membre sans parties n'est jamais primé.
    const highlights = Object.fromEntries(
      res.body.highlights.map((h: { key: string }) => [h.key, h]),
    );
    expect(Object.keys(highlights)).toEqual([
      'biggest_climb',
      'best_win_rate',
      'most_wins',
      'best_kda',
      'longest_win_streak',
      'best_match',
    ]);
    expect(highlights.biggest_climb).toMatchObject({ steamIds: [a.steamId], value: 3 });
    expect(highlights.best_win_rate).toMatchObject({
      steamIds: [a.steamId],
      eligibleMembers: 1,
      minMatches: 5,
    });
    expect(highlights.best_match).toMatchObject({ steamIds: [a.steamId], matchId: '1', value: 10 });
    expect(res.body.methodology).toMatchObject({ highlightMinMatches: 5 });
  });

  it('7 jours : parties plus anciennes exclues', async () => {
    const res = await compare({ period: '7d' });
    expect(res.body.members[0]).toMatchObject({ matches: 6, wins: 5, longestWinStreak: 3 });
  });

  it('saison : depuis le début de la saison courante (40 jours inclus)', async () => {
    const res = await compare({ period: 'season' });
    expect(res.body.members[0]).toMatchObject({ matches: 8, wins: 6 });
    expect(res.body.members[0].bestMatch.matchId).toBe('8');
  });

  it('saison inconnue → toutes les parties disponibles', async () => {
    upstream.reset();
    upstream
      .on(/^\/v1\/players\/steam$/, (url) => ({
        body: PROFILES.filter((p) => url.searchParams.get('account_ids') === String(p.account_id)),
      }))
      .on(/match-history/, (url) => ({ body: HISTORIES[Number(url.pathname.split('/')[3])] ?? [] }))
      .on(/ranks|heroes|ability/, { body: [] })
      .on(/ranked-seasons/, { status: 503 });
    const res = await compare({ period: 'season' });
    expect(res.status).toBe(200);
    expect(res.body.members[0].matches).toBe(8);
  });

  it('membre introuvable → omis et isPartial', async () => {
    const created = await request(app)
      .post('/api/groups')
      .set(owner.auth)
      .send({ name: 'Trio', steamIds: [accountIdToSteamId(A), accountIdToSteamId(C)] });
    const res = await compare({}, created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { steamId: string }) => m.steamId)).toEqual([
      accountIdToSteamId(A),
    ]);
    expect(res.body.meta.isPartial).toBe(true);
  });

  it('tous les membres indisponibles → 503 SERVICE_UNAVAILABLE', async () => {
    upstream.reset();
    upstream.on(/.*/, { status: 503 });
    const res = await compare();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('période invalide → 400 ; id malformé → 400 ; groupe d’un autre compte → 404 ; sans JWT → 401', async () => {
    expect((await compare({ period: '1y' })).status).toBe(400);
    expect((await compare({}, 'pas-un-id')).status).toBe(400);
    const intruder = await createUser();
    const foreign = await compare({}, groupId, intruder.auth);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get(`/api/groups/${groupId}/compare`)).status).toBe(401);
  });

  it('historiques mis en cache : second appel sans requête de match-history', async () => {
    await compare();
    const before = upstream.calls.filter((u) => u.pathname.endsWith('match-history')).length;
    await compare({ period: '7d' });
    expect(upstream.calls.filter((u) => u.pathname.endsWith('match-history'))).toHaveLength(before);
  });
});

describe('Calculs de comparaison', () => {
  const stored = (
    win: boolean,
    k: number | null = 1,
    d: number | null = 1,
    a: number | null = 1,
  ) => ({
    matchId: String(Math.random()).slice(2, 8),
    heroId: 1,
    startTime: 1,
    win,
    duration: null,
    kills: k,
    deaths: d,
    assists: a,
    netWorth: null,
    badge: null,
  });

  it('longestWinStreak', () => {
    expect(longestWinStreak([])).toBe(0);
    expect(longestWinStreak([stored(false), stored(false)])).toBe(0);
    expect(longestWinStreak([stored(true), stored(true), stored(false), stored(true)])).toBe(2);
  });

  it('bestMatchOf ignore les parties incomplètes et utilise max(D, 1)', () => {
    expect(bestMatchOf([stored(true, null, 1, 1)], {})).toBeNull();
    const best = bestMatchOf([stored(true, 2, 0, 3), stored(true, 10, 5, 0)], {});
    expect(best).toMatchObject({ kills: 2, deaths: 0, assists: 3, kda: 5, heroName: 'Héros #1' });
  });
});
