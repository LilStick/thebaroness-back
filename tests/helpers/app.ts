import pino from 'pino';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { parseEnv, type Env } from '../../src/config/env';

export const testEnv: Env = parseEnv({
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/unused',
  JWT_SECRET: 'test-secret-'.padEnd(48, 'x'),
  JWT_EXPIRES_IN: '15m',
  BCRYPT_ROUNDS: '4',
  AUTH_RATE_LIMIT: '1000',
  LOG_LEVEL: 'silent',
});

export const silentLogger = pino({ level: 'silent' });

export function buildTestApp(overrides: Partial<Env> = {}) {
  return createApp({ env: { ...testEnv, ...overrides }, logger: silentLogger });
}

let counter = 0;

/** Inscrit un compte de test et renvoie son jeton et son identifiant. */
export async function registerUser(app: Express, email = `user${++counter}@example.test`) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'MotDePasse123!' })
    .expect(201);
  return {
    token: res.body.token as string,
    userId: res.body.user.id as string,
    email,
    auth: { Authorization: `Bearer ${res.body.token as string}` },
  };
}
