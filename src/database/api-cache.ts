import { Schema, model } from 'mongoose';
import { AppError } from '../shared/errors';

/**
 * Cache durable des données normalisées issues de Deadlock API (§9.2, §11.3).
 * - `expiresAt` : fin de fraîcheur (TTL logique) ;
 * - `purgeAt`   : suppression physique par l'index TTL MongoDB, plus tardive,
 *   pour pouvoir servir une copie périmée quand le fournisseur est indisponible.
 */
const apiCacheSchema = new Schema(
  {
    key: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    purgeAt: { type: Date, required: true },
    source: { type: String, required: true },
  },
  { collection: 'api_cache', versionKey: false, minimize: false },
);

apiCacheSchema.index({ key: 1 }, { unique: true });
apiCacheSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const ApiCacheModel = model('ApiCache', apiCacheSchema);

export interface Cached<T> {
  data: T;
  fetchedAt: Date;
  /** Vrai si la donnée a dépassé son TTL et a été servie faute de fournisseur disponible. */
  isStale: boolean;
}

export interface CacheOptions {
  /** Durée de fraîcheur. */
  ttlMs: number;
  /** Durée de conservation après expiration, pour le repli « périmé ». */
  staleMs?: number;
  source?: string;
}

const DEFAULT_STALE_MS = 7 * 24 * 3600_000;

/** Erreurs du fournisseur pour lesquelles une copie périmée vaut mieux qu'une erreur. */
const isUpstreamFailure = (error: unknown) =>
  error instanceof AppError && (error.status === 502 || error.status === 503);

/**
 * Lecture à travers le cache : copie fraîche si disponible, sinon appel de `fetcher`
 * puis écriture ; si le fournisseur échoue et qu'une copie existe, elle est servie avec
 * `isStale = true` (§9.1). Sans copie, l'erreur du fournisseur est propagée.
 */
export async function cached<T>(
  key: string,
  { ttlMs, staleMs = DEFAULT_STALE_MS, source = 'deadlock-api' }: CacheOptions,
  fetcher: () => Promise<T>,
): Promise<Cached<T>> {
  const entry = await ApiCacheModel.findOne({ key }, { payload: 1, fetchedAt: 1, expiresAt: 1 })
    .lean<{ payload: T; fetchedAt: Date; expiresAt: Date }>()
    .exec();
  const now = Date.now();
  if (entry && entry.expiresAt.getTime() > now) {
    return { data: entry.payload, fetchedAt: entry.fetchedAt, isStale: false };
  }

  let data: T;
  try {
    data = await fetcher();
  } catch (error) {
    if (entry && isUpstreamFailure(error)) {
      return { data: entry.payload, fetchedAt: entry.fetchedAt, isStale: true };
    }
    throw error;
  }

  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + ttlMs);
  await ApiCacheModel.updateOne(
    { key },
    {
      $set: {
        payload: data,
        fetchedAt,
        expiresAt,
        purgeAt: new Date(expiresAt.getTime() + staleMs),
        source,
      },
    },
    { upsert: true },
  );
  return { data, fetchedAt, isStale: false };
}
