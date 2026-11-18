import { percent } from '../../shared/metrics';
import { cached } from '../../database/api-cache';
import type { DeadlockApi } from '../../integrations/deadlock/deadlock.api';
import type { RawBuilds } from '../../integrations/deadlock/deadlock.schemas';
import { accountIdToSteamId } from '../../shared/schemas';
import { dataMeta } from '../catalog/catalog.service';
import { analyticsFilter, analyticsKey, type AnalyticsQuery } from '../items/items.service';

const TTL = 3600_000;
/** Lignes demandées à la source (une par version de build), puis dédoublonnées. */
const BUILD_ROWS = 200;

export const BUILD_SORTS = ['favorites', 'weekly_favorites', 'updated_at', 'published_at'] as const;
export type BuildSort = (typeof BUILD_SORTS)[number];

/** `#Citadel_HeroBuilds_EarlyGame` → `Early Game` ; nom libre de l'auteur conservé tel quel. */
export const categoryLabel = (name: string | null | undefined) => {
  if (!name) return null;
  const key = /^#Citadel_HeroBuilds_(.+)$/.exec(name)?.[1];
  return key ? key.replace(/([a-z])([A-Z])/g, '$1 $2') : name;
};

const iso = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000).toISOString() : null;

export function normalizeBuild(raw: RawBuilds[number]) {
  const build = raw.hero_build;
  return {
    buildId: build.hero_build_id,
    heroId: build.hero_id,
    name: build.name ?? null,
    description: build.description || null,
    authorSteamId: build.author_account_id ? accountIdToSteamId(build.author_account_id) : null,
    /** Langue du build selon Valve (0 = anglais). */
    language: build.language ?? null,
    version: build.version ?? null,
    publishedAt: iso(build.publish_timestamp),
    updatedAt: iso(build.last_updated_timestamp),
    favorites: raw.num_favorites ?? null,
    weeklyFavorites: raw.num_weekly_favorites ?? null,
    categories: (build.details?.mod_categories ?? []).map((c) => ({
      name: categoryLabel(c.name),
      description: c.description || null,
      items: (c.mods ?? []).map((m) => ({
        itemId: m.ability_id,
        annotation: m.annotation || null,
      })),
    })),
  };
}

export type HeroBuild = ReturnType<typeof normalizeBuild>;

/** Une entrée par build : sa version la plus récente parmi les lignes reçues. */
export function latestVersions(builds: HeroBuild[]): HeroBuild[] {
  const byId = new Map<number, HeroBuild>();
  for (const build of builds) {
    const current = byId.get(build.buildId);
    if (!current || (build.version ?? 0) > (current.version ?? 0)) byId.set(build.buildId, build);
  }
  return [...byId.values()];
}

type SortKey = 'favorites' | 'weeklyFavorites' | 'updatedAt' | 'publishedAt';

/** Ordre décroissant sur une clé, valeur inconnue en dernier, puis `buildId`. */
const byDesc =
  (key: SortKey) =>
  (a: HeroBuild, b: HeroBuild): number => {
    const x = a[key];
    const y = b[key];
    if (x === y) return a.buildId - b.buildId;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? 1 : -1;
  };

const BUILD_ORDER: Record<BuildSort, (a: HeroBuild, b: HeroBuild) => number> = {
  favorites: byDesc('favorites'),
  weekly_favorites: byDesc('weeklyFavorites'),
  updated_at: byDesc('updatedAt'),
  published_at: byDesc('publishedAt'),
};

export interface ItemPair {
  itemIds: [number, number];
  matches: number;
  wins: number;
  losses: number;
  winRate: number | null;
}

/** Builds publiés et paires d'items d'un héros (agrégats Deadlock API). */
export function createBuildsService(deadlock: DeadlockApi) {
  return {
    async builds(heroId: number, sort: BuildSort, limit: number) {
      const result = await cached<HeroBuild[]>(
        `builds:v2:${heroId}:${sort}`,
        { ttlMs: TTL },
        async () =>
          latestVersions(
            (await deadlock.getHeroBuilds(heroId, sort, BUILD_ROWS))
              .filter((b) => b.hero_build.hero_id === heroId)
              .map(normalizeBuild),
          ).sort(BUILD_ORDER[sort]),
      );
      return { heroId, sort, items: result.data.slice(0, limit), meta: dataMeta(result) };
    },

    /** Paires d'items achetés ensemble, par volume ; `itemId` garde les paires qui le contiennent. */
    async itemPairs(heroId: number, query: AnalyticsQuery & { itemId?: number; limit: number }) {
      const filter = analyticsFilter({ ...query, heroId }, Date.now());
      const result = await cached<ItemPair[]>(
        analyticsKey('item-pairs:v1', filter),
        { ttlMs: TTL },
        async () =>
          (await deadlock.getItemPairs({ ...filter, heroId }))
            .flatMap((r) => {
              const [a, b] = r.item_ids;
              return a !== undefined && b !== undefined && r.item_ids.length === 2
                ? [
                    {
                      itemIds: [Math.min(a, b), Math.max(a, b)] as [number, number],
                      matches: r.matches,
                      wins: r.wins,
                      losses: r.losses,
                      winRate: percent(r.wins, r.matches),
                    },
                  ]
                : [];
            })
            .sort(
              (x, y) =>
                y.matches - x.matches || x.itemIds[0] - y.itemIds[0] || x.itemIds[1] - y.itemIds[1],
            ),
      );
      const pairs =
        query.itemId === undefined
          ? result.data
          : result.data.filter((p) => p.itemIds.includes(query.itemId as number));
      return {
        heroId,
        filters: {
          period: query.period,
          matchMode: query.matchMode ?? 'all',
          gameMode: 'normal' as const,
          itemId: query.itemId ?? null,
          from: new Date(filter.minTimestamp * 1000).toISOString(),
        },
        items: pairs.slice(0, query.limit),
        meta: dataMeta(result),
      };
    },
  };
}

export type BuildsService = ReturnType<typeof createBuildsService>;
