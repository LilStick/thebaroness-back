import request from 'supertest';
import { ApiCacheModel } from '../../src/database/api-cache';
import {
  activityDays,
  activityWindow,
  rankPoints,
  trends,
} from '../../src/modules/players/profile-stats';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const STEAM_ID = '76561198957316510';
const ACCOUNT_ID = 997050782;
const PROFILE = { account_id: ACCOUNT_ID, personaname: 'Corvid', avatarfull: null };
const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const RANKS = [
  {
    tier: 10,
    name: 'Phantom',
    color: '#aaa',
    images: {
      large_webp: 'https://r.test/10.webp',
      large_subrank4_webp: 'https://r.test/10-4.webp',
    },
  },
];

const raw = (id: number, daysAgo: number, extra: Record<string, unknown> = {}) => ({
  match_id: id,
  hero_id: 1,
  start_time: NOW_S - Math.round(daysAgo * DAY),
  player_kills: 1,
  player_deaths: 1,
  player_assists: 1,
  player_match_outcome: 1,
  match_mode: 1,
  game_mode: 1,
  ...extra,
});

describe('Profil P1 : rang, activité, coéquipiers', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  const base = (history: unknown[]) =>
    upstream
      .on(/^\/v1\/players\/steam$/, (url) => ({
        body: (url.searchParams.get('account_ids') ?? '')
          .split(',')
          .map(Number)
          .map((id) =>
            id === ACCOUNT_ID
              ? PROFILE
              : { account_id: id, personaname: `P${id}`, avatarfull: null },
          ),
      }))
      .on(/match-history$/, { body: history })
      .on(/^\/v1\/assets\/ranks$/, { body: RANKS })
      .on(/^\/v1\/assets\/ranked-seasons$/, {
        body: [{ intervals: [{ start_timestamp: NOW_S - 20 * DAY, end_timestamp: null }] }],
      });

  beforeEach(() => {
    upstream = createFetchMock();
    app = buildTestApp({}, upstream.fetch);
  });

  const get = (path: string, query: object = {}) =>
    request(app).get(`/api/players/${STEAM_ID}${path}`).query(query);

  describe('GET /rank-history', () => {
    it('saison par défaut : points des parties classées au badge connu, chronologiques', async () => {
      base([
        raw(5, 1, { match_mode: 4, ranked_display_badge: 104 }),
        raw(4, 2, { match_mode: 4, ranked_display_badge: null, player_match_outcome: 2 }),
        raw(3, 3, { match_mode: 4, ranked_display_badge: 103, player_match_outcome: 2 }),
        raw(2, 4, { match_mode: 1 }),
        raw(1, 30, { match_mode: 4, ranked_display_badge: 102 }),
      ]);
      const res = await get('/rank-history');
      expect(res.status).toBe(200);
      expect(res.body.period).toBe('season');
      expect(res.body.points).toEqual([
        {
          at: new Date((NOW_S - 3 * DAY) * 1000).toISOString(),
          matchId: '3',
          badge: 103,
          tier: 10,
          subrank: 3,
          score: 63,
          name: 'Phantom 3',
          // Pas d'image propre au sous-rang 3 : image du palier (même règle que le profil).
          imageUrl: 'https://r.test/10.webp',
          outcome: 'loss',
          // v1.15.0 : saison classée de la source.
          season: 1,
        },
        expect.objectContaining({
          matchId: '5',
          score: 64,
          name: 'Phantom 4',
          imageUrl: 'https://r.test/10-4.webp',
        }),
      ]);
      expect(res.body.coverage).toMatchObject({
        rankedMatches: 3,
        pointCount: 2,
        missingBadge: 1,
        isPartial: false,
        notes: ['badge_missing_on_some_ranked_matches'],
      });
      expect(res.body.meta.isPartial).toBe(false);
    });

    it('joueur jamais classé → points vides ; catalogue des rangs absent → noms null et isPartial', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
        .on(/match-history$/, { body: [raw(1, 1, { match_mode: 4, ranked_display_badge: 104 })] })
        .on(/^\/v1\/assets\//, { status: 503 });
      const res = await get('/rank-history', { period: '7d' });
      expect(res.body.points[0]).toMatchObject({
        badge: 104,
        tier: 10,
        subrank: 4,
        score: 64,
        name: null,
      });
      expect(res.body.meta.isPartial).toBe(true);

      await ApiCacheModel.deleteMany({});
      upstream.reset();
      base([raw(1, 1)]);
      const none = await get('/rank-history', { period: '30d' });
      expect(none.body.points).toEqual([]);
      expect(none.body.coverage).toMatchObject({ rankedMatches: 0, pointCount: 0, notes: [] });
    });

    it('saison inconnue → tout l’historique et isPartial ; période invalide → 400', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
        .on(/match-history$/, { body: [raw(1, 300, { match_mode: 4, ranked_display_badge: 104 })] })
        .on(/^\/v1\/assets\/ranks$/, { body: RANKS })
        .on(/^\/v1\/assets\/ranked-seasons$/, { body: [] });
      const res = await get('/rank-history');
      expect(res.body.points).toHaveLength(1);
      expect(res.body.coverage).toMatchObject({ requestedFrom: null, isPartial: true });
      expect(res.body.coverage.notes).toContain('season_start_unknown');
      expect((await get('/rank-history', { period: 'all' })).status).toBe(400);
    });
  });

  it('rank-history : source des saisons en panne → saison inconnue, isPartial', async () => {
    upstream
      .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
      .on(/match-history$/, { body: [raw(1, 1, { match_mode: 4, ranked_display_badge: 104 })] })
      .on(/^\/v1\/assets\/ranks$/, { body: RANKS })
      .on(/^\/v1\/assets\/ranked-seasons$/, { status: 503 });
    const res = await get('/rank-history');
    expect(res.status).toBe(200);
    expect(res.body.coverage.notes).toContain('season_start_unknown');
    expect(res.body.meta.isPartial).toBe(true);
  });

  describe('GET /activity', () => {
    it('12 semaines par défaut : un jour UTC par case, jours vides à 0, résumé', async () => {
      base([raw(3, 0), raw(2, 0, { player_match_outcome: 2 }), raw(1, 3), raw(9, 200)]);
      const res = await get('/activity');
      expect(res.status).toBe(200);
      expect(res.body.days).toHaveLength(84);
      expect(res.body.days.at(-1)).toMatchObject({ matches: 2, wins: 1, losses: 1 });
      expect(res.body.summary).toEqual({ matches: 3, wins: 2, losses: 1, activeDays: 2 });
      expect(res.body.coverage).toMatchObject({
        timezone: 'UTC',
        excludedUnknownMode: 0,
        notes: [],
      });
      expect(res.body.coverage.to).toBe(new Date(NOW_S * 1000).toISOString().slice(0, 10));
    });

    it('filtres de mode et nombre de semaines ; bornes invalides → 400', async () => {
      base([
        raw(2, 0, { match_mode: 4 }),
        raw(1, 0, { game_mode: 4 }),
        raw(3, 0, { game_mode: null }),
      ]);
      const res = await get('/activity', { weeks: 1, matchMode: 'ranked' });
      expect(res.body.days).toHaveLength(7);
      expect(res.body.summary.matches).toBe(1);
      expect(res.body.filters).toEqual({ gameMode: 'all', matchMode: 'ranked' });
      expect(
        (await get('/activity', { gameMode: 'normal' })).body.coverage.excludedUnknownMode,
      ).toBe(1);
      for (const weeks of [0, 53, 'x'])
        expect((await get('/activity', { weeks })).status).toBe(400);
    });
  });

  describe('GET /relationships', () => {
    const relations = (mates: object[], enemies: object[]) =>
      upstream.on(/mate-stats$/, { body: mates }).on(/enemy-stats$/, { body: enemies });

    it('coéquipiers et adversaires triés, pseudos en un appel, victoires du joueur', async () => {
      base([]);
      relations(
        [
          { mate_id: 11, wins: 3, matches_played: 4, matches: [1, 2, 3, 4] },
          { mate_id: 12, wins: 5, matches_played: 9 },
          { mate_id: null, wins: 1, matches_played: 1 },
        ],
        [{ enemy_id: 21, wins: 0, matches_played: 2 }],
      );
      const res = await get('/relationships');
      expect(res.status).toBe(200);
      expect(res.body.appliedFilters).toEqual({
        period: null,
        gameMode: 'normal',
        sameParty: false,
        minMatches: 2,
        limit: 10,
      });
      expect(res.body.teammates).toEqual([
        {
          steamId: '76561197960265740',
          displayName: 'P12',
          avatarUrl: null,
          matches: 9,
          wins: 5,
          losses: 4,
          winRate: 55.56,
        },
        expect.objectContaining({ displayName: 'P11', matches: 4, winRate: 75 }),
      ]);
      expect(res.body.opponents).toEqual([
        expect.objectContaining({ displayName: 'P21', matches: 2, wins: 0, losses: 2, winRate: 0 }),
      ]);
      expect(res.body.meta.isPartial).toBe(false);
      const mateCall = upstream.calls.find((u) => u.pathname.endsWith('mate-stats'));
      expect(mateCall?.searchParams.get('game_mode')).toBe('normal');
      expect(mateCall?.searchParams.get('min_matches_played')).toBe('2');
      expect(mateCall?.searchParams.has('min_unix_timestamp')).toBe(false);
      // Profils des 3 joueurs en un seul appel (hors profil du joueur demandé).
      const profileCalls = upstream.calls.filter((u) => u.pathname === '/v1/players/steam');
      expect(profileCalls.some((u) => u.searchParams.get('account_ids') === '11,12,21')).toBe(true);
    });

    it('période, Street Brawl, même groupe et limite transmis ; cache partagé', async () => {
      base([]);
      relations([{ mate_id: 11, wins: 1, matches_played: 2 }], []);
      const query = {
        period: '7d',
        gameMode: 'street_brawl',
        sameParty: 'true',
        minMatches: 3,
        limit: 1,
      };
      const res = await get('/relationships', query);
      await get('/relationships', query);
      const mateCalls = upstream.calls.filter((u) => u.pathname.endsWith('mate-stats'));
      expect(mateCalls).toHaveLength(1);
      expect(mateCalls[0]?.searchParams.get('same_party')).toBe('true');
      expect(mateCalls[0]?.searchParams.get('game_mode')).toBe('street_brawl');
      const enemyCall = upstream.calls.find((u) => u.pathname.endsWith('enemy-stats'));
      expect(enemyCall?.searchParams.has('same_party')).toBe(false);
      const from = Number(mateCalls[0]?.searchParams.get('min_unix_timestamp'));
      expect(from % 600).toBe(0);
      expect(NOW_S - 7 * DAY - from).toBeLessThan(600);
      expect(res.body.coverage.requestedFrom).toBe(new Date(from * 1000).toISOString());
    });

    it('une source en panne → liste null et isPartial ; les deux → 503', async () => {
      base([]);
      upstream.on(/mate-stats$/, { status: 500 }).on(/enemy-stats$/, { body: [] });
      const res = await get('/relationships');
      expect(res.body).toMatchObject({ teammates: null, opponents: [] });
      expect(res.body.meta.isPartial).toBe(true);
      const entry = await ApiCacheModel.findOne({ key: /^relations:/ }).lean();
      expect(entry && entry.expiresAt.getTime() - entry.fetchedAt.getTime()).toBe(60_000);

      await ApiCacheModel.deleteMany({});
      upstream.reset();
      base([]);
      upstream.on(/(mate|enemy)-stats$/, { status: 503 });
      expect((await get('/relationships')).status).toBe(503);
    });

    it('pseudos indisponibles → repli sur le SteamID ; saison inconnue signalée', async () => {
      upstream
        .on(/^\/v1\/players\/steam$/, (url) =>
          url.searchParams.get('account_ids') === String(ACCOUNT_ID)
            ? { body: [PROFILE] }
            : { status: 500 },
        )
        .on(/^\/v1\/assets\/ranked-seasons$/, { status: 503 });
      relations([{ mate_id: 11, wins: 1, matches_played: 2 }], []);
      const res = await get('/relationships', { period: 'season' });
      expect(res.body.teammates[0]).toMatchObject({
        displayName: '76561197960265739',
        avatarUrl: null,
      });
      expect(res.body.coverage.notes).toEqual(['season_start_unknown']);
      expect(res.body.meta.isPartial).toBe(true);
    });

    it.each([[{ gameMode: 'all' }], [{ limit: 0 }], [{ minMatches: 51 }], [{ sameParty: 'yes' }]])(
      '%p → 400',
      async (query) => {
        expect((await get('/relationships', query)).status).toBe(400);
      },
    );
  });
});

