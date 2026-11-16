import mongoose from 'mongoose';
import { useTestDb } from '../helpers/db';
import { createFetchMock } from '../helpers/fetch-mock';

describe('Base Mongo de test', () => {
  useTestDb();

  it('se connecte à une base isolée', () => {
    expect(mongoose.connection.readyState).toBe(1);
    expect(mongoose.connection.name).toMatch(/^test-/);
  });

  it('écrit dans la base', async () => {
    await mongoose.connection.collection('probe').insertOne({ ok: true });
    expect(await mongoose.connection.collection('probe').countDocuments()).toBe(1);
  });

  it('repart vide après chaque test', async () => {
    expect(await mongoose.connection.collection('probe').countDocuments()).toBe(0);
  });
});

describe('fetch mock', () => {
  it('répond selon la route et trace les appels', async () => {
    const mock = createFetchMock().on(/^\/v1\/ping$/, { body: { pong: true } });
    const res = await mock.fetch('https://upstream.test/v1/ping?x=1');
    expect(await res.json()).toEqual({ pong: true });
    expect(mock.calls[0]?.searchParams.get('x')).toBe('1');
  });

  it('simule erreurs réseau et statuts', async () => {
    const mock = createFetchMock()
      .on(/down/, { networkError: true })
      .on(/busy/, { status: 503, headers: { 'retry-after': '2' } });
    await expect(mock.fetch('https://u.test/down')).rejects.toThrow('fetch failed');
    const res = await mock.fetch('https://u.test/busy');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it("respecte l'annulation par AbortSignal", async () => {
    const mock = createFetchMock().on(/slow/, { delayMs: 1_000 });
    const pending = mock.fetch('https://u.test/slow', { signal: AbortSignal.timeout(20) });
    await expect(pending).rejects.toThrow();
  });
});
