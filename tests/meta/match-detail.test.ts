import request from 'supertest';
import { ApiCacheModel } from '../../src/database/api-cache';
import { finalStats, splitItems } from '../../src/modules/meta/match-detail';
import type { CatalogItem } from '../../src/modules/items/items.service';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const ITEMS = [
  {
    id: 100,
    class_name: 'upgrade_a',
    name: 'Extended Magazine',
    type: 'upgrade',
    item_slot_type: 'weapon',
    item_tier: 1,
    cost: 800,
    shopable: true,
  },
  {
    id: 200,
    class_name: 'upgrade_b',
    name: 'Healing Rite',
    type: 'upgrade',
    item_slot_type: 'vitality',
    item_tier: 1,
    cost: 800,
    shopable: true,
  },
  { id: 300, class_name: 'ability_x', name: 'Flame Dash', type: 'ability', hero: 1 },
];

const stats = (extra: object = {}) => ({
  time_stamp_s: 1800,
  player_damage: 30000,
  player_damage_taken: 12000,
  boss_damage: 5000,
  creep_damage: 20000,
  neutral_damage: 4000,
  player_healing: 3000,
  self_healing: 2500,
  teammate_healing: 500,
  damage_mitigated: 9000,
  hero_bullets_hit: 200,
  hero_bullets_hit_crit: 50,
  shots_hit: 600,
  shots_missed: 400,
  headshot_kills: 2,
  creep_kills: 120,
  neutral_kills: 30,
  ...extra,
});

const player = (
  account: number,
  team: number,
  kills: number,
  assists: number,
  extra: object = {},
) => ({
  account_id: account,
  team,
  hero_id: 1,
  kills,
  deaths: 2,
  assists,
  net_worth: 30000 + account,
  last_hits: 100,
  denies: 5,
  level: 30,
  mvp_rank: account === 1 ? 1 : null,
  items: [
    { item_id: 300, game_time_s: 0, sold_time_s: 0 },
    { item_id: 200, game_time_s: 400, sold_time_s: 900 },
    { item_id: 100, game_time_s: 120, sold_time_s: 0 },
    { item_id: 999, game_time_s: 50, sold_time_s: 0 },
  ],
  stats: [stats({ time_stamp_s: 600, player_damage: 1 }), stats()],
  ...extra,
});

const METADATA = {
  match_info: {
    match_id: 1,
    start_time: 1_794_000_000,
    duration_s: 1800,
    winning_team: 0,
    match_mode: 4,
    game_mode: 1,
    average_badge_team0: 104,
    average_badge_team1: 0,
    players: [
      player(1, 0, 6, 4),
      player(2, 0, 4, 2),
      player(3, 1, 3, 1, { stats: [], items: null }),
    ],
  },
};

