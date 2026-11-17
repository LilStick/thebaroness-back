import request from 'supertest';
import { ApiCacheModel } from '../../src/database/api-cache';
import { normalizeItems } from '../../src/modules/items/items.service';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const RAW = [
  {
    id: 200,
    class_name: 'upgrade_big',
    name: 'Big Magazine',
    type: 'upgrade',
    item_slot_type: 'weapon',
    item_tier: 2,
    cost: 1600,
    shopable: true,
    is_active_item: false,
    component_items: ['upgrade_small', 'upgrade_unknown'],
    shop_image_webp: 'https://i.test/big_shop.webp',
    image_webp: 'https://i.test/big.webp',
  },
  {
    id: 100,
    class_name: 'upgrade_small',
    name: 'Small Magazine',
    type: 'upgrade',
    item_slot_type: 'weapon',
    item_tier: 1,
    cost: 800,
    shopable: true,
    image: 'https://i.test/small.png',
  },
  { id: 300, class_name: 'ability_dash', name: 'Dash', type: 'ability', hero: 1, heroes: [1, 2] },
  {
    id: 400,
    class_name: 'upgrade_old',
    name: 'Removed',
    type: 'upgrade',
    item_slot_type: 'spirit',
    shopable: false,
    disabled: true,
  },
  { id: 500, class_name: 'weird', type: 'other' },
];

describe('Catalogue des items', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/client-versions$/, { body: [5, 7, 6] })
      .on(/^\/v1\/assets\/items$/, { body: RAW });
    app = buildTestApp({}, upstream.fetch);
  });

  it('normalisation : type, slot, palier, prix, composants résolus, image de boutique prioritaire', () => {
    const [small, big, dash, removed, weird] = normalizeItems(RAW as never);
    expect(big).toEqual({
      id: 200,
      className: 'upgrade_big',
      name: 'Big Magazine',
      type: 'upgrade',
      slot: 'weapon',
      tier: 2,
      cost: 1600,
      isActive: false,
      shopable: true,
      disabled: false,
      heroIds: [],
      componentIds: [100],
      imageUrl: 'https://i.test/big_shop.webp',
    });
    expect(small).toMatchObject({ imageUrl: 'https://i.test/small.png', isActive: null });
    expect(dash).toMatchObject({ type: 'ability', heroIds: [1, 2], slot: null, imageUrl: null });
    expect(removed).toMatchObject({ disabled: true, shopable: false });
    expect(weird).toMatchObject({ type: null, name: null });
  });

  it('GET /api/items : version la plus récente, filtres combinés', async () => {
    let res = await request(app).get('/api/items');
    expect(res.status).toBe(200);
    expect(res.body.clientVersion).toBe(7);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.meta).toMatchObject({ isStale: false, isPartial: false });
    expect(
      upstream.calls
        .find((u) => u.pathname === '/v1/assets/items')
        ?.searchParams.get('client_version'),
    ).toBe('7');

    res = await request(app)
      .get('/api/items')
      .query({ type: 'upgrade', slot: 'weapon', shopable: 'true' });
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([100, 200]);
    res = await request(app).get('/api/items').query({ tier: 2 });
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([200]);
    res = await request(app).get('/api/items').query({ shopable: 'false', type: 'upgrade' });
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([400]);
  });

  it('instantané immuable par version : un seul téléchargement, version demandée explicitement', async () => {
    await request(app).get('/api/items');
    await request(app).get('/api/items/100');
    expect(upstream.calls.filter((u) => u.pathname === '/v1/assets/items')).toHaveLength(1);
    expect(await ApiCacheModel.exists({ key: 'catalog:items:v7:en' })).toBeTruthy();

    const old = await request(app).get('/api/items/100').query({ clientVersion: 5 });
    expect(old.body.clientVersion).toBe(5);
    const call = upstream.calls.filter((u) => u.pathname === '/v1/assets/items').at(-1);
    expect(call?.searchParams.get('client_version')).toBe('5');
    expect(await ApiCacheModel.exists({ key: 'catalog:items:v5:en' })).toBeTruthy();
  });

  it('liste des versions indisponible → catalogue « latest » sans version', async () => {
    upstream.reset();
    upstream.on(/client-versions$/, { status: 503 }).on(/^\/v1\/assets\/items$/, { body: RAW });
    const res = await request(app).get('/api/items');
    expect(res.body.clientVersion).toBeNull();
    expect(
      upstream.calls
        .find((u) => u.pathname === '/v1/assets/items')
        ?.searchParams.has('client_version'),
    ).toBe(false);
    expect(await ApiCacheModel.exists({ key: 'catalog:items:latest:en' })).toBeTruthy();
  });

  it('GET /api/items/:itemId → item, 404 inconnu, 400 invalide', async () => {
    const res = await request(app).get('/api/items/200');
    expect(res.body).toMatchObject({ clientVersion: 7, item: { name: 'Big Magazine' } });
    expect((await request(app).get('/api/items/999')).status).toBe(404);
    expect((await request(app).get('/api/items/abc')).status).toBe(400);
    expect((await request(app).get('/api/items/1').query({ clientVersion: 0 })).status).toBe(400);
  });

  it.each([[{ type: 'shield' }], [{ slot: 'armor' }], [{ tier: 6 }], [{ shopable: 'yes' }]])(
    '%p → 400 sans appel externe',
    async (query) => {
      expect((await request(app).get('/api/items').query(query)).status).toBe(400);
      expect(upstream.calls).toHaveLength(0);
    },
  );

  it('versions vides → catalogue latest', async () => {
    upstream.reset();
    upstream.on(/client-versions$/, { body: [] }).on(/^\/v1\/assets\/items$/, { status: 404 });
    const res = await request(app).get('/api/items');
    expect(res.body).toMatchObject({ clientVersion: null, items: [] });
  });
});
