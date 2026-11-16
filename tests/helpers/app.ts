import pino from 'pino';
import { createApp } from '../../src/app';
import { parseEnv, type Env } from '../../src/config/env';

export const testEnv: Env = parseEnv({
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/unused',
  JWT_SECRET: 'test-secret-'.padEnd(48, 'x'),
  JWT_EXPIRES_IN: '15m',
  LOG_LEVEL: 'silent',
});

export const silentLogger = pino({ level: 'silent' });

export function buildTestApp(overrides: Partial<Env> = {}) {
  return createApp({ env: { ...testEnv, ...overrides }, logger: silentLogger });
}
