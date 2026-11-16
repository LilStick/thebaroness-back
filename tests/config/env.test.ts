import { parseEnv } from '../../src/config/env';

const validEnv = {
  MONGODB_URI: 'mongodb://localhost:27017/test',
  JWT_SECRET: 'x'.repeat(32),
};

describe('parseEnv', () => {
  it('applique les valeurs par défaut', () => {
    const env = parseEnv(validEnv);
    expect(env.PORT).toBe(3001);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGIN).toEqual(['http://localhost:5173']);
    expect(env.DEADLOCK_API_KEY).toBeUndefined();
  });

  it('découpe plusieurs origines CORS', () => {
    const env = parseEnv({ ...validEnv, CORS_ORIGIN: 'http://a.test, http://b.test' });
    expect(env.CORS_ORIGIN).toEqual(['http://a.test', 'http://b.test']);
  });

  it('refuse un JWT_SECRET trop court sans afficher sa valeur', () => {
    const secret = 'zzSecretCourt';
    expect(() => parseEnv({ ...validEnv, JWT_SECRET: secret })).toThrow(/JWT_SECRET/);
    expect(() => parseEnv({ ...validEnv, JWT_SECRET: secret })).not.toThrow(secret);
  });

  it('refuse une configuration sans MONGODB_URI', () => {
    expect(() => parseEnv({ JWT_SECRET: 'x'.repeat(32) })).toThrow(/MONGODB_URI/);
  });
});
