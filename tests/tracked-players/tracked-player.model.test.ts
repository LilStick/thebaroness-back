import { Types } from 'mongoose';
import {
  TrackedPlayerModel,
  toTrackedPlayerDto,
} from '../../src/modules/tracked-players/tracked-player.model';
import { useTestDb } from '../helpers/db';

describe('Modèle TrackedPlayer', () => {
  useTestDb();

  const ownerA = new Types.ObjectId();
  const ownerB = new Types.ObjectId();
  const steamId = '76561198000000000';

  it('crée un suivi avec valeurs par défaut et timestamps', async () => {
    const doc = await TrackedPlayerModel.create({ ownerId: ownerA, steamId });
    expect(doc.alias).toBe('');
    expect(doc.note).toBe('');
    expect(doc.tags).toEqual([]);
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  it('refuse un doublon pour le même propriétaire (index unique)', async () => {
    await TrackedPlayerModel.create({ ownerId: ownerA, steamId });
    await expect(TrackedPlayerModel.create({ ownerId: ownerA, steamId })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('autorise deux propriétaires différents à suivre le même joueur', async () => {
    await TrackedPlayerModel.create({ ownerId: ownerA, steamId });
    await expect(TrackedPlayerModel.create({ ownerId: ownerB, steamId })).resolves.toBeDefined();
  });

  it('déclare les index attendus', async () => {
    const indexes = await TrackedPlayerModel.collection.indexes();
    const keys = indexes.map((index) => ({ key: index.key, unique: index.unique ?? false }));
    expect(keys).toEqual(
      expect.arrayContaining([
        { key: { ownerId: 1, steamId: 1 }, unique: true },
        { key: { ownerId: 1, updatedAt: -1 }, unique: false },
      ]),
    );
  });

  it('conserve steamId en chaîne sans perte de précision', async () => {
    const big = '76561198999999999';
    const doc = await TrackedPlayerModel.create({ ownerId: ownerA, steamId: big });
    const raw = await TrackedPlayerModel.collection.findOne({ _id: doc._id });
    expect(raw?.steamId).toBe(big);
  });

  it('sérialise un DTO sans ownerId ni _id', async () => {
    const doc = await TrackedPlayerModel.create({
      ownerId: ownerA,
      steamId,
      alias: 'Duo',
      tags: ['ranked'],
    });
    const dto = toTrackedPlayerDto(doc);
    expect(dto).toStrictEqual({
      id: doc._id.toHexString(),
      steamId,
      alias: 'Duo',
      note: '',
      tags: ['ranked'],
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    });
  });
});
