import os from 'node:os';
import mongoose from 'mongoose';
import request from 'supertest';
import { connectMongo } from '../../src/database/mongo';
import { TrackedPlayerModel } from '../../src/modules/tracked-players/tracked-player.model';
import { buildTestApp, createUser } from '../helpers/app';
import { useTestDb } from '../helpers/db';

const URL_BASE = '/api/tracked-players';
const STEAM_ID = '76561198000000000';
const OTHER_STEAM_ID = '76561198000000099';

describe('CRUD /api/tracked-players', () => {
  useTestDb();
  let app = buildTestApp();
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;

  beforeEach(async () => {
    alice = await createUser();
    bob = await createUser();
  });

  const create = (body: object, auth = alice.auth) =>
    request(app).post(URL_BASE).set(auth).send(body);

  describe('authentification', () => {
    it.each([
      ['GET', URL_BASE],
      ['POST', URL_BASE],
      ['GET', `${URL_BASE}/507f1f77bcf86cd799439011`],
      ['PATCH', `${URL_BASE}/507f1f77bcf86cd799439011`],
      ['DELETE', `${URL_BASE}/507f1f77bcf86cd799439011`],
    ])('T-06 : %s %s sans JWT → 401 UNAUTHORIZED', async (method, path) => {
      const res = await request(app)[method.toLowerCase() as 'get'](path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('POST', () => {
    it('T-07 : 201, objet complet, ownerId calculé côté serveur et non exposé', async () => {
      const res = await create({
        steamId: STEAM_ID,
        alias: '  Partenaire régulier  ',
        note: 'Très bon',
        tags: ['duo', ' ranked '],
      });

      expect(res.status).toBe(201);
      expect(res.body).toStrictEqual({
        id: expect.stringMatching(/^[a-f\d]{24}$/),
        steamId: STEAM_ID,
        alias: 'Partenaire régulier',
        note: 'Très bon',
        tags: ['duo', 'ranked'],
        createdAt: expect.stringMatching(/Z$/),
        updatedAt: expect.stringMatching(/Z$/),
      });
      const stored = await TrackedPlayerModel.findById(res.body.id).lean();
      expect(stored?.ownerId.toHexString()).toBe(alice.userId);
    });

    it('valeurs par défaut quand seuls les champs requis sont fournis', async () => {
      const res = await create({ steamId: STEAM_ID });
      expect(res.body).toMatchObject({ alias: '', note: '', tags: [] });
    });

    it('doublon pour le même compte → 409 ALREADY_TRACKED', async () => {
      await create({ steamId: STEAM_ID }).expect(201);
      const res = await create({ steamId: STEAM_ID });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_TRACKED');
    });

    it('deux comptes peuvent suivre le même joueur', async () => {
      await create({ steamId: STEAM_ID }).expect(201);
      await create({ steamId: STEAM_ID }, bob.auth).expect(201);
    });

    it.each([
      ['T-10 ownerId fourni', { steamId: STEAM_ID, ownerId: '507f1f77bcf86cd799439011' }],
      ['T-10 id fourni', { steamId: STEAM_ID, id: '507f1f77bcf86cd799439011' }],
      ['T-10 _id fourni', { steamId: STEAM_ID, _id: '507f1f77bcf86cd799439011' }],
      ['createdAt fourni', { steamId: STEAM_ID, createdAt: '2020-01-01T00:00:00Z' }],
      ['champ inconnu', { steamId: STEAM_ID, rank: 1 }],
      ['steamId absent', { alias: 'x' }],
      ['steamId numérique', { steamId: 76561198000000000 }],
      ['steamId trop court', { steamId: '7656119800000' }],
      ['steamId non Steam', { steamId: '12345678901234567' }],
      ['alias > 80', { steamId: STEAM_ID, alias: 'a'.repeat(81) }],
      ['note > 1000', { steamId: STEAM_ID, note: 'n'.repeat(1001) }],
      ['11 tags', { steamId: STEAM_ID, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
      ['tag > 24', { steamId: STEAM_ID, tags: ['t'.repeat(25)] }],
      ['tag vide après trim', { steamId: STEAM_ID, tags: ['   '] }],
      ['tags dupliqués après trim', { steamId: STEAM_ID, tags: ['duo', ' duo'] }],
      ['tags non tableau', { steamId: STEAM_ID, tags: 'duo' }],
      ['corps tableau', [{ steamId: STEAM_ID }]],
    ])('%s → 400 INVALID_INPUT sans écriture', async (_label, body) => {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(await TrackedPlayerModel.countDocuments()).toBe(0);
    });
  });

  describe('GET liste', () => {
    it('T-08 : liste vide → 200 { items: [] }', async () => {
      const res = await request(app).get(URL_BASE).set(alice.auth);
      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ items: [] });
    });

    it('ne renvoie que les suivis du compte, du plus récent au plus ancien', async () => {
      const first = await create({ steamId: STEAM_ID });
      const second = await create({ steamId: OTHER_STEAM_ID });
      await create({ steamId: STEAM_ID }, bob.auth);

      const res = await request(app).get(URL_BASE).set(alice.auth);
      expect(res.body.items.map((item: { id: string }) => item.id)).toEqual([
        second.body.id,
        first.body.id,
      ]);
    });
  });

  describe('GET / PATCH / DELETE par id', () => {
    let trackedId: string;
    beforeEach(async () => {
      trackedId = (await create({ steamId: STEAM_ID, alias: 'Duo', note: 'note', tags: ['a'] }))
        .body.id;
    });

    it('GET de son propre suivi → 200', async () => {
      const res = await request(app).get(`${URL_BASE}/${trackedId}`).set(alice.auth);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(trackedId);
    });

    it('T-09 : GET / PATCH / DELETE avec le JWT de B → 404, objet intact', async () => {
      const path = `${URL_BASE}/${trackedId}`;
      const responses = await Promise.all([
        request(app).get(path).set(bob.auth),
        request(app).patch(path).set(bob.auth).send({ note: 'piraté' }),
        request(app).delete(path).set(bob.auth),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      const stored = await TrackedPlayerModel.findById(trackedId).lean();
      expect(stored?.note).toBe('note');
    });

    it('404 identique pour un id inexistant', async () => {
      const res = await request(app).get(`${URL_BASE}/507f1f77bcf86cd799439011`).set(alice.auth);
      expect(res.status).toBe(404);
    });

    it('T-12 : PATCH partiel → 200, autres champs préservés, updatedAt avancé', async () => {
      const before = await request(app).get(`${URL_BASE}/${trackedId}`).set(alice.auth);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const res = await request(app)
        .patch(`${URL_BASE}/${trackedId}`)
        .set(alice.auth)
        .send({ note: 'Analyse mise à jour' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ alias: 'Duo', tags: ['a'], note: 'Analyse mise à jour' });
      expect(res.body.createdAt).toBe(before.body.createdAt);
      expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(Date.parse(before.body.updatedAt));
    });

    it('PATCH accepte les chaînes vides et la liste de tags vide', async () => {
      const res = await request(app)
        .patch(`${URL_BASE}/${trackedId}`)
        .set(alice.auth)
        .send({ alias: '', note: '', tags: [] });
      expect(res.body).toMatchObject({ alias: '', note: '', tags: [] });
    });

    it.each([
      ['T-11 PATCH vide', {}],
      ['T-10 ownerId', { ownerId: '507f1f77bcf86cd799439011' }],
      ['T-10 id', { id: '507f1f77bcf86cd799439011' }],
      ['steamId immuable', { steamId: OTHER_STEAM_ID }],
      ['updatedAt', { updatedAt: '2020-01-01T00:00:00Z' }],
      ['T-11 tags incorrects', { tags: ['ok', 'x'.repeat(30)] }],
      ['alias non string', { alias: 42 }],
    ])('%s → 400 INVALID_INPUT', async (_label, body) => {
      const res = await request(app).patch(`${URL_BASE}/${trackedId}`).set(alice.auth).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    it.each(['GET', 'PATCH', 'DELETE'])('T-11 : %s avec id malformé → 400', async (method) => {
      const res = await request(app)
        [method.toLowerCase() as 'get'](`${URL_BASE}/pas-un-id`)
        .set(alice.auth)
        .send({ note: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    it('T-13 : DELETE → 204 sans corps, puis GET → 404', async () => {
      const del = await request(app).delete(`${URL_BASE}/${trackedId}`).set(alice.auth);
      expect(del.status).toBe(204);
      expect(del.text).toBe('');

      const get = await request(app).get(`${URL_BASE}/${trackedId}`).set(alice.auth);
      expect(get.status).toBe(404);
      const again = await request(app).delete(`${URL_BASE}/${trackedId}`).set(alice.auth);
      expect(again.status).toBe(404);
    });

    it('T-14 : les suivis persistent après redémarrage (reconnexion + nouvelle app)', async () => {
      const uri = new URL(process.env.TEST_MONGO_URI as string);
      uri.pathname = `/${mongoose.connection.name}`;

      await mongoose.disconnect();
      await connectMongo(uri.toString(), { runtimeAdapters: { os } });
      app = buildTestApp();

      const res = await request(app).get(URL_BASE).set(alice.auth);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].id).toBe(trackedId);
    });
  });
});
