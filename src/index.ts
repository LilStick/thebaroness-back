import 'dotenv/config';
import { createApp } from './app';
import { parseEnv } from './config/env';

/* eslint-disable no-console -- logger structuré prévu dans l'issue #17 */
function main(): void {
  const env = parseEnv(process.env);
  const app = createApp(env);

  const server = app.listen(env.PORT, () => {
    console.log(`API thebaroness démarrée sur le port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} reçu, arrêt du serveur`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