describe('Fonctions pures P1', () => {
  it('rankPoints : parties classées, badge connu, ordre chronologique puis matchId', () => {
    const m = (matchId: string, startTime: number, extra: object) => ({
      matchId,
      heroId: 1,
      startTime,
      win: true,
      duration: null,
      kills: null,
      deaths: null,
      assists: null,
      netWorth: null,
      ...extra,
    });
    const result = rankPoints([
      m('10', 5, { matchMode: 'ranked', badge: 104 }),
      m('9', 5, { matchMode: 'ranked', badge: 103 }),
      m('8', 4, { matchMode: 'ranked', badge: null }),
      // Badge connu mais type inconnu (copie ancienne) : compté comme partie classée.
      m('7', 3, { badge: 102 }),
      m('6', 2, { matchMode: 'unranked' }),
    ]);
    expect(result.points.map((p) => p.matchId)).toEqual(['7', '9', '10']);
    expect(result).toMatchObject({ rankedMatches: 4, missingBadge: 1 });
  });

  it('activityWindow / activityDays : minuit UTC, première case = début de fenêtre', () => {
    const now = Date.UTC(2026, 10, 17, 15, 30);
    const window = activityWindow(1, now);
    expect(new Date((window.from ?? 0) * 1000).toISOString()).toBe('2026-11-11T00:00:00.000Z');
    const days = activityDays(
      [
        {
          matchId: '1',
          heroId: 1,
          startTime: Date.UTC(2026, 10, 11, 0, 0) / 1000,
          win: true,
          duration: null,
          kills: null,
          deaths: null,
          assists: null,
          netWorth: null,
        },
        {
          matchId: '2',
          heroId: 1,
          startTime: Date.UTC(2026, 10, 1) / 1000,
          win: true,
          duration: null,
          kills: null,
          deaths: null,
          assists: null,
          netWorth: null,
        },
      ],
      window,
    );
    expect(days.map((d) => d.date)).toEqual([
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
    ]);
    expect(days[0]).toEqual({ date: '2026-11-11', matches: 1, wins: 1, losses: 0 });
  });
});

