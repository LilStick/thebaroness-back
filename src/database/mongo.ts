import mongoose, { type ConnectOptions } from 'mongoose';

/**
 * Ouvre la connexion MongoDB et synchronise les index déclarés dans les modèles.
 * `autoIndex` est coupé : les index sont créés une seule fois, explicitement, au démarrage.
 */
export async function connectMongo(
  uri: string,
  options: ConnectOptions = {},
): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  const connection = await mongoose.connect(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000,
    ...options,
  });
  await Promise.all(Object.values(connection.models).map((model) => model.createIndexes()));
  return connection;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