describe('GET /api/matches/:matchId enrichi', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/metadata$/, { body: METADATA })
      .on(/^\/v1\/players\/steam$/, { body: [] })
      .on(/^\/v1\/assets\/heroes$/, {
        body: [{ id: 1, name: 'Infernus', class_name: 'hero_inferno', images: {} }],
      })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] })
      .on(/^\/v1\/assets\/client-versions$/, { body: [10, 12, 11] })
      .on(/^\/v1\/assets\/items$/, { body: ITEMS })
      .on(/^\/v1\/assets\/ranks$/, {
        body: [
          {
            tier: 10,
            name: 'Phantom',
            color: '#a',
            images: { large_webp: 'https://r.test/10.webp' },
          },
        ],
      });
    app = buildTestApp({}, upstream.fetch);
  });

  it('statistiques de fin de partie, MVP, participation, achats, objets finaux, capacités', async () => {
    const res = await request(app).get('/api/matches/1');
    expect(res.status).toBe(200);
    const { match, meta } = res.body;
    expect(match.teams[0]).toMatchObject({
      side: 'amber',
      averageBadge: 104,
      averageRankName: 'Phantom 4',
    });
    expect(match.teams[1]).toMatchObject({ averageBadge: null, averageRankName: null });
    const best = match.teams[0].players.find(
      (p: { steamId: string }) => p.steamId === '76561197960265729',
    );
    expect(best).toMatchObject({
      mvpRank: 1,
      // (6 + 4) / (6 + 4) éliminations de l'équipe
      killParticipation: 100,
      stats: {
        playerDamage: 30000,
        damageTaken: 12000,
        objectiveDamage: 5000,
        healing: 3000,
        heroBulletsHit: 200,
        heroBulletsHitCrit: 50,
        heroCritRate: 25,
        accuracy: 60,
        headshotKills: 2,
      },
      // Achats d'objets triés par heure ; 999 (absent du catalogue) et la capacité 300 exclus.
      purchases: [
        { itemId: 100, atSeconds: 120, soldAtSeconds: null },
        { itemId: 200, atSeconds: 400, soldAtSeconds: 900 },
      ],
      finalItemIds: [100],
      abilityUpgrades: [{ abilityId: 300, atSeconds: 0 }],
    });
    // Dernier relevé uniquement (pas le relevé à 600 s).
    expect(best.stats.playerDamage).toBe(30000);
    const second = match.teams[0].players.find(
      (p: { steamId: string }) => p.steamId === '76561197960265730',
    );
    // (4 + 2) / 10
    expect(second).toMatchObject({ mvpRank: null, killParticipation: 60 });
    // Joueur sans relevé ni items : null, jamais 0 ni liste vide inventée.
    expect(match.teams[1].players[0]).toMatchObject({
      stats: null,
      purchases: null,
      finalItemIds: null,
      abilityUpgrades: null,
    });
    expect(match).toMatchObject({ matchMode: 'ranked', gameMode: 'normal' });
    expect(meta.isPartial).toBe(false);
    // Catalogue d'items de la version la plus récente (12).
    const itemsCall = upstream.calls.find((u) => u.pathname === '/v1/assets/items');
    expect(itemsCall?.searchParams.get('client_version')).toBe('12');
  });

  it('cache v3 compact : pas de relevés intermédiaires stockés, une seule lecture de la source', async () => {
    await request(app).get('/api/matches/1');
    await request(app).get('/api/matches/1');
    expect(upstream.calls.filter((u) => u.pathname.endsWith('metadata'))).toHaveLength(1);
    const entry = await ApiCacheModel.findOne({ key: 'match:v3:1' }).lean();
    const stored = JSON.stringify(entry?.payload);
    expect(stored).not.toContain('time_stamp_s');
    expect(stored).toContain('playerDamage');
  });

  it('catalogue d’items indisponible → achats null et isPartial', async () => {
    upstream.reset();
    upstream
      .on(/metadata$/, { body: METADATA })
      .on(/^\/v1\/players\/steam$/, { body: [] })
      .on(/^\/v1\/assets\//, { status: 503 });
    const res = await request(app).get('/api/matches/1');
    expect(res.status).toBe(200);
    expect(res.body.match.teams[0].players[0]).toMatchObject({
      purchases: null,
      finalItemIds: null,
    });
    expect(res.body.meta.isPartial).toBe(true);
  });

  it('équipe aux éliminations inconnues → participation null', async () => {
    upstream.reset();
    upstream
      .on(/metadata$/, {
        body: {
          match_info: { ...METADATA.match_info, players: [player(1, 0, 3, 1, { kills: null })] },
        },
      })
      .on(/^\/v1\/players\/steam$/, { body: [] })
      .on(/^\/v1\/assets\//, { status: 503 });
    const res = await request(app).get('/api/matches/1');
    expect(res.body.match.teams[0].players[0].killParticipation).toBeNull();
  });
});

describe('Fonctions de détail de partie', () => {
  it('finalStats : ratios null si dénominateur nul ou inconnu', () => {
    expect(finalStats(undefined)).toBeNull();
    expect(
      finalStats({
        hero_bullets_hit: 0,
        hero_bullets_hit_crit: 0,
        shots_hit: null,
        shots_missed: 3,
      }),
    ).toMatchObject({ heroCritRate: null, accuracy: null, playerDamage: null });
  });

  it('splitItems : sans catalogue ou sans évènements → null', () => {
    const index = new Map<number, CatalogItem>();
    expect(splitItems(null, index)).toEqual({
      purchases: null,
      finalItemIds: null,
      abilityUpgrades: null,
    });
    expect(
      splitItems([{ itemId: 1, atSeconds: null, soldAtSeconds: null }], null).purchases,
    ).toBeNull();
    expect(splitItems([], index)).toEqual({ purchases: [], finalItemIds: [], abilityUpgrades: [] });
  });
});
