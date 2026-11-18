import request from 'supertest';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

// Fixtures synthétiques.
const ACCOUNT = 101;
const STEAM_ID = String(76561197960265728n + BigInt(ACCOUNT));
const NOW_S = Math.floor(Date.now() / 1000);

const entry = (id: number, i: number) => ({
  match_id: id,
  hero_id: 1,
  start_time: NOW_S - i * 3600,
  match_duration_s: 1200,
  player_kills: 6,
  player_deaths: 2,
  player_assists: 4,
  net_worth: 30000,
  player_match_outcome: 1,
});

const player = (account: number, team: number, kills: number, netWorth: number, extra = {}) => ({
  account_id: account,
  team,
  hero_id: 1,
  kills,
  deaths: 2,
  assists: 4,
  net_worth: netWorth,
  last_hits: 120,
  denies: 3,
  level: 30,
  mvp_rank: account === ACCOUNT ? 1 : null,
  items: [
    { item_id: 100, game_time_s: 120, sold_time_s: 0 },
    { item_id: 300, game_time_s: 0, sold_time_s: 0 },
  ],
  ...extra,
});

const metadata = (id: number, players: unknown[]) => ({
  match_info: {
    match_id: id,
    start_time: NOW_S,
    duration_s: 1200,
    winning_team: 0,
    match_mode: 4,
    game_mode: 1,
    average_badge_team0: 92,
    average_badge_team1: 0,
    players,
  },
});

describe('GET /players/:steamId/matches?include=summary (synthétique)', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/^\/v1\/players\/steam$/, { body: [{ account_id: ACCOUNT, personaname: 'Moi' }] })
      .on(/match-history$/, { body: [entry(3, 0), entry(2, 1), entry(1, 2)] })
      .on(/\/3\/metadata$/, {
        body: metadata(3, [
          player(ACCOUNT, 0, 6, 30000),
          player(102, 0, 4, 40000),
          player(103, 1, 2, 30000),
        ]),
      })
      // Partie où le joueur n'apparaît pas (compte masqué) → résumé null.
      .on(/\/2\/metadata$/, { body: metadata(2, [player(104, 0, 1, 1000)]) })
      .on(/\/1\/metadata$/, { status: 503 })
      .on(/^\/v1\/assets\/client-versions$/, { body: [7] })
      .on(/^\/v1\/assets\/items$/, {
        body: [
          { id: 100, class_name: 'u', name: 'U', type: 'upgrade', item_slot_type: 'weapon' },
          { id: 300, class_name: 'a', name: 'A', type: 'ability' },
        ],
      })
      .on(/^\/v1\/assets\//, { body: [] });
    app = buildTestApp({}, upstream.fetch);
  });

  const get = (query: object) => request(app).get(`/api/players/${STEAM_ID}/matches`).query(query);

  it('résumé par ligne, mêmes règles que /matches/{id} ; partie indisponible → null isolé', async () => {
    const res = await get({ include: 'summary' });
    expect(res.status).toBe(200);
    const [m3, m2, m1] = res.body.items;
    expect(m3.summary).toEqual({
      mvpRank: 1,
      // (6 + 4) / (6 + 4) éliminations de l'équipe
      killParticipation: 100,
      kda: 5,
      netWorthRank: 2,
      teamNetWorthRank: 2,
      playersInMatch: 3,
      lastHitsPerMinute: 6,
      // v1.14.0 : 30 000 / 20 min.
      netWorthPerMinute: 1500,
      performanceTags: ['match_best_kda'],
      // La capacité 300 n'est pas un objet.
      finalItemIds: [100],
      teamAverageBadge: 92,
    });
    // Champs v1.12 de la ligne inchangés.
    expect(m3).toMatchObject({ matchId: '3', kills: 6 });
    expect(m2.summary).toBeNull();
    expect(m1.summary).toBeNull();
    expect(res.body.summaryCoverage).toEqual({
      requested: 3,
      available: 1,
      notes: ['some_matches_unavailable'],
    });
    expect(res.body.meta.isPartial).toBe(true);
  });

  it('parties en cache partagé : un second appel ne relit pas la source', async () => {
    await get({ include: 'summary' });
    const metadataCalls = () => upstream.calls.filter((u) => u.pathname.endsWith('metadata'));
    const before = metadataCalls().length;
    await get({ include: 'summary' });
    // Seule la partie en erreur (non mise en cache) est retentée.
    expect(metadataCalls().length - before).toBe(1);
    // Le détail de partie réutilise la copie : aucun nouvel appel.
    await request(app).get('/api/matches/3');
    expect(metadataCalls().length - before).toBe(1);
  });

  it('sans include : réponse v1.12 inchangée, aucune lecture de partie', async () => {
    const res = await get({});
    expect(res.body.items[0]).not.toHaveProperty('summary');
    expect(res.body).not.toHaveProperty('summaryCoverage');
    expect(upstream.calls.some((u) => u.pathname.endsWith('metadata'))).toBe(false);
  });

  it('pagination : le curseur reste valable avec include ; include invalide → 400', async () => {
    const first = await get({ include: 'summary', limit: 1 });
    const next = await get({ include: 'summary', limit: 1, cursor: first.body.nextCursor });
    expect(next.status).toBe(200);
    expect(next.body.items.map((m: { matchId: string }) => m.matchId)).toEqual(['2']);
    expect((await get({ include: 'stats' })).status).toBe(400);
  });
});
