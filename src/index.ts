import 'dotenv/config';
import { createApp } from './app';
import { parseEnv } from './config/env';
import { connectMongo, disconnectMongo } from './database/mongo';
import { createLogger } from './shared/logger';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL);

  await connectMongo(env.MONGODB_URI);
  logger.info('Connexion MongoDB établie');

  const app = createApp({ env, logger });
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API thebaroness démarrée');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Arrêt du serveur');
    server.close(() => {
      void disconnectMongo().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Avant que le logger soit disponible (config invalide) : sortie brute sur stderr.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
