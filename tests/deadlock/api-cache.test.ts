import { ApiCacheModel, cached, inflightCacheKeys } from '../../src/database/api-cache';
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

  describe('requêtes simultanées sur une même clé (single-flight)', () => {
    it('une seule lecture source ; chaque appelant reçoit sa propre copie', async () => {
      let release: (v: { list: number[] }) => void = () => {};
      const fetcher = jest.fn(() => new Promise<{ list: number[] }>((r) => (release = r)));
      const calls = Array.from({ length: 5 }, () => cached('sf', { ttlMs: 60_000 }, fetcher));
      // Laisse les 5 lectures Mongo se terminer avant de répondre.
      await new Promise((r) => setTimeout(r, 50));
      expect(inflightCacheKeys()).toEqual(['sf']);
      release({ list: [1, 2] });
      const results = await Promise.all(calls);
      expect(fetcher).toHaveBeenCalledTimes(1);
      results[1]!.data.list.push(3);
      expect(results[0]!.data.list).toEqual([1, 2]);
      expect(results.every((r) => !r.isStale)).toBe(true);
      expect(inflightCacheKeys()).toEqual([]);
    });

    it('échec partagé : chacun applique le repli périmé ; la clé est libérée', async () => {
      await cached('sf2', { ttlMs: 1 }, async () => ({ v: 1 }));
      await new Promise((r) => setTimeout(r, 5));
      // Échec lent : les trois appels sont en attente sur la même lecture.
      const fetcher = jest.fn(
        () => new Promise((_, reject) => setTimeout(() => reject(unavailable()), 50)),
      );
      const results = await Promise.all(
        [1, 2, 3].map(() => cached('sf2', { ttlMs: 60_000 }, fetcher)),
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(results.every((r) => r.isStale && (r.data as { v: number }).v === 1)).toBe(true);
      expect(inflightCacheKeys()).toEqual([]);
      // Nouvel essai possible ensuite.
      await cached('sf2', { ttlMs: 60_000 }, async () => ({ v: 2 }));
      expect((await cached('sf2', { ttlMs: 60_000 }, jest.fn())).data).toEqual({ v: 2 });
    });
  });
});
