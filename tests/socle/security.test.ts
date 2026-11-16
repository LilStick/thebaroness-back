import { Writable } from 'node:stream';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../../src/app';
import { TrackedPlayerModel } from '../../src/modules/tracked-players/tracked-player.model';
import { buildTestApp, createUser, testEnv } from '../helpers/app';
import { useTestDb } from '../helpers/db';

/** Logger qui capture les lignes JSON émises. */
function capturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
}

describe('Durcissement HTTP', () => {
  useTestDb();

  it('en-têtes de sécurité helmet et identifiant de requête', async () => {
    const res = await request(buildTestApp()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('limite globale par IP → 429 RATE_LIMITED', async () => {
    const app = buildTestApp({ API_RATE_LIMIT: 2 });
    await request(app).get('/api/players/search').query({ q: '' });
    await request(app).get('/api/players/search').query({ q: '' });
    const res = await request(app).get('/api/players/search').query({ q: '' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('/api/health échappe à la limite globale (sondes Docker)', async () => {
    const app = buildTestApp({ API_RATE_LIMIT: 1 });
    for (let i = 0; i < 3; i++) await request(app).get('/api/health').expect(200);
  });

  it('limite stricte sur /api/auth/*', async () => {
    const app = buildTestApp({ AUTH_RATE_LIMIT: 2 });
    await request(app).get('/api/auth/me');
    await request(app).get('/api/auth/me');
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(429);
  });

  it('journal sans jeton, sans query string ni en-têtes sensibles', async () => {
    const { logger, lines } = capturingLogger();
    const app = createApp({ env: testEnv, logger, fetch: () => Promise.reject(new Error('x')) });
    const { token, auth } = await createUser();

    await request(app).get('/api/tracked-players').set(auth);
    await request(app).get('/api/auth/steam/callback?state=abc&openid.sig=SIGNATURE');

    const journal = lines.join('\n');
    expect(journal).toContain('/api/tracked-players');
    expect(journal).toContain('/api/auth/steam/callback');
    expect(journal).not.toContain(token);
    expect(journal).not.toMatch(/authorization|Bearer|SIGNATURE|openid\.|location/i);
    expect(lines.every((line) => JSON.parse(line))).toBe(true);
  });

  it('erreur interne journalisée avec stack côté serveur, message générique côté client', async () => {
    const { logger, lines } = capturingLogger();
    const app = createApp({ env: testEnv, logger });
    const { auth } = await createUser();
    // Simule une panne Mongo pendant la requête.
    const spy = jest.spyOn(TrackedPlayerModel, 'find').mockImplementation(() => {
      throw new Error('connexion perdue');
    });

    const res = await request(app).get('/api/tracked-players').set(auth);
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Une erreur interne est survenue.' },
    });
    expect(lines.join('\n')).toContain('connexion perdue');
  });
});
