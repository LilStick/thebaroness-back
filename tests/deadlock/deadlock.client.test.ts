import { z } from 'zod';
import { DeadlockClient, routeOf } from '../../src/integrations/deadlock/deadlock.client';
import { silentLogger } from '../helpers/app';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const schema = z.array(z.object({ id: z.number() }));

describe('DeadlockClient', () => {
  let upstream: FetchMock;
  const client = (options: Partial<ConstructorParameters<typeof DeadlockClient>[0]> = {}) =>
    new DeadlockClient({
      baseUrl: 'https://deadlock.test',
      fetch: upstream.fetch,
      logger: silentLogger,
      ...options,
    });

  beforeEach(() => {
    upstream = createFetchMock();
  });

  it('GET valide → données parsées, query triée et sans valeurs undefined', async () => {
    upstream.on(/^\/v1\/items$/, { body: [{ id: 1, extra: 'ignoré' }] });
    const data = await client().get('/v1/items', { z: 1, a: 'x', skip: undefined }, schema);
    expect(data).toEqual([{ id: 1 }]);
    expect(upstream.calls[0]?.search).toBe('?a=x&z=1');
  });

  it("envoie la clé API en en-tête, jamais dans l'URL", async () => {
    let seen: string | null = null;
    const spy: typeof fetch = async (input, init) => {
      seen = new Headers(init?.headers).get('x-api-key');
      return upstream.fetch(input, init);
    };
    upstream.on(/items/, { body: [] });
    await client({ apiKey: 'secret-key', fetch: spy }).get('/v1/items', {}, schema);
    expect(seen).toBe('secret-key');
    expect(upstream.calls[0]?.toString()).not.toContain('secret-key');
  });

  it('404 du fournisseur → null', async () => {
    upstream.on(/items/, { status: 404 });
    await expect(client().get('/v1/items', {}, schema)).resolves.toBeNull();
  });

  it('déduplique les requêtes identiques simultanées', async () => {
    upstream.on(/items/, { body: [{ id: 1 }], delayMs: 20 });
    const c = client();
    const [a, b] = await Promise.all([
      c.get('/v1/items', { q: 1 }, schema),
      c.get('/v1/items', { q: 1 }, schema),
    ]);
    expect(a).toBe(b);
    expect(upstream.calls).toHaveLength(1);
  });

  it('limite la concurrence', async () => {
    let active = 0;
    let peak = 0;
    const slow: typeof fetch = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };
    const c = client({ fetch: slow, maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => c.get('/v1/items', { i }, schema)));
    expect(peak).toBe(2);
  });

  it.each([
    ['timeout', { delayMs: 200 }, 503, 'SERVICE_UNAVAILABLE'],
    ['erreur réseau', { networkError: true }, 503, 'SERVICE_UNAVAILABLE'],
    ['503 fournisseur', { status: 503 }, 503, 'SERVICE_UNAVAILABLE'],
    ['429 fournisseur', { status: 429 }, 503, 'SERVICE_UNAVAILABLE'],
    ['500 fournisseur', { status: 500 }, 502, 'UPSTREAM_ERROR'],
    ['JSON invalide', { body: undefined, status: 200 }, 502, 'UPSTREAM_ERROR'],
    ['format inattendu', { body: [{ id: 'pas-un-nombre' }] }, 502, 'UPSTREAM_ERROR'],
  ])('%s → %i %s', async (_label, response, status, code) => {
    upstream.on(/items/, response);
    await expect(client({ timeoutMs: 30 }).get('/v1/items', {}, schema)).rejects.toMatchObject({
      status,
      code,
    });
  });

  it("n'expose ni URL ni clé dans le message d'erreur", async () => {
    upstream.on(/items/, { status: 500 });
    const error = await client({ apiKey: 'k3y' })
      .get('/v1/items', {}, schema)
      .catch((e: Error) => e);
    expect((error as Error).message).not.toMatch(/deadlock\.test|k3y|\/v1/);
  });

  it('respecte Retry-After : échec immédiat sans appel pendant le délai', async () => {
    upstream.on(/items/, { status: 503, headers: { 'retry-after': '30' } });
    const c = client();
    await expect(c.get('/v1/items', {}, schema)).rejects.toMatchObject({ retryAfter: 30 });

    const second = await c.get('/v1/items', { other: 1 }, schema).catch((e) => e);
    expect(second).toMatchObject({ status: 503 });
    expect(second.retryAfter).toBeGreaterThan(29);
    expect(upstream.calls).toHaveLength(1);
  });

  it('Retry-After bloque seulement la route concernée (quotas par route)', async () => {
    upstream
      .on(/\/v1\/players\/rank$/, { status: 429, headers: { 'retry-after': '30' } })
      .on(/match-history$/, { status: 429, headers: { 'retry-after': '30' } })
      .on(/search$/, { body: [{ id: 1 }] });
    const c = client();
    await expect(c.get('/v1/players/rank', {}, schema)).rejects.toMatchObject({ status: 503 });
    // Autre route : appel normal.
    await expect(c.get('/v1/players/search', {}, schema)).resolves.toEqual([{ id: 1 }]);
    // Même route, autre identifiant : bloquée sans appel.
    await expect(c.get('/v1/players/1/match-history', {}, schema)).rejects.toMatchObject({
      status: 503,
    });
    const before = upstream.calls.length;
    await expect(c.get('/v1/players/2/match-history', {}, schema)).rejects.toMatchObject({
      retryAfter: expect.any(Number),
    });
    expect(upstream.calls.length).toBe(before);
    expect(routeOf('/v1/matches/123/metadata')).toBe('/v1/matches/:id/metadata');
  });
});