describe('Tendances (trends)', () => {
  const m = (i: number, win: boolean, kills = 2) => ({
    matchId: String(100 - i),
    heroId: 1,
    startTime: 1_000_000 - i * 100,
    win,
    duration: 1200,
    kills,
    deaths: 1,
    assists: 0,
    netWorth: 20000,
  });

  it('blocs égaux, deltas et winrate glissant défini à partir de la 10e partie', () => {
    // 10 récentes : 8 victoires ; 10 précédentes : 5 victoires.
    const recent = Array.from({ length: 10 }, (_, i) => m(i, i < 8, 4));
    const previous = Array.from({ length: 10 }, (_, i) => m(10 + i, i < 5, 2));
    const result = trends([...recent, ...previous], 10);
    expect(result.recent).toMatchObject({ matches: 10, winRate: 80, kda: 4 });
    expect(result.previous).toMatchObject({ matches: 10, winRate: 50, kda: 2 });
    expect(result.delta).toEqual({ winRate: 30, kda: 2, avgNetWorthPerMinute: 0 });
    expect(result.rolling).toHaveLength(11);
    // Première valeur : les 10 plus anciennes (bloc précédent).
    expect(result.rolling[0]).toMatchObject({ matchId: String(100 - 10), winRate: 50 });
    expect(result.rolling.at(-1)).toMatchObject({ matchId: '100', winRate: 80 });
    expect(result.complete).toBe(true);
  });

  it('série par partie : KDA, souls/min, glissant sur 10 parties y compris hors bloc', () => {
    const list = Array.from({ length: 12 }, (_, i) => m(i, i < 6, 3));
    list[1] = { ...list[1]!, deaths: null as unknown as number };
    list[2] = { ...list[2]!, duration: 0 };
    const { series } = trends(list, 5);
    expect(series.map((p) => p.matchId)).toEqual(['96', '97', '98', '99', '100']);
    const latest = series.at(-1)!;
    expect(latest).toMatchObject({
      kda: 3,
      netWorthPerMinute: 1000,
      // 100..91 : 6 victoires sur 10.
      rollingWinRate: 60,
      rollingSampleSize: 10,
    });
    // Valeur inconnue → null, jamais 0.
    expect(series.find((p) => p.matchId === '99')?.kda).toBeNull();
    expect(series.find((p) => p.matchId === '98')?.netWorthPerMinute).toBeNull();
    // 96 : seulement 8 parties jusqu'à la plus ancienne (96..89) → glissant null.
    expect(series[0]).toMatchObject({ rollingWinRate: null, rollingSampleSize: 8 });
  });

  it('historique insuffisant → previous null, deltas null, glissant vide sous 10 parties', () => {
    const result = trends(
      Array.from({ length: 7 }, (_, i) => m(i, true)),
      5,
    );
    expect(result.previous).toBeNull();
    expect(result.delta).toEqual({ winRate: null, kda: null, avgNetWorthPerMinute: null });
    expect(result.rolling).toEqual([]);
    expect(result.complete).toBe(false);
  });
});

