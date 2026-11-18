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

export interface CacheOptions<T = unknown> {
  /** Durée de fraîcheur, éventuellement selon la donnée (ex. plus courte si incomplète). */
  ttlMs: number | ((data: T) => number);
  /** Durée de conservation après expiration, pour le repli « périmé ». */
  staleMs?: number;
  source?: string;
  /**
   * Refresh forcé : la copie n'est servie que si elle a moins de `maxAgeMs`, même non expirée.
   * Sert de délai minimum entre deux appels au fournisseur pour une même clé.
   */
  maxAgeMs?: number;
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
  { ttlMs, staleMs = DEFAULT_STALE_MS, source = 'deadlock-api', maxAgeMs }: CacheOptions<T>,
  fetcher: () => Promise<T>,
): Promise<Cached<T>> {
  const entry = await ApiCacheModel.findOne({ key }, { payload: 1, fetchedAt: 1, expiresAt: 1 })
    .lean<{ payload: T; fetchedAt: Date; expiresAt: Date }>()
    .exec();
  const now = Date.now();
  if (
    entry &&
    entry.expiresAt.getTime() > now &&
    (maxAgeMs === undefined || now - entry.fetchedAt.getTime() < maxAgeMs)
  ) {
    return { data: entry.payload, fetchedAt: entry.fetchedAt, isStale: false };
  }

  // Une seule lecture source par clé et par processus : les requêtes simultanées attendent la
  // même promesse (copie profonde pour elles, la donnée pouvant être modifiée par l'appelant).
  const running = inflight.get(key) as Promise<Fresh<T>> | undefined;
  const pending = running ?? fetchAndStore(key, { ttlMs, staleMs, source }, fetcher);
  if (!running) {
    inflight.set(key, pending);
    void pending.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
  }
  try {
    const fresh = await pending;
    return {
      data: running ? structuredClone(fresh.data) : fresh.data,
      fetchedAt: fresh.fetchedAt,
      isStale: false,
    };
  } catch (error) {
    if (entry && isUpstreamFailure(error)) {
      return { data: entry.payload, fetchedAt: entry.fetchedAt, isStale: true };
    }
    throw error;
  }
}

interface Fresh<T> {
  data: T;
  fetchedAt: Date;
}

const inflight = new Map<string, Promise<Fresh<unknown>>>();

/** Lectures source en cours (tests et diagnostic). */
export const inflightCacheKeys = () => [...inflight.keys()];

async function fetchAndStore<T>(
  key: string,
  { ttlMs, staleMs, source }: Required<Pick<CacheOptions<T>, 'ttlMs' | 'staleMs' | 'source'>>,
  fetcher: () => Promise<T>,
): Promise<Fresh<T>> {
  const data = await fetcher();
  const fetchedAt = new Date();
  const expiresAt = new Date(
    fetchedAt.getTime() + (typeof ttlMs === 'function' ? ttlMs(data) : ttlMs),
  );
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
  return { data, fetchedAt };
}
