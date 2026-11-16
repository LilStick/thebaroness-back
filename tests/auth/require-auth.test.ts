import express from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import request from 'supertest';
import { errorHandler } from '../../src/middleware/error-handler';
import { getUserId, requireAuth } from '../../src/middleware/require-auth';
import { signAccessToken } from '../../src/modules/auth/jwt';
import { silentLogger, testEnv } from '../helpers/app';

const secret = testEnv.JWT_SECRET;
const userId = new Types.ObjectId().toHexString();

const app = express();
app.get('/private', requireAuth(secret), (req, res) => {
  res.json({ userId: getUserId(req) });
});
app.use(errorHandler(silentLogger));

const call = (authorization?: string) => {
  const req = request(app).get('/private');
  return authorization === undefined ? req : req.set('Authorization', authorization);
};

describe('requireAuth', () => {
  it('jeton valide → accès et userId issu du JWT', async () => {
    const token = signAccessToken(userId, { secret, expiresIn: '5m' });
    const res = await call(`Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId });
  });

  const cases: Array<[string, () => string | undefined]> = [
    ['en-tête absent', () => undefined],
    [
      'schéma autre que Bearer',
      () => `Basic ${signAccessToken(userId, { secret, expiresIn: '5m' })}`,
    ],
    ['jeton malformé', () => 'Bearer pas.un.jwt!'],
    [
      'jeton expiré',
      () => `Bearer ${jwt.sign({ typ: 'access' }, secret, { subject: userId, expiresIn: -10 })}`,
    ],
    [
      'signé avec une autre clé',
      () => `Bearer ${signAccessToken(userId, { secret: 'y'.repeat(40), expiresIn: '5m' })}`,
    ],
    [
      'algorithme none',
      () => `Bearer ${jwt.sign({ typ: 'access', sub: userId }, '', { algorithm: 'none' })}`,
    ],
    [
      'algorithme inattendu (HS512)',
      () =>
        `Bearer ${jwt.sign({ typ: 'access' }, secret, { subject: userId, algorithm: 'HS512' })}`,
    ],
    [
      'type de jeton incorrect',
      () => `Bearer ${jwt.sign({ typ: 'refresh' }, secret, { subject: userId })}`,
    ],
    [
      'sub non ObjectId',
      () => `Bearer ${jwt.sign({ typ: 'access' }, secret, { subject: 'admin' })}`,
    ],
  ];

  it.each(cases)('%s → 401 UNAUTHORIZED', async (_label, header) => {
    const res = await call(header());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