describe('GET /players/:steamId/trends', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    upstream = createFetchMock();
    app = buildTestApp({}, upstream.fetch);
  });

  it('20 contre 20 par défaut, filtres de mode, couverture', async () => {
    const history = Array.from({ length: 45 }, (_, i) =>
      raw(1000 - i, i / 10, { player_match_outcome: i % 2 ? 2 : 1, match_mode: i < 40 ? 4 : 1 }),
    );
    upstream
      .on(/^\/v1\/players\/steam$/, { body: [PROFILE] })
      .on(/match-history$/, { body: history });
    let res = await request(app).get(`/api/players/${STEAM_ID}/trends`);
    expect(res.status).toBe(200);
    expect(res.body.filters).toEqual({
      size: 20,
      period: null,
      gameMode: 'all',
      matchMode: 'all',
    });
    expect(res.body.recent.matches).toBe(20);
    expect(res.body.previous.matches).toBe(20);
    expect(res.body.rolling).toHaveLength(31);
    expect(res.body.coverage).toEqual({
      eligibleMatches: 45,
      rollingWindow: 10,
      seriesMatches: 20,
      seriesFrom: res.body.series[0].at,
      seriesTo: res.body.series[19].at,
      // 45 parties : chaque point des 20 récentes a ses 9 précédentes.
      rollingPointsComplete: 20,
      notes: [],
    });
    // Série chronologique (plus ancienne → plus récente) du bloc récent.
    expect(res.body.series).toHaveLength(20);
    expect(res.body.series.at(-1)).toMatchObject({
      matchId: '1000',
      win: true,
      kda: 2,
      matchMode: 'ranked',
      gameMode: 'normal',
      rollingSampleSize: 10,
      // 1000..991 : alternance victoire/défaite → 50 %.
      rollingWinRate: 50,
    });

    res = await request(app)
      .get(`/api/players/${STEAM_ID}/trends`)
      .query({ size: 25, matchMode: 'ranked' });
    expect(res.body.previous).toBeNull();
    expect(res.body.coverage).toMatchObject({
      eligibleMatches: 40,
      notes: ['insufficient_history'],
    });
    for (const size of [4, 51]) {
      expect(
        (await request(app).get(`/api/players/${STEAM_ID}/trends`).query({ size })).status,
      ).toBe(400);
    }
  });
});
