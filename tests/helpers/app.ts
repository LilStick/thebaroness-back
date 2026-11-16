import pino from 'pino';
import { Types } from 'mongoose';
import { createApp } from '../../src/app';
import { parseEnv, type Env } from '../../src/config/env';
import { signAccessToken } from '../../src/modules/auth/jwt';
import { UserModel } from '../../src/modules/auth/user.model';

export const testEnv: Env = parseEnv({
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/unused',
  JWT_SECRET: 'test-secret-'.padEnd(48, 'x'),
  JWT_EXPIRES_IN: '15m',
  API_PUBLIC_URL: 'http://api.test',
  FRONT_URL: 'http://front.test',
  DEADLOCK_API_BASE_URL: 'https://deadlock.test',
  CORS_ORIGIN: 'http://front.test',
  AUTH_RATE_LIMIT: '1000',
  API_RATE_LIMIT: '100000',
  LOG_LEVEL: 'silent',
});

export const silentLogger = pino({ level: 'silent' });

export function buildTestApp(overrides: Partial<Env> = {}, fetchImpl?: typeof fetch) {
  return createApp({
    env: { ...testEnv, ...overrides },
    logger: silentLogger,
    fetch: fetchImpl ?? (() => Promise.reject(new Error('fetch non mocké dans ce test'))),
  });
}

let counter = 0;

/**
 * Crée directement un utilisateur en base (comme après une connexion Steam réussie)
 * et renvoie un JWT valide pour lui.
 */
export async function createUser(steamId = String(76561198000000000n + BigInt(++counter))) {
  const user = await UserModel.create({
    _id: new Types.ObjectId(),
    steamId,
    displayName: `Joueur ${steamId.slice(-4)}`,
    lastLoginAt: new Date(),
  });
  const userId = user._id.toHexString();
  const token = signAccessToken(userId, { secret: testEnv.JWT_SECRET, expiresIn: '15m' });
  return { userId, steamId, token, auth: { Authorization: `Bearer ${token}` } };
}
