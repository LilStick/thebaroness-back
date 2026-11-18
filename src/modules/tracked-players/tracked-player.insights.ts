import { AppError } from '../../shared/errors';
import { mapLimit } from '../../shared/metrics';
import type { PlayersService } from '../players/players.service';
import { trackedPlayerService } from './tracked-player.service';

/** Suivis enrichis au plus par requête (au-delà : `truncated`). */
export const INSIGHTS_MAX = 100;
/** Joueurs chargés simultanément (le client Deadlock plafonne en plus à 8 appels sortants). */
export const INSIGHTS_CONCURRENCY = 4;

export type InsightStatus = 'ok' | 'partial' | 'not_found' | 'unavailable';

/**
 * Insights groupés des suivis d'un utilisateur : une carte par suivi, construite depuis le cache
 * partagé profil/historique. Un joueur en échec n'invalide jamais la liste : il porte son
 * propre `status` et `error`.
 */
export function createTrackedInsightsService(players: Pick<PlayersService, 'card'>) {
  return async function insights(ownerId: string) {
    const tracked = await trackedPlayerService.list(ownerId);
    const selected = tracked.slice(0, INSIGHTS_MAX);
    const items = await mapLimit(selected, INSIGHTS_CONCURRENCY, async (t) => {
      const base = { trackedPlayerId: t.id, steamId: t.steamId, alias: t.alias, tags: t.tags };
      try {
        const card = await players.card(t.steamId);
        return {
          ...base,
          status: (card.meta.isPartial ? 'partial' : 'ok') as InsightStatus,
          ...card,
          error: null,
        };
      } catch (error) {
        const known = error instanceof AppError ? error : null;
        return {
          ...base,
          status: (known?.status === 404 ? 'not_found' : 'unavailable') as InsightStatus,
          player: null,
          rank: null,
          lastMatchAt: null,
          form: null,
          meta: null,
          error: {
            code: known?.code ?? 'SERVICE_UNAVAILABLE',
            message: known?.message ?? 'Données de ce joueur temporairement indisponibles.',
          },
        };
      }
    });
    const fetched = items.flatMap((i) => (i.meta ? [i.meta] : []));
    return {
      items,
      total: tracked.length,
      truncated: tracked.length > INSIGHTS_MAX,
      meta: {
        fetchedAt: fetched.length
          ? new Date(Math.min(...fetched.map((m) => Date.parse(m.fetchedAt)))).toISOString()
          : new Date().toISOString(),
        sourceUpdatedAt: null,
        isStale: fetched.some((m) => m.isStale),
        isPartial: items.some((i) => i.status !== 'ok') || tracked.length > INSIGHTS_MAX,
      },
    };
  };
}

export type TrackedInsights = ReturnType<typeof createTrackedInsightsService>;
