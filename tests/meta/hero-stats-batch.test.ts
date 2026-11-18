import request from 'supertest';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

// Fixtures synthétiques.
const playable = {
  player_selectable: true,
  disabled: false,
  in_development: false,
  development_state: 'release',
};
const hero = (id: number, name: string, extra = {}) => ({
  id,
  name,
  hero_type: 'brawler',
  images: {},
  ...playable,
  ...extra,
});
const HEROES = [
  hero(6, 'Abrams'),
  hero(72, 'Billy'),
  hero(13, 'Haze'),
  hero(99, 'Prototype', { player_selectable: false }),
];
const ANALYTICS = [
  { hero_id: 6, bucket: 0, matches: 600, wins: 330, total_kills: 6000 },
  { hero_id: 72, bucket: 0, matches: 400, wins: 180 },
];

describe('GET /api/heroes/stats (méta groupée, synthétique)', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] })
      .on(/^\/v1\/analytics\/hero-stats$/, { body: ANALYTICS });
    app = buildTestApp({}, upstream.fetch);
  });

  const analyticsCalls = () => upstream.calls.filter((u) => u.pathname.includes('analytics'));

  it('ordre demandé, héros sans données → valeurs null, inconnus et non jouables à part', async () => {
    const res = await request(app).get('/api/heroes/stats').query({ heroIds: '72,6,13,99,500,6' });
    expect(res.status).toBe(200);
    expect(res.body.items.map((s: { heroId: number }) => s.heroId)).toEqual([72, 6, 13]);
    // pickRate = parties du héros × 12 joueurs / parties totales (formule de la route individuelle).
    expect(res.body.items[1]).toMatchObject({
      heroId: 6,
      matches: 600,
      winRate: 55,
      pickRate: 720,
    });
    // Héros jouable absent de la fenêtre : null, jamais 0.
    expect(res.body.items[2]).toMatchObject({ heroId: 13, matches: null, winRate: null });
    // Doublon retiré ; 99 (non jouable) et 500 (inconnu) signalés sans 404 global.
    expect(res.body.unknownHeroIds).toEqual([99, 500]);
    expect(res.body.scope).toEqual({ period: '30d', gameMode: 'normal', matchMode: 'all' });
    expect(res.body.coverage).toEqual({ requested: 5, known: 3, withStats: 2 });
    expect(res.body.meta).toMatchObject({ isStale: false, isPartial: false });
  });

  it('mêmes valeurs que la route individuelle ; une seule lecture source pour tout', async () => {
    const batch = await request(app).get('/api/heroes/stats').query({ heroIds: '6,72' });
    const single = await request(app).get('/api/heroes/6/stats');
    expect(batch.body.items[0]).toEqual(single.body.stats);
    await request(app).get('/api/heroes/stats');
    expect(analyticsCalls()).toHaveLength(1);
  });

  it('sans heroIds : tous les héros jouables, par id croissant', async () => {
    const res = await request(app).get('/api/heroes/stats');
    expect(res.body.items.map((s: { heroId: number }) => s.heroId)).toEqual([6, 13, 72]);
    expect(res.body.unknownHeroIds).toEqual([]);
  });

  it.each([['abc'], ['1,,2'], ['0'], [Array.from({ length: 65 }, (_, i) => i + 1).join(',')]])(
    'heroIds=%s → 400 sans appel externe',
    async (heroIds) => {
      const res = await request(app).get('/api/heroes/stats').query({ heroIds });
      expect(res.status).toBe(400);
      expect(upstream.calls).toHaveLength(0);
    },
  );

  it('source des statistiques indisponible sans copie → 503 ; routes du catalogue intactes', async () => {
    upstream.reset();
    upstream
      .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: [] })
      .on(/^\/v1\/analytics\/hero-stats$/, { status: 503 });
    expect((await request(app).get('/api/heroes/stats')).status).toBe(503);
    // `/heroes/:heroId` reste servi par le catalogue malgré le montage de la méta en premier.
    expect((await request(app).get('/api/heroes/6')).status).toBe(200);
  });
});
