import request from 'supertest';
import { ApiCacheModel } from '../../src/database/api-cache';
import {
  groupPairs,
  unavailableReason,
  type GroupPair,
} from '../../src/modules/groups/group.compare';
import { seasonAt, seasonRankDelta } from '../../src/modules/catalog/ranks';
import type { StoredMatch } from '../../src/modules/players/players.service';
import { AppError } from '../../src/shared/errors';
import { accountIdToSteamId } from '../../src/shared/schemas';
import { buildTestApp, createUser } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

// Fixtures synthétiques (aucune donnée réelle).
const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const [A, B, C, D] = [2001, 2002, 2003, 2004];
const SEASON_SWITCH = NOW_S - 10 * DAY;

const raw = (id: number, daysAgo: number, outcome: 1 | 2, extra: Record<string, unknown> = {}) => ({
  match_id: id,
  hero_id: 6,
  start_time: NOW_S - daysAgo * DAY,
  match_duration_s: 1800,
  player_kills: 5,
  player_deaths: 2,
  player_assists: 5,
  net_worth: 30000,
  player_match_outcome: outcome,
  match_mode: 1,
  game_mode: 1,
  ...extra,
});

const ranked = { match_mode: 4 };
const brawl = { game_mode: 4 };

const HISTORIES: Record<number, unknown[]> = {
  [A]: [
    // Saison 2 (après la bascule) : 101 → 103.
    raw(1, 1, 1, { ...ranked, ranked_display_badge: 103 }),
    raw(2, 2, 1, { ...ranked, ranked_display_badge: 101 }),
    // Saison 1 : Eternus 6 (116), plus haut que tout point de saison 2.
    raw(3, 15, 2, { ...ranked, ranked_display_badge: 116 }),
    raw(4, 3, 1, brawl),
    // Mode inconnu (ancienne copie) : seulement sous « all ».
    raw(5, 4, 2, { match_mode: undefined, game_mode: undefined }),
    // Jouée avec B (même résultat → même équipe) et contre C (résultats opposés).
    raw(6, 5, 1),
    raw(7, 6, 2),
    // Période précédente (30 à 60 jours).
    ...Array.from({ length: 6 }, (_, i) => raw(100 + i, 35 + i, i < 3 ? 1 : 2)),
  ],
  [B]: [raw(6, 5, 1), raw(7, 6, 2), raw(4, 3, 1, brawl)],
  [C]: [raw(6, 5, 2), raw(50, 2, 1)],
};

const PROFILES = [A, B, C].map((id) => ({
  account_id: id,
  personaname: `P${id}`,
  avatarfull: `https://a.test/${id}.jpg`,
}));

