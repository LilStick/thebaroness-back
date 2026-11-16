import { ApiCacheModel, cached } from '../../src/database/api-cache';
import { AppError } from '../../src/shared/errors';
import { useTestDb } from '../helpers/db';

describe('cache api_cache', () => {
  useTestDb();

  const unavailable = () => new AppError(503, 'SERVICE_UNAVAILABLE', 'indisponible');

  it("premier appel : interroge le fournisseur et écrit l'entrée", async () => {
    const fetcher = jest.fn().mockResolvedValue({ v: 1 });
    const result = await cached('k', { ttlMs: 60_000 }, fetcher);

    expect(result).toMatchObject({ data: { v: 1 }, isStale: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const entry = await ApiCacheModel.findOne({ key: 'k' }).lean();
    expect(entry?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(entry?.purgeAt.getTime()).toBeGreaterThan(entry?.expiresAt.getTime() ?? 0);
  });

  it('copie fraîche : aucun appel au fournisseur', async () => {
    await cached('k', { ttlMs: 60_000 }, async () => ({ v: 1 }));
    const fetcher = jest.fn();
    const result = await cached('k', { ttlMs: 60_000 }, fetcher);
    expect(result.data).toEqual({ v: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('copie expirée : rafraîchie', async () => {
    await cached('k', { ttlMs: -1 }, async () => ({ v: 1 }));
    const result = await cached('k', { ttlMs: 60_000 }, async () => ({ v: 2 }));
    expect(result).toMatchObject({ data: { v: 2 }, isStale: false });
  });

  it('T-16 : fournisseur indisponible + copie expirée → copie périmée (isStale)', async () => {
    const first = await cached('k', { ttlMs: -1 }, async () => ({ v: 1 }));
    const result = await cached('k', { ttlMs: 60_000 }, async () => {
      throw unavailable();
    });
    expect(result).toEqual({ data: { v: 1 }, fetchedAt: first.fetchedAt, isStale: true });
  });

  it('T-16 : fournisseur indisponible sans copie → erreur propagée', async () => {
    await expect(
      cached('absent', { ttlMs: 60_000 }, async () => {
        throw unavailable();
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('erreur non liée au fournisseur → propagée même avec une copie', async () => {
    await cached('k', { ttlMs: -1 }, async () => ({ v: 1 }));
    await expect(
      cached('k', { ttlMs: 60_000 }, async () => {
        throw new Error('bug');
      }),
    ).rejects.toThrow('bug');
  });

  it("déclare l'index TTL de purge et l'unicité de la clé", async () => {
    const indexes = await ApiCacheModel.collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { key: 1 }, unique: true }),
        expect.objectContaining({ key: { purgeAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
  });

  it('conserve les tableaux et objets vides', async () => {
    await cached('vide', { ttlMs: 60_000 }, async () => ({ items: [], extra: {} }));
    const result = await cached('vide', { ttlMs: 60_000 }, jest.fn());
    expect(result.data).toEqual({ items: [], extra: {} });
  });
});
