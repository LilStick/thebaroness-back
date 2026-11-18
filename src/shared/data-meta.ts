import type { Cached } from '../database/api-cache';

/** Métadonnées de fraîcheur jointes à chaque réponse de données (contrat `DataMeta`). */
export interface DataMeta {
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  isStale: boolean;
  isPartial: boolean;
}

type Source = Pick<Cached<unknown>, 'fetchedAt' | 'isStale'>;

/**
 * Seul constructeur de `DataMeta` : `fetchedAt` = donnée la plus ancienne utilisée,
 * `isStale` si l'une des sources est périmée. `extra` complète (`isPartial`, `sourceUpdatedAt`).
 */
export function combineMeta(sources: Source[], extra: Partial<DataMeta> = {}): DataMeta {
  return {
    fetchedAt: new Date(Math.min(...sources.map((s) => s.fetchedAt.getTime()))).toISOString(),
    sourceUpdatedAt: null,
    isStale: sources.some((s) => s.isStale),
    isPartial: false,
    ...extra,
  };
}