describe('Comparaison de groupe, Sprint 3 (synthétique)', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;
  let owner: Awaited<ReturnType<typeof createUser>>;
  let groupId: string;
  const ids = [A, B, C].map(accountIdToSteamId);

  const compare = (query: object = {}) =>
    request(app).get(`/api/groups/${groupId}/compare`).query(query).set(owner.auth);

  beforeEach(async () => {
    upstream = createFetchMock()
      .on(/^\/v1\/players\/steam$/, (url) => ({
        body: PROFILES.filter((p) =>
          url.searchParams.get('account_ids')?.split(',').includes(String(p.account_id)),
        ),
      }))
      .on(/^\/v1\/players\/(\d+)\/match-history$/, (url) => ({
        body: HISTORIES[Number(url.pathname.split('/')[3])] ?? [],
      }))
      .on(/^\/v1\/assets\/ranked-seasons$/, {
        body: [
          {
            name: 'Beta Season 1',
            intervals: [
              { interval: 1, start_timestamp: NOW_S - 400 * DAY, end_timestamp: SEASON_SWITCH },
            ],
          },
          {
            name: 'Beta Season 2',
            intervals: [{ interval: 2, start_timestamp: SEASON_SWITCH, end_timestamp: null }],
          },
        ],
      })
      .on(/^\/v1\/assets\//, { body: [] });
    app = buildTestApp({}, upstream.fetch);
    owner = await createUser();
    const res = await request(app)
      .post('/api/groups')
      .set(owner.auth)
      .send({ name: 'Trio', steamIds: ids });
    groupId = res.body.id;
  });

  const member = (body: { members: Array<{ steamId: string }> }, id: number) =>
    body.members.find((m) => m.steamId === accountIdToSteamId(id)) as unknown as Record<
      string,
      unknown
    > & {
      rankHistory: Array<{ season: number | null; badge: number }>;
    };

  describe('filtres de mode', () => {
    it('all : tout, mode inconnu compris ; normal : sans Street Brawl ni mode inconnu', async () => {
      let res = await compare();
      expect(member(res.body, A)).toMatchObject({ matches: 7, excludedUnknownModeMatches: 0 });
      res = await compare({ gameMode: 'normal' });
      expect(res.body.appliedFilters).toEqual({
        period: '30d',
        gameMode: 'normal',
        matchMode: 'all',
      });
      // 1, 2, 3, 6, 7 ; 4 (Street Brawl) exclue ; 5 (mode inconnu) écartée et comptée.
      expect(member(res.body, A)).toMatchObject({ matches: 5, excludedUnknownModeMatches: 1 });
    });

    it('street_brawl, ranked, unranked ; aucune partie → statistiques vides, jamais 0 inventé', async () => {
      expect(member((await compare({ gameMode: 'street_brawl' })).body, A).matches).toBe(1);
      const rankedRes = await compare({ matchMode: 'ranked' });
      expect(member(rankedRes.body, A)).toMatchObject({ matches: 3, wins: 2 });
      expect(member((await compare({ matchMode: 'unranked' })).body, A).matches).toBe(3);
      const empty = member((await compare({ gameMode: 'street_brawl', period: '7d' })).body, C);
      expect(empty).toMatchObject({ matches: 0, winRate: null, kda: null, bestMatch: null });
    });

    it('valeurs invalides → 400', async () => {
      expect((await compare({ gameMode: 'brawl' })).status).toBe(400);
      expect((await compare({ matchMode: 'coop' })).status).toBe(400);
      expect((await compare({ include: 'all' })).status).toBe(400);
    });
  });

  describe('saisons et progression de rang', () => {
    it('points annotés par saison ; progression sur la dernière saison seulement', async () => {
      const res = await compare();
      const a = member(res.body, A);
      expect(a.rankHistory.map((p) => [p.badge, p.season])).toEqual([
        [116, 1],
        [101, 2],
        [103, 2],
      ]);
      // 103 − 101 = +2 sous-rangs ; jamais 103 − 116 (saisons non comparables).
      expect(a.rankDelta).toBe(2);
      expect(res.body.methodology).toMatchObject({
        rankDeltaScope: 'latest_season_in_period',
        seasonBoundariesKnown: true,
        seasons: [
          expect.objectContaining({ season: 1, name: 'Beta Season 1' }),
          expect.objectContaining({ season: 2, endedAt: null }),
        ],
      });
      const climb = res.body.highlights.find((h: { key: string }) => h.key === 'biggest_climb');
      expect(climb).toMatchObject({ steamIds: [accountIdToSteamId(A)], value: 2 });
    });

    it('/players/:id/rank-history : saisons couvertes et note de chevauchement', async () => {
      const res = await request(app)
        .get(`/api/players/${accountIdToSteamId(A)}/rank-history`)
        .query({
          period: '30d',
        });
      expect(res.body.points.map((p: { season: number }) => p.season)).toEqual([1, 2, 2]);
      expect(res.body.seasons.map((s: { season: number }) => s.season)).toEqual([1, 2]);
      expect(res.body.coverage.notes).toContain('spans_multiple_seasons');
    });

    it('saisons indisponibles : season null, progression sur toute la période, signalé', async () => {
      upstream.reset();
      upstream
        .on(/^\/v1\/players\/steam$/, { body: PROFILES })
        .on(/^\/v1\/players\/(\d+)\/match-history$/, (url) => ({
          body: HISTORIES[Number(url.pathname.split('/')[3])] ?? [],
        }))
        .on(/^\/v1\/assets\//, { status: 503 });
      const res = await compare();
      expect(member(res.body, A).rankHistory.every((p) => p.season === null)).toBe(true);
      expect(res.body.methodology.seasonBoundariesKnown).toBe(false);
    });
  });

  describe('période précédente', () => {
    it('30 jours : fenêtre précédente de même durée, écarts calculés par le back', async () => {
      const a = member((await compare({ gameMode: 'normal' })).body, A);
      // Précédente : 6 parties normales, 3 victoires.
      expect(a.previous).toMatchObject({ matches: 6, wins: 3, winRate: 50, kdaSampleSize: 6 });
      // Actuelle : 5 parties (1, 2, 3, 6, 7), 3 victoires → 60 %.
      expect(a.deltaVsPrevious).toEqual({ matches: -1, winRate: 10, kda: 0 });
      expect((await compare()).body.methodology.previousPeriod).toEqual({
        from: expect.any(String),
        to: expect.any(String),
      });
    });

    it('saison : pas de période précédente comparable → null', async () => {
      const res = await compare({ period: 'season' });
      expect(member(res.body, A)).toMatchObject({ previous: null, deltaVsPrevious: null });
      expect(res.body.methodology.previousPeriod).toBeNull();
    });
  });

  describe('paires (include=pairs)', () => {
    it('même équipe et adversaires exacts, filtres respectés, aucun appel externe', async () => {
      await compare();
      const before = upstream.calls.length;
      const res = await compare({ include: 'pairs' });
      expect(upstream.calls.length).toBe(before);
      const [first, ...rest] = res.body.pairs.items as GroupPair[];
      expect(first).toEqual({
        steamIds: [accountIdToSteamId(A), accountIdToSteamId(B)],
        // 6 (V), 7 (D), 4 (V, Street Brawl).
        together: {
          matches: 3,
          wins: 2,
          losses: 1,
          winRate: 66.67,
          lastPlayedAt: expect.any(String),
        },
        against: { matches: 0, firstWins: 0 },
      });
      // A et C : partie 6, A gagne, C perd → adversaires.
      expect(rest).toEqual([
        expect.objectContaining({
          steamIds: [accountIdToSteamId(A), accountIdToSteamId(C)],
          together: expect.objectContaining({ matches: 0, winRate: null }),
          against: { matches: 1, firstWins: 1 },
        }),
        expect.objectContaining({
          steamIds: [accountIdToSteamId(B), accountIdToSteamId(C)],
          against: { matches: 1, firstWins: 1 },
        }),
      ]);
      expect(res.body.pairs.scope).toEqual({
        relation: 'same_team',
        partyConfirmed: false,
        basis: 'match_history_intersection',
        period: '30d',
        gameMode: 'all',
        matchMode: 'all',
      });
      expect(res.body.pairs.coverage).toEqual({
        membersIncluded: 3,
        membersMissing: [],
        pairsEvaluated: 3,
        pairsWithCommonMatches: 3,
      });
      // Mode normal : la partie Street Brawl commune disparaît.
      const normal = await compare({ include: 'pairs', gameMode: 'normal' });
      expect(normal.body.pairs.items[0].together.matches).toBe(2);
    });
  });

  describe('membres indisponibles', () => {
    it('introuvable, quota, panne : raisons distinctes, les autres membres conservés', async () => {
      upstream.reset();
      upstream
        .on(/^\/v1\/players\/steam$/, (url) => {
          const id = url.searchParams.get('account_ids');
          if (id === String(B)) return { body: [] };
          if (id === String(C)) return { status: 429, headers: { 'retry-after': '30' } };
          return { body: PROFILES.filter((p) => String(p.account_id) === id) };
        })
        .on(/^\/v1\/players\/(\d+)\/match-history$/, (url) => ({
          body: HISTORIES[Number(url.pathname.split('/')[3])] ?? [],
        }))
        .on(/^\/v1\/assets\//, { body: [] });
      const res = await compare();
      expect(res.status).toBe(200);
      expect(res.body.members.map((m: { steamId: string }) => m.steamId)).toEqual([
        accountIdToSteamId(A),
      ]);
      expect(res.body.unavailable).toEqual([
        { steamId: accountIdToSteamId(B), reason: 'not_found' },
        { steamId: accountIdToSteamId(C), reason: 'rate_limited' },
      ]);
      expect(res.body.meta.isPartial).toBe(true);
    });

    it('classification : seulement ce que l’erreur source établit', () => {
      const unavailable = (reason?: 'timeout' | 'unreachable' | 'unavailable') =>
        new AppError(503, 'SERVICE_UNAVAILABLE', 'x', undefined, reason);
      expect(unavailableReason(unavailable('timeout'))).toBe('timeout');
      expect(unavailableReason(unavailable('unreachable'))).toBe('provider_error');
      expect(unavailableReason(unavailable())).toBe('provider_error');
      expect(unavailableReason(new AppError(502, 'UPSTREAM_ERROR', 'x'))).toBe('provider_error');
      expect(unavailableReason(new AppError(400, 'INVALID_INPUT', 'x'))).toBe('unknown');
      expect(unavailableReason(new Error('boom'))).toBe('unknown');
    });
  });

  describe('GET /api/groups?include=members', () => {
    const list = (query: object = {}) =>
      request(app).get('/api/groups').query(query).set(owner.auth);
    const steamCalls = () => upstream.calls.filter((u) => u.pathname === '/v1/players/steam');

    it('identités de tous les groupes en un appel groupé, ids dédoublonnés, ordre conservé', async () => {
      await request(app)
        .post('/api/groups')
        .set(owner.auth)
        .send({ name: 'Duo', steamIds: [ids[2], accountIdToSteamId(D)] });
      const res = await list({ include: 'members' });
      expect(res.status).toBe(200);
      const calls = steamCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.searchParams.get('account_ids')?.split(',').sort()).toEqual(
        [A, B, C, D].map(String).sort(),
      );
      const [duo, trio] = res.body.items;
      expect(trio.members).toEqual([
        {
          steamId: ids[0],
          displayName: `P${A}`,
          avatarUrl: `https://a.test/${A}.jpg`,
          resolved: true,
        },
        expect.objectContaining({ steamId: ids[1], resolved: true }),
        expect.objectContaining({ steamId: ids[2], resolved: true }),
      ]);
      // D : absent de la source → repli explicite sur le SteamID64.
      expect(duo.members[1]).toEqual({
        steamId: accountIdToSteamId(D),
        displayName: accountIdToSteamId(D),
        avatarUrl: null,
        resolved: false,
      });
      expect(res.body.membersCoverage).toEqual({
        requested: 4,
        resolved: 3,
        fetched: 3,
        providerFailed: false,
      });
      expect(res.body.meta.isPartial).toBe(true);
      // Champs v1.14 conservés.
      expect(trio).toMatchObject({ id: groupId, name: 'Trio', steamIds: ids });
    });

    it('cache chaud : aucun appel ; profils déjà lus (`profile:`) réutilisés', async () => {
      await list({ include: 'members' });
      const before = steamCalls().length;
      await list({ include: 'members' });
      expect(steamCalls().length).toBe(before);
      // Copie de profil existante d'un autre parcours (comparaison) : réutilisée.
      await ApiCacheModel.deleteMany({ key: /^identity:/ });
      await compare();
      const afterCompare = steamCalls().length;
      await list({ include: 'members' });
      expect(steamCalls().length).toBe(afterCompare);
    });

    it('source en échec : repli sur le SteamID, liste jamais en échec ; sans include : v1.14', async () => {
      upstream.reset();
      upstream.on(/^\/v1\/players\/steam$/, { status: 429, headers: { 'retry-after': '30' } });
      const res = await list({ include: 'members' });
      expect(res.status).toBe(200);
      expect(res.body.items[0].members.every((m: { resolved: boolean }) => !m.resolved)).toBe(true);
      expect(res.body.membersCoverage).toMatchObject({ resolved: 0, providerFailed: true });
      const plain = await list();
      expect(Object.keys(plain.body)).toEqual(['items']);
      expect(plain.body.items[0]).not.toHaveProperty('members');
      expect((await list({ include: 'avatars' })).status).toBe(400);
    });

    it('copie périmée servie si la source échoue', async () => {
      await list({ include: 'members' });
      await ApiCacheModel.updateMany({ key: /^identity:/ }, { $set: { expiresAt: new Date(0) } });
      upstream.reset();
      upstream.on(/^\/v1\/players\/steam$/, { status: 503 });
      const res = await list({ include: 'members' });
      expect(res.body.items[0].members[0]).toMatchObject({ displayName: `P${A}`, resolved: true });
      expect(res.body.meta.isStale).toBe(true);
    });
  });
});

describe('Fonctions de saison et de paires (synthétique)', () => {
  const seasons = [
    { season: 1, startAt: 0, endAt: 100 },
    { season: 2, startAt: 100, endAt: null },
  ];

  it('seasonAt : bornes [début, fin[ ; hors saison → null', () => {
    expect(seasonAt(99, seasons)).toBe(1);
    expect(seasonAt(100, seasons)).toBe(2);
    expect(seasonAt(-1, seasons)).toBeNull();
  });

  it('seasonRankDelta : segment de la dernière saison, null sous 2 points', () => {
    expect(seasonRankDelta([])).toBeNull();
    expect(
      seasonRankDelta([
        { score: 70, season: 1 },
        { score: 60, season: 2 },
      ]),
    ).toBeNull();
    expect(
      seasonRankDelta([
        { score: 70, season: 1 },
        { score: 60, season: 2 },
        { score: 64, season: 2 },
      ]),
    ).toBe(4);
    expect(
      seasonRankDelta([
        { score: 10, season: null },
        { score: 12, season: null },
      ]),
    ).toBe(2);
  });

  it('groupPairs : membre sans partie commune absent des items ; 20 membres → 190 paires', () => {
    const m = (matchId: string, win: boolean) => ({ matchId, win, startTime: 1 }) as StoredMatch;
    const members = Array.from({ length: 20 }, (_, i) => ({
      steamId: String(i),
      matches: [m(`solo-${i}`, true)],
    }));
    const { items, pairsEvaluated } = groupPairs(members);
    expect(pairsEvaluated).toBe(190);
    expect(items).toEqual([]);
  });
});
