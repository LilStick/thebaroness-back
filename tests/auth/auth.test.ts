import jwt from 'jsonwebtoken';
import request from 'supertest';
import { UserModel } from '../../src/modules/auth/user.model';
import { buildTestApp, testEnv } from '../helpers/app';
import { useTestDb } from '../helpers/db';

describe('Authentification', () => {
  useTestDb();
  const app = buildTestApp();
  const credentials = { email: 'alice@example.test', password: 'MotDePasse123!' };

  describe('POST /api/auth/register', () => {
    it('T-02 : 201, utilisateur public et vrai JWT, sans hash', async () => {
      const res = await request(app).post('/api/auth/register').send(credentials);

      expect(res.status).toBe(201);
      expect(res.body).toStrictEqual({
        user: { id: expect.stringMatching(/^[a-f\d]{24}$/), email: credentials.email },
        token: expect.any(String),
      });
      const payload = jwt.verify(res.body.token, testEnv.JWT_SECRET) as jwt.JwtPayload;
      expect(payload.sub).toBe(res.body.user.id);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    });

    it('stocke uniquement un hash bcrypt', async () => {
      await request(app).post('/api/auth/register').send(credentials).expect(201);
      const raw = await UserModel.collection.findOne({ email: credentials.email });
      expect(raw?.passwordHash).toMatch(/^\$2b\$/);
      expect(raw).not.toHaveProperty('password');
    });

    it("normalise l'email (trim + minuscules)", async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: '  Alice@Example.TEST ', password: credentials.password });
      expect(res.body.user.email).toBe('alice@example.test');
    });

    it('T-04 : email dupliqué (casse différente) → 409 EMAIL_ALREADY_USED', async () => {
      await request(app).post('/api/auth/register').send(credentials).expect(201);
      const res = await request(app)
        .post('/api/auth/register')
        .send({ ...credentials, email: 'ALICE@example.test' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_USED');
    });

    it.each([
      ['email invalide', { email: 'pas-un-email', password: 'MotDePasse123!' }],
      ['mot de passe trop court', { email: 'a@b.test', password: 'court' }],
      ['mot de passe absent', { email: 'a@b.test' }],
      ['champ inconnu', { ...credentials, role: 'admin' }],
      ['types incorrects', { email: 42, password: true }],
      ['mot de passe > 72 octets', { email: 'a@b.test', password: 'é'.repeat(40) }],
    ])('T-05 : %s → 400 INVALID_INPUT', async (_label, body) => {
      const res = await request(app).post('/api/auth/register').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request(app).post('/api/auth/register').send(credentials).expect(201);
    });

    it('T-03 : identifiants valides → 200, même forme que register', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ ...credentials, email: 'ALICE@example.test' });
      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        user: { id: expect.any(String), email: credentials.email },
        token: expect.any(String),
      });
    });

    it('T-03 : refus uniforme en 401, que le compte existe ou non', async () => {
      const wrongPassword = await request(app)
        .post('/api/auth/login')
        .send({ ...credentials, password: 'MauvaisMotDePasse' });
      const unknownEmail = await request(app)
        .post('/api/auth/login')
        .send({ ...credentials, email: 'inconnu@example.test' });

      for (const res of [wrongPassword, unknownEmail]) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      }
      expect(wrongPassword.body).toStrictEqual(unknownEmail.body);
    });

    it('corps invalide → 400', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'x' });
      expect(res.status).toBe(400);
    });
  });

  describe('Limitation de débit', () => {
    it('au-delà de la limite → 429 RATE_LIMITED avec Retry-After', async () => {
      const limited = buildTestApp({ AUTH_RATE_LIMIT: 2 });
      for (let i = 0; i < 2; i++) {
        await request(limited).post('/api/auth/login').send(credentials);
      }
      const res = await request(limited).post('/api/auth/login').send(credentials);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBeDefined();
    });
  });
});
