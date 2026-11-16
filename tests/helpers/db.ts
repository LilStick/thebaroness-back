import { randomUUID } from 'node:crypto';
import os from 'node:os';
import mongoose from 'mongoose';
import { connectMongo } from '../../src/database/mongo';

/**
 * Connecte le fichier de test à une base isolée (nom aléatoire, donc compatible avec
 * l'exécution parallèle de Jest), vide les collections après chaque test et
 * supprime la base à la fin. Les index des modèles importés sont créés à la connexion.
 */
export function useTestDb(): void {
  beforeAll(async () => {
    const base = process.env.TEST_MONGO_URI;
    if (!base) throw new Error('TEST_MONGO_URI absent : globalSetup Jest non exécuté');
    const url = new URL(base);
    url.pathname = `/test-${randomUUID()}`;
    // Le driver MongoDB charge `os` via un import() dynamique, non supporté par la VM de Jest :
    // sans cet adaptateur, les métadonnées du handshake partent vides et mongod refuse la connexion.
    await connectMongo(url.toString(), { runtimeAdapters: { os } });
  });

  afterEach(async () => {
    const collections = Object.values(mongoose.connection.collections);
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}
