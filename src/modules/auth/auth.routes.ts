import { Router } from 'express';
import { parse } from '../../shared/validation';
import { loginSchema, registerSchema } from './auth.schemas';
import type { AuthService } from './auth.service';

export function createAuthRouter(auth: AuthService): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
    res.status(201).json(await auth.register(parse(registerSchema, req.body)));
  });

  router.post('/login', async (req, res) => {
    res.json(await auth.login(parse(loginSchema, req.body)));
  });

  return router;
}
