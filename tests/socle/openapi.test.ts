import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { renderOpenApiYaml } from '../../scripts/openapi-yaml';
import { openApiDocument } from '../../src/docs/openapi';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';

const app = buildTestApp();
const METHODS = ['get', 'post', 'patch', 'delete'] as const;

/** Toutes les opérations documentées, avec des paramètres de chemin factices valides. */
const operations = Object.entries(openApiDocument.paths ?? {}).flatMap(([path, item]) =>
  METHODS.filter((method) => item?.[method]).map((method) => ({
    method,
    path: path
      .replace('{steamId}', '76561198957316510')
      .replace('{id}', '507f1f77bcf86cd799439011'),
  })),
);

describe('Contrat OpenAPI', () => {
  useTestDb();

  it('docs/openapi.yaml est synchronisé avec src/docs/openapi.ts (npm run openapi)', () => {
    const committed = readFileSync(resolve(__dirname, '../../docs/openapi.yaml'), 'utf8');
    expect(committed).toBe(renderOpenApiYaml());
  });

  it('documente au moins les 12 opérations implémentées', () => {
    expect(operations.length).toBeGreaterThanOrEqual(12);
  });

  it.each(operations)('NF-12 : $method $path existe réellement', async ({ method, path }) => {
    const res = await request(app)[method](`/api${path}`);
    // Une route absente renverrait le 404 générique du routeur.
    expect(res.body?.error?.message).not.toBe('Route introuvable.');
  });

  it('GET /api/openapi.json sert le contrat', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.info.version).toBe(openApiDocument.info.version);
  });

  it('GET /api/docs/ sert Swagger UI avec une CSP adaptée', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
