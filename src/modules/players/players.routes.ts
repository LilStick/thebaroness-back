import { Router } from 'express';
import { z } from 'zod';
import { steamIdSchema } from '../../shared/schemas';
import { parse } from '../../shared/validation';
import type { PlayersService } from './players.service';

const searchQuerySchema = z.object({
  q: z
    .string('q : requis')
    .trim()
    .min(1, 'q : recherche vide')
    .max(64, 'q : 64 caractères maximum'),
});

const matchesQuerySchema = z.object({
  limit: z.coerce
    .number('limit : entier attendu')
    .int('limit : entier attendu')
    .min(1, 'limit : entre 1 et 50')
    .max(50, 'limit : entre 1 et 50')
    .default(20),
  cursor: z.string().max(128, 'cursor : curseur invalide').optional(),
});

export function createPlayersRouter(players: PlayersService): Router {
  const router = Router();

  router.get('/search', async (req, res) => {
    const { q } = parse(searchQuerySchema, req.query);
    res.json(await players.search(q));
  });

  router.get('/:steamId', async (req, res) => {
    res.json(await players.profile(parse(steamIdSchema, req.params.steamId)));
  });

  // Refresh forcé (délai minimum de 60 s par joueur) : même réponse que GET /:steamId.
  router.post('/:steamId/refresh', async (req, res) => {
    const steamId = parse(steamIdSchema, req.params.steamId);
    res.json(await players.profile(steamId, { refresh: true }));
  });

  router.get('/:steamId/heroes', async (req, res) => {
    res.json(await players.heroes(parse(steamIdSchema, req.params.steamId)));
  });

  router.get('/:steamId/matches', async (req, res) => {
    const steamId = parse(steamIdSchema, req.params.steamId);
    const { limit, cursor } = parse(matchesQuerySchema, req.query);
    res.json(await players.matches(steamId, limit, cursor));
  });

  return router;
}
