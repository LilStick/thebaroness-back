import request from 'supertest';
import { GroupModel } from '../../src/modules/groups/group.model';
import { buildTestApp, createUser } from '../helpers/app';
import { useTestDb } from '../helpers/db';

const BASE = '/api/groups';
const A = '76561198000000010';
const B = '76561198000000011';
const C = '76561198000000012';

describe('CRUD /api/groups', () => {
  useTestDb();
  const app = buildTestApp();
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    alice = await createUser();
    bob = await createUser();
  });

  const create = (body: object, auth = alice.auth) => request(app).post(BASE).set(auth).send(body);

  it.each([
    ['GET', BASE],
    ['POST', BASE],
    ['GET', `${BASE}/507f1f77bcf86cd799439011`],
    ['PATCH', `${BASE}/507f1f77bcf86cd799439011`],
    ['DELETE', `${BASE}/507f1f77bcf86cd799439011`],
  ])('%s %s sans JWT → 401', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('POST → 201, nom trimé, ordre des membres conservé, sans ownerId', async () => {
    const res = await create({ name: '  Duo classé  ', steamIds: [B, A] });
    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({
      id: expect.stringMatching(/^[a-f\d]{24}$/),
      name: 'Duo classé',
      steamIds: [B, A],
      createdAt: expect.stringMatching(/Z$/),
      updatedAt: expect.stringMatching(/Z$/),
    });
    const stored = await GroupModel.findById(res.body.id).lean();
    expect(stored?.ownerId.toHexString()).toBe(alice.userId);
  });

  it('POST : code ami, [U:1:n] et URL de profil → stockés en SteamID64', async () => {
    const res = await create({
      name: 'Trio',
      steamIds: ['39734282', '[U:1:39734283]', `https://steamcommunity.com/profiles/${C}/`],
    });
    expect(res.status).toBe(201);
    expect(res.body.steamIds).toStrictEqual([A, B, C]);
  });

  it.each([
    ['nom vide', { name: '   ', steamIds: [A, B] }],
    ['nom > 60', { name: 'n'.repeat(61), steamIds: [A, B] }],
    ['un seul membre', { name: 'x', steamIds: [A] }],
    [
      '21 membres',
      {
        name: 'x',
        steamIds: Array.from({ length: 21 }, (_, i) => String(76561198000000100n + BigInt(i))),
      },
    ],
    ['doublon', { name: 'x', steamIds: [A, A] }],
    ['steamId invalide', { name: 'x', steamIds: [A, '12345678901'] }],
    ['URL personnalisée', { name: 'x', steamIds: [A, 'https://steamcommunity.com/id/pseudo'] }],
    ['doublon après normalisation', { name: 'x', steamIds: [A, '39734282'] }],
    ['steamId numérique', { name: 'x', steamIds: [A, Number(B)] }],
    ['ownerId fourni', { name: 'x', steamIds: [A, B], ownerId: '507f1f77bcf86cd799439011' }],
    ['champ inconnu', { name: 'x', steamIds: [A, B], color: 'red' }],
    ['steamIds absent', { name: 'x' }],
  ])('%s → 400 INVALID_INPUT sans écriture', async (_label, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(await GroupModel.countDocuments()).toBe(0);
  });

  it('GET liste : uniquement ses groupes, du plus récent au plus ancien ; vide → { items: [] }', async () => {
    expect((await request(app).get(BASE).set(alice.auth)).body).toStrictEqual({ items: [] });
    const g1 = await create({ name: 'g1', steamIds: [A, B] });
    const g2 = await create({ name: 'g2', steamIds: [B, C] });
    await create({ name: 'bob', steamIds: [A, C] }, bob.auth);

    const res = await request(app).get(BASE).set(alice.auth);
    expect(res.body.items.map((g: { id: string }) => g.id)).toEqual([g2.body.id, g1.body.id]);
  });

  describe('par identifiant', () => {
    let id: string;
    beforeEach(async () => {
      id = (await create({ name: 'Équipe', steamIds: [A, B] })).body.id;
    });

    it('GET → 200', async () => {
      const res = await request(app).get(`${BASE}/${id}`).set(alice.auth);
      expect(res.body).toMatchObject({ id, name: 'Équipe', steamIds: [A, B] });
    });

    it('GET / PATCH / DELETE avec le JWT de B → 404, groupe intact', async () => {
      const path = `${BASE}/${id}`;
      const responses = await Promise.all([
        request(app).get(path).set(bob.auth),
        request(app).patch(path).set(bob.auth).send({ name: 'piraté' }),
        request(app).delete(path).set(bob.auth),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect((await GroupModel.findById(id).lean())?.name).toBe('Équipe');
    });

    it('PATCH partiel (nom seul, puis membres seuls) → 200, reste préservé', async () => {
      const renamed = await request(app)
        .patch(`${BASE}/${id}`)
        .set(alice.auth)
        .send({ name: 'Trio' });
      expect(renamed.body).toMatchObject({ name: 'Trio', steamIds: [A, B] });
      const members = await request(app)
        .patch(`${BASE}/${id}`)
        .set(alice.auth)
        .send({ steamIds: [A, B, C] });
      expect(members.body).toMatchObject({ name: 'Trio', steamIds: [A, B, C] });
    });

    it.each([
      ['PATCH vide', {}],
      ['ownerId', { ownerId: '507f1f77bcf86cd799439011' }],
      ['id', { id: '507f1f77bcf86cd799439011' }],
      ['membres insuffisants', { steamIds: [A] }],
      ['nom vide', { name: '' }],
    ])('%s → 400', async (_label, body) => {
      const res = await request(app).patch(`${BASE}/${id}`).set(alice.auth).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    it.each(['GET', 'PATCH', 'DELETE'])('%s avec id malformé → 400', async (method) => {
      const res = await request(app)
        [method.toLowerCase() as 'get'](`${BASE}/pas-un-id`)
        .set(alice.auth)
        .send({ name: 'x' });
      expect(res.status).toBe(400);
    });

    it('DELETE → 204 sans corps, puis GET → 404', async () => {
      const del = await request(app).delete(`${BASE}/${id}`).set(alice.auth);
      expect(del.status).toBe(204);
      expect(del.text).toBe('');
      expect((await request(app).get(`${BASE}/${id}`).set(alice.auth)).status).toBe(404);
    });
  });
});
