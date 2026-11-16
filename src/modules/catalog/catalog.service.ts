import { cached, type Cached } from '../../database/api-cache';
import type { DeadlockApi } from '../../integrations/deadlock/deadlock.api';
import type { RawAbility } from '../../integrations/deadlock/deadlock.schemas';
import { notFound } from '../../shared/errors';
import {
  heroSmallImage,
  isPlayableHero,
  toHeroDetail,
  toHeroSummary,
  type HeroDetail,
  type HeroIndexEntry,
} from './heroes';
import { toRankTier, type RankTier } from './ranks';

/** Assets du jeu : changent avec les patchs, cache 24 h (§9.2). */
const CATALOG_TTL = 24 * 3600_000;

export interface MapAssets {
  minimap: string;
  tunnels: string | null;
  frame: string | null;
}

interface HeroCatalog {
  /** Héros jouables, détaillés, triés par nom. */
  heroes: HeroDetail[];
  /** Tous les héros (y compris retirés), pour nommer ceux des anciennes parties. */
  index: Record<string, HeroIndexEntry>;
}

export const dataMeta = (source: Pick<Cached<unknown>, 'fetchedAt' | 'isStale'>) => ({
  fetchedAt: source.fetchedAt.toISOString(),
  sourceUpdatedAt: null,
  isStale: source.isStale,
  isPartial: false,
});

export function createCatalogService(deadlock: DeadlockApi) {
  const heroCatalog = () =>
    cached<HeroCatalog>('catalog:heroes:en', { ttlMs: CATALOG_TTL }, async () => {
      const [heroes, abilities] = await Promise.all([
        deadlock.getHeroes(),
        deadlock.getAbilities(),
      ]);
      const abilitiesByClass = new Map<string, RawAbility[]>();
      for (const ability of abilities) {
        const list = abilitiesByClass.get(ability.class_name) ?? [];
        list.push(ability);
        abilitiesByClass.set(ability.class_name, list);
      }
      return {
        heroes: heroes
          .filter(isPlayableHero)
          .map((hero) => toHeroDetail(hero, abilitiesByClass))
          .sort((a, b) => a.name.localeCompare(b.name, 'en')),
        index: Object.fromEntries(
          heroes.map((hero) => [hero.id, { name: hero.name, imageUrl: heroSmallImage(hero) }]),
        ),
      };
    });

  const rankCatalog = () =>
    cached<RankTier[]>('catalog:ranks:en', { ttlMs: CATALOG_TTL }, async () =>
      (await deadlock.getRanks()).map(toRankTier).sort((a, b) => a.tier - b.tier),
    );

  return {
    async heroes() {
      const catalog = await heroCatalog();
      return { items: catalog.data.heroes.map(toHeroSummary), meta: dataMeta(catalog) };
    },

    async hero(heroId: number) {
      const catalog = await heroCatalog();
      const hero = catalog.data.heroes.find((h) => h.id === heroId);
      if (!hero) throw notFound('Héros introuvable.');
      return { hero, meta: dataMeta(catalog) };
    },

    /** Index id → nom/portrait (cache partagé avec le catalogue). */
    async heroIndex() {
      const catalog = await heroCatalog();
      return { ...catalog, data: catalog.data.index };
    },

    ranks: rankCatalog,

    /** Début de la saison classée courante (epoch s) ou `null` (cache 24 h). */
    async seasonStart(): Promise<number | null> {
      const { data } = await cached('catalog:season-start', { ttlMs: CATALOG_TTL }, async () => ({
        start: await deadlock.getCurrentSeasonStart(),
      }));
      return data.start;
    },

    async map(): Promise<MapAssets> {
      const { data } = await cached('catalog:map', { ttlMs: CATALOG_TTL }, async () => {
        const images = await deadlock.getMapImages();
        return {
          minimap: images.mid ?? images.minimap ?? '',
          tunnels: images.mid_tunnels ?? null,
          frame: images.frame ?? null,
        };
      });
      return data;
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
