import request from 'supertest';
import { createDeadlockApi } from '../../src/integrations/deadlock/deadlock.api';
import { DeadlockClient } from '../../src/integrations/deadlock/deadlock.client';
import { computeHeroMetaStats } from '../../src/modules/meta/meta.service';
import { buildTestApp, silentLogger } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

/** Cas dégradés : champs absents de la source, catalogue indisponible, saison inconnue. */
describe('Replis et données partielles', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock();
    app = buildTestApp({}, upstream.fetch);
  });

  it('classement sans catalogue des héros → noms de repli et isPartial', async () => {
    upstream
      .on(/leaderboard/, {
        body: { entries: [{ account_name: 'x', possible_account_ids: null, top_hero_ids: [7] }] },
      })
      .on(/assets/, { status: 503 });
    const res = await request(app).get('/api/leaderboard');
    expect(res.body.items[0]).toMatchObject({
      rank: 1,
      steamId: null,
      topHeroes: [{ heroId: 7, name: 'Héros #7', imageUrl: null }],
    });
    expect(res.body.meta.isPartial).toBe(true);
  });

  it('partie sans vainqueur, sans date ni statistiques → null partout, isPartial', async () => {
    upstream
      .on(/metadata/, {
        body: {
          match_info: {
            players: [
              { team: 0, hero_id: 3 },
              { team: 1, hero_id: 4 },
            ],
          },
        },
      })
      .on(/assets/, { status: 503 });
    const res = await request(app).get('/api/matches/42');
    expect(res.status).toBe(200);
    expect(res.body.match).toMatchObject({
      playedAt: null,
      durationSeconds: null,
      winningSide: null,
    });
    expect(res.body.match.teams[0].outcome).toBe('loss');
    // v1.12.0 : `result` distingue le vainqueur inconnu (null) d'une défaite.
    expect(res.body.match.teams.map((t: { result: unknown }) => t.result)).toEqual([null, null]);
    expect(res.body.match.teams[0].players[0]).toMatchObject({
      steamId: null,
      displayName: 'Joueur inconnu',
      heroName: 'Héros #3',
      kills: null,
      netWorth: null,
    });
    expect(res.body.meta.isPartial).toBe(true);
    // Aucun compte connu : pas d'appel de profils.
    expect(upstream.calls.some((u) => u.pathname === '/v1/players/steam')).toBe(false);
  });

  it('pseudos indisponibles → repli sur le SteamID sans faire échouer la partie', async () => {
    upstream
      .on(/metadata/, {
        body: {
          match_info: {
            start_time: 1,
            winning_team: 0,
            players: [{ account_id: 5, team: 0, hero_id: 1 }],
          },
        },
      })
      .on(/players\/steam/, { status: 500 })
      .on(/assets/, { body: [] });
    const res = await request(app).get('/api/matches/43');
    expect(res.body.match.teams[0].players[0].displayName).toBe('76561197960265733');
    expect(res.body.match.winningSide).toBe('amber');
  });

  it('carte sans vue « mid » → minimap générique ; sans image → chaîne vide', async () => {
    upstream.on(/map/, { body: { images: { minimap: 'https://m.test/min.png' } } });
    expect((await request(app).get('/api/map')).body).toStrictEqual({
      minimap: 'https://m.test/min.png',
      tunnels: null,
      frame: null,
    });
  });

  it('stats méta : totaux absents comptés à 0, bucket absent = palier 0', () => {
    const stats = computeHeroMetaStats([{ hero_id: 1, bucket: null, matches: 300, wins: 150 }]);
    expect(stats['1']).toMatchObject({ avgKills: 0, avgDeaths: 0, avgAssists: 0 });
    expect(stats['1']?.winRateByTier[0]).toEqual({ tier: 0, winRate: 50, matches: 300 });
  });
});

