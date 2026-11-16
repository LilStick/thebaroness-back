import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createServices } from './app';
import { parseEnv } from './config/env';
import { connectMongo, disconnectMongo } from './database/mongo';
import { HEARTBEAT_FILE, createRefreshWorker } from './jobs/refresh-worker';
import { createLogger } from './shared/logger';

/**
 * Conteneur `worker` : préchauffage du cache seul, sans serveur HTTP.
 * Même image et mêmes variables que l'API ; `REFRESH_WORKER_ENABLED` n'est lu que par l'API.
 * Healthcheck : âge du fichier {@link HEARTBEAT_FILE}, réécrit au démarrage et à chaque cycle.
 */
async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL);

  await connectMongo(env.MONGODB_URI);
  logger.info('Connexion MongoDB établie');

  const beat = () => writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
  const { players } = createServices({ env, logger });
  const worker = createRefreshWorker({
    players,
    logger,
    intervalMs: env.REFRESH_INTERVAL_MS,
    onCycleEnd: beat,
  });
  beat();
  worker.start();
  // Le timer du worker ne retient pas le processus : on le garde vivant jusqu'au signal.
  const keepAlive = setInterval(() => undefined, 1 << 30);

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Arrêt du worker');
    clearInterval(keepAlive);
    void worker
      .stop()
      .then(disconnectMongo)
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
