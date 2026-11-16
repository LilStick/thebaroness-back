import { MongoMemoryServer } from 'mongodb-memory-server';

declare global {
  var __MONGOD__: MongoMemoryServer | undefined;
}

/** Une seule instance mongod en mémoire pour toute la suite ; chaque fichier de test a sa propre base. */
export default async function globalSetup(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  globalThis.__MONGOD__ = mongod;
  process.env.TEST_MONGO_URI = mongod.getUri();
}