describe('Couche Deadlock API : cas limites', () => {
  const build = (upstream: FetchMock) =>
    createDeadlockApi(
      new DeadlockClient({
        baseUrl: 'https://d.test',
        fetch: upstream.fetch,
        logger: silentLogger,
      }),
    );

  it('profils en lot : liste vide → aucun appel ; ids dédupliqués et triés', async () => {
    const upstream = createFetchMock().on(/players\/steam/, { body: [] });
    const api = build(upstream);
    await expect(api.getSteamProfiles([])).resolves.toEqual([]);
    await expect(api.getPlayerRanks([])).resolves.toEqual({
      ranks: new Map(),
      unchecked: new Set(),
      rankedWithoutBadge: new Set(),
    });
    expect(upstream.calls).toHaveLength(0);
    await api.getSteamProfiles([3, 1, 3]);
    expect(upstream.calls[0]?.searchParams.get('account_ids')).toBe('1,3');
  });

  it('rangs en lots de 500 ; un lot en échec → rangs des autres, comptes du lot unchecked', async () => {
    const ids = Array.from({ length: 700 }, (_, i) => i + 1);
    const upstream = createFetchMock().on(/players\/rank/, (url) =>
      url.searchParams.get('account_ids')?.startsWith('1,')
        ? {
            body: [{ account_id: 5, badge: 113, last_match: { start_time: 9 } }, { account_id: 6 }],
          }
        : { status: 500 },
    );
    const result = await build(upstream).getPlayerRanks(ids);
    // Lot de 500 réussi ; lot de 200 tenté deux fois.
    expect(upstream.calls).toHaveLength(3);
    expect(upstream.calls[1]?.searchParams.get('account_ids')?.split(',')).toHaveLength(200);
    expect(result.ranks).toEqual(new Map([[5, { badge: 113, at: 9 }]]));
    expect([...result.unchecked]).toEqual(ids.slice(500));
  });

  it('lot en échec puis réussi au second essai → aucun compte unchecked', async () => {
    let attempts = 0;
    const upstream = createFetchMock().on(/players\/rank/, () =>
      ++attempts === 1 ? { status: 500 } : { body: [{ account_id: 1, badge: 104 }] },
    );
    const result = await build(upstream).getPlayerRanks([1]);
    expect(result).toEqual({
      ranks: new Map([[1, { badge: 104, at: 0 }]]),
      unchecked: new Set(),
      rankedWithoutBadge: new Set(),
    });
  });

  it('saison : courante trouvée, terminée ou absente → null', async () => {
    const now = 1_000;
    const upstream = createFetchMock().on(/ranked-seasons/, {
      body: [
        { intervals: [{ start_timestamp: 0, end_timestamp: 500 }] },
        { intervals: [{ start_timestamp: 500, end_timestamp: null }] },
      ],
    });
    await expect(build(upstream).getCurrentSeasonStart(now)).resolves.toBe(500);

    const ended = createFetchMock().on(/ranked-seasons/, {
      body: [{ intervals: [{ start_timestamp: 0, end_timestamp: 500 }] }],
    });
    await expect(build(ended).getCurrentSeasonStart(now)).resolves.toBeNull();
  });

  it('ressources inconnues (404) → valeurs vides', async () => {
    const upstream = createFetchMock().on(/.*/, { status: 404 });
    const api = build(upstream);
    await expect(api.getMatchMetadata('1')).resolves.toBeNull();
    await expect(api.getLeaderboard('Europe')).resolves.toEqual([]);
    await expect(api.getHeroAnalyticsByBadge()).resolves.toEqual([]);
    await expect(api.getRanks()).resolves.toEqual([]);
    await expect(api.getMapImages()).resolves.toEqual({});
    await expect(api.getHeroes()).resolves.toEqual([]);
    await expect(api.getAbilities()).resolves.toEqual([]);
    await expect(api.searchPlayers('x', 5)).resolves.toEqual([]);
    await expect(api.getMatchHistory(1)).resolves.toEqual([]);
    await expect(api.getPlayerRanks([3, 1])).resolves.toEqual({
      ranks: new Map(),
      unchecked: new Set(),
      rankedWithoutBadge: new Set(),
    });
  });
});
