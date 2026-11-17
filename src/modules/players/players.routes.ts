import { Router } from 'express';
import { z } from 'zod';
import { steamIdSchema } from '../../shared/schemas';
import { parse } from '../../shared/validation';
import type { PlayersService } from './players.service';
import {
  activityQuerySchema,
  historyFilterSchema,
  overviewQuerySchema,
  rankHistoryQuerySchema,
  relationshipsQuerySchema,
  trendsQuerySchema,
} from './profile-stats';

const searchQuerySchema = z.object({
  q: z
    .string('q : requis')
    .trim()
    .min(1, 'q : recherche vide')
    .max(64, 'q : 64 caractères maximum'),
});

const matchesQuerySchema = historyFilterSchema.extend({
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
    const steamId = parse(steamIdSchema, req.params.steamId);
    const filter = parse(historyFilterSchema.omit({ heroId: true, outcome: true }), req.query);
    res.json(await players.heroes(steamId, { ...filter, outcome: 'all' }));
  });

  // Historique de rang observé (parties classées au badge connu), période par défaut : saison.
  router.get('/:steamId/rank-history', async (req, res) => {
    const steamId = parse(steamIdSchema, req.params.steamId);
    const { period } = parse(rankHistoryQuerySchema, req.query);
    res.json(await players.rankHistory(steamId, period));
  });

  // Coéquipiers et adversaires fréquents (agrégats Deadlock API).
  router.get('/:steamId/relationships', async (req, res) => {
    const steamId = parse(steamIdSchema, req.params.steamId);
    res.json(await players.relationships(steamId, parse(relationshipsQuerySchema, req.query)));
  });

  // Tendances : N dernières parties contre les N précédentes (défaut 20).
  router.get('/:steamId/trends', async (req, res) => {
    const steamId = parse(steamIdSchema, req.params.steamId);
    res.json(await players.trends(steamId, parse(trendsQuerySchema, req.query)));
  });

  // Activité par jour UTC (heatmap), 12 semaines par défaut.
  router.get('/:steamId/activity', async (req, res) => {
    const steamId = parse(steamIdSchema, req.params.steamId);
    res.json(await players.activity(steamId, parse(activityQuerySchema, req.query)));
  });

  // Profil V2 : agrégats d'une période (défaut 30d), modes observés, top héros, couverture.
  router.get('/:steamId/overview', async (req, res) => {
    const steamId = parse(steamIdSchema, req.params.steamId);
    res.json(await players.overview(steamId, parse(overviewQuerySchema, req.query)));
  });

  router.get('/:steamId/matches', async (req, res) => {
    const steamId = parse(steamIdSchema, req.params.steamId);
    const { limit, cursor, ...filter } = parse(matchesQuerySchema, req.query);
    res.json(await players.matches(steamId, limit, cursor, filter));
  });

  return router;
}
