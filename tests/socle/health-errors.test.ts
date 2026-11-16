import request from 'supertest';
import { buildTestApp } from '../helpers/app';

const app = buildTestApp();

describe('GET /api/health (T-01)', () => {
  it('répond 200 avec exactement { status: "ok" }', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ status: 'ok' });
  });

  it("n'expose pas l'en-tête x-powered-by", async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe("Format d'erreur homogène", () => {
  it('route inconnue → 404 NOT_FOUND', async () => {
    const res = await request(app).get('/api/inexistant');
    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('JSON malformé → 400 INVALID_INPUT sans détail technique', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"oups":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js|SyntaxError/);
  });

  it('corps trop volumineux → 413 INVALID_INPUT', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(20_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });
});
