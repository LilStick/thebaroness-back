import type { Logger } from 'pino';
import { AppError } from '../shared/errors';
import { GroupModel } from '../modules/groups/group.model';
import type { PlayersService } from '../modules/players/players.service';
import { TrackedPlayerModel } from '../modules/tracked-players/tracked-player.model';

/** Joueurs actualisés en parallèle : laisse l'essentiel du quota Deadlock aux visiteurs. */
const DEFAULT_CONCURRENCY = 2;

export interface RefreshWorkerOptions {
  players: Pick<PlayersService, 'member'>;
  logger: Logger;
  intervalMs: number;
  concurrency?: number;
}

export interface CycleReport {
  players: number;
  refreshed: number;
  failed: number;
  /** Cycle interrompu : fournisseur limité ou en panne, ou arrêt demandé. */
  aborted: boolean;
}

/** Joueurs suivis et membres de groupes de tous les comptes, sans doublon. */
export async function playersToRefresh(): Promise<string[]> {
  const [tracked, members] = await Promise.all([
    TrackedPlayerModel.distinct('steamId'),
    GroupModel.distinct('steamIds'),
  ]);
  return [...new Set([...(tracked as string[]), ...(members as string[])])].sort();
}

/** Le fournisseur demande d'attendre, ou une copie périmée a été servie faute de réponse. */
const isUpstreamTrouble = (error: unknown) =>
  error instanceof AppError && (error.status === 502 || error.status === 503);

/**
 * Préchauffe périodiquement le cache (profil Steam, historique) des joueurs suivis et des
 * membres de groupes. Passe par le cache normal : une copie encore fraîche ne coûte aucun
 * appel. Cycles enchaînés par `setTimeout` (jamais de chevauchement) ; le cycle s'arrête
 * dès que Deadlock API est limité ou indisponible, pour ne pas aggraver la situation.
 */
export function createRefreshWorker({
  players,
  logger,
  intervalMs,
  concurrency = DEFAULT_CONCURRENCY,
}: RefreshWorkerOptions) {
  const log = logger.child({ job: 'refresh-worker' });
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<CycleReport> | undefined;
  let started = false;
  /** Arrêt demandé : le cycle en cours ne prend plus de nouveau joueur. */
  let stopped = false;

  async function runOnce(): Promise<CycleReport> {
    const queue = await playersToRefresh();
    const report: CycleReport = { players: queue.length, refreshed: 0, failed: 0, aborted: false };
    const started = Date.now();

    const lane = async () => {
      for (let steamId = queue.shift(); steamId; steamId = queue.shift()) {
        if (report.aborted) return;
        try {
          const { profile, history } = await players.member(steamId);
          if (profile.isStale || history.isStale) {
            report.aborted = true;
          } else {
            report.refreshed += 1;
          }
        } catch (error) {
          report.failed += 1;
          if (isUpstreamTrouble(error)) report.aborted = true;
          else log.warn({ steamId, err: error }, 'Actualisation impossible');
        }
        if (stopped) report.aborted = true;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));

    log.info({ ...report, durationMs: Date.now() - started }, 'Cycle de préchauffage terminé');
    return report;
  }

  const schedule = (delayMs: number) => {
    timer = setTimeout(() => {
      current = runOnce()
        .catch((error: unknown) => {
          log.error({ err: error }, 'Cycle de préchauffage en échec');
          return { players: 0, refreshed: 0, failed: 0, aborted: true };
        })
        .finally(() => {
          current = undefined;
          if (started) schedule(intervalMs);
        });
    }, delayMs);
    // Ne retient pas le processus : l'arrêt reste piloté par le serveur HTTP.
    timer.unref();
  };

  return {
    runOnce,
    /** Premier cycle immédiat, puis toutes les `intervalMs` après la fin du précédent. */
    start() {
      if (started) return;
      started = true;
      stopped = false;
      schedule(0);
      log.info({ intervalMs, concurrency }, 'Worker de préchauffage démarré');
    },
    /** Annule le prochain cycle et attend la fin de celui en cours. */
    async stop() {
      started = false;
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}

export type RefreshWorker = ReturnType<typeof createRefreshWorker>;
