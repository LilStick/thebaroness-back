import { percent } from '../../shared/metrics';
import { cached, type Cached } from '../../database/api-cache';
import type { AnalyticsFilter, DeadlockApi } from '../../integrations/deadlock/deadlock.api';
import type { RawItemAsset } from '../../integrations/deadlock/deadlock.schemas';
import { notFound } from '../../shared/errors';
import { dataMeta } from '../catalog/catalog.service';

/** Version du client : relue toutes les heures (un patch change la version). */
const VERSIONS_TTL = 3600_000;
/** Instantané d'une version donnée : immuable, gardé 30 jours (rechargé s'il est purgé). */
const SNAPSHOT_TTL = 30 * 24 * 3600_000;
/** Sans version connue : catalogue « dernier » relu chaque jour. */
const LATEST_TTL = 24 * 3600_000;

/** Agrégats analytiques : la source les recalcule toutes les heures. */
const ANALYTICS_TTL = 3600_000;
const HOUR_S = 3600;
export const ANALYTICS_PERIODS = { '7d': 7, '30d': 30 } as const;
export type AnalyticsPeriod = keyof typeof ANALYTICS_PERIODS;

export interface AnalyticsQuery {
  period: AnalyticsPeriod;
  heroId?: number;
  matchMode?: 'ranked' | 'unranked';
}

/**
 * Borne basse d'une période d'agrégats, arrondie à l'heure (vers le passé) : la source et notre
 * cache partagent ainsi la même requête pendant une heure.
 */
export function analyticsFilter(query: AnalyticsQuery, nowMs: number): AnalyticsFilter {
  const from = Math.floor(nowMs / 1000) - ANALYTICS_PERIODS[query.period] * 86_400;
  return {
    minTimestamp: from - (from % HOUR_S),
    heroId: query.heroId,
    matchMode: query.matchMode,
  };
}

/** Clé de cache d'un jeu de filtres d'agrégats. */
export const analyticsKey = (prefix: string, filter: AnalyticsFilter) =>
  `${prefix}:${filter.minTimestamp}:${filter.heroId ?? 'all'}:${filter.matchMode ?? 'all'}`;

export interface ItemStatsRow {
  itemId: number;
  matches: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Joueurs distincts ayant acheté l'item. */
  players: number | null;
  /** Parties où l'item a été revendu, et part des achats revendus. */
  sold: number | null;
  sellRate: number | null;
  avgBuyTimeSeconds: number | null;
  avgSellTimeSeconds: number | null;
}

export const ITEM_TYPES = ['upgrade', 'ability', 'weapon'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const ITEM_SLOTS = ['weapon', 'vitality', 'spirit'] as const;

/** Item normalisé : identité stable (`id` = identifiant des parties), visuels et prix. */
export interface CatalogItem {
  id: number;
  className: string;
  name: string | null;
  type: ItemType | null;
  /** Catégorie de boutique : `weapon`, `vitality`, `spirit` (objets), null sinon. */
  slot: string | null;
  tier: number | null;
  cost: number | null;
  isActive: boolean | null;
  shopable: boolean;
  disabled: boolean;
  /** Héros associés (capacités, armes). */
  heroIds: number[];
  /** Objets dont celui-ci est l'amélioration (identifiants). */
  componentIds: number[];
  /** Icône de boutique (objets) ou icône (capacités), URL complète, null si absente. */
  imageUrl: string | null;
}

interface ItemSnapshot {
  /** Version du client de l'instantané, null si la liste des versions était indisponible. */
  clientVersion: number | null;
  items: CatalogItem[];
}

const asType = (value: string | null | undefined): ItemType | null =>
  (ITEM_TYPES as readonly string[]).includes(value ?? '') ? (value as ItemType) : null;

export function normalizeItems(raw: RawItemAsset[]): CatalogItem[] {
  const idByClass = new Map(raw.map((item) => [item.class_name, item.id]));
  return raw
    .map((item) => ({
      id: item.id,
      className: item.class_name,
      name: item.name ?? null,
      type: asType(item.type),
      slot: item.item_slot_type ?? null,
      tier: item.item_tier ?? null,
      cost: item.cost ?? null,
      isActive: item.is_active_item ?? null,
      shopable: Boolean(item.shopable),
      disabled: Boolean(item.disabled),
      heroIds: [...new Set([...(item.heroes ?? []), ...(item.hero ? [item.hero] : [])])],
      componentIds: (item.component_items ?? []).flatMap((c) => {
        const id = idByClass.get(c);
        return id === undefined ? [] : [id];
      }),
      imageUrl: item.shop_image_webp ?? item.shop_image ?? item.image_webp ?? item.image ?? null,
    }))
    .sort((a, b) => a.id - b.id);
}

/**
 * Catalogue des items, versionné par version du client Deadlock : un instantané immuable par
 * version (`catalog:items:v<version>:en`), la version courante relue toutes les heures. Les anciennes
 * versions restent en cache pour nommer les items des anciennes parties (`clientVersion`).
 */
export function createItemsService(deadlock: DeadlockApi) {
  const latestVersion = () =>
    cached('catalog:client-version', { ttlMs: VERSIONS_TTL }, async () => ({
      version: await deadlock.getLatestClientVersion(),
    }));

  async function snapshot(requested?: number): Promise<Cached<ItemSnapshot>> {
    const version =
      requested ??
      (await latestVersion()
        .then((v) => v.data.version)
        .catch(() => null));
    const key = version === null ? 'catalog:items:latest:en' : `catalog:items:v${version}:en`;
    return cached<ItemSnapshot>(
      key,
      { ttlMs: version === null ? LATEST_TTL : SNAPSHOT_TTL },
      async () => ({
        clientVersion: version,
        items: normalizeItems(await deadlock.getItems(version)),
      }),
    );
  }

  /** Agrégats de tous les items pour un jeu de filtres (une seule requête source par heure). */
  const itemStats = (filter: AnalyticsFilter) =>
    cached<ItemStatsRow[]>(
      analyticsKey('item-stats:v1', filter),
      { ttlMs: ANALYTICS_TTL },
      async () =>
        (await deadlock.getItemStats(filter))
          .map((r) => ({
            itemId: r.item_id,
            matches: r.matches,
            wins: r.wins,
            losses: r.losses,
            winRate: percent(r.wins, r.matches),
            players: r.players ?? null,
            sold: r.sold ?? null,
            sellRate: r.sold == null ? null : percent(r.sold, r.matches),
            avgBuyTimeSeconds: r.avg_buy_time_s == null ? null : Math.round(r.avg_buy_time_s),
            // Moyenne sans revente : non définie.
            avgSellTimeSeconds:
              r.avg_sell_time_s == null || !r.sold ? null : Math.round(r.avg_sell_time_s),
          }))
          .sort((a, b) => b.matches - a.matches || a.itemId - b.itemId),
    );

  const filtersOf = (query: AnalyticsQuery, filter: AnalyticsFilter) => ({
    period: query.period,
    heroId: query.heroId ?? null,
    matchMode: query.matchMode ?? 'all',
    gameMode: 'normal' as const,
    from: new Date(filter.minTimestamp * 1000).toISOString(),
  });

  const service = {
    snapshot,

    /** Statistiques d'utilisation de tous les items (seuil de la source : 20 parties). */
    async stats(query: AnalyticsQuery) {
      const filter = analyticsFilter(query, Date.now());
      const result = await itemStats(filter);
      return { filters: filtersOf(query, filter), items: result.data, meta: dataMeta(result) };
    },

    /** Statistiques d'un item ; `stats: null` sous le seuil de la source (404 si item inconnu). */
    async itemStats(itemId: number, query: AnalyticsQuery) {
      const filter = analyticsFilter(query, Date.now());
      const [, result] = await Promise.all([service.item(itemId), itemStats(filter)]);
      const row = result.data.find((r) => r.itemId === itemId) ?? null;
      return {
        itemId,
        filters: filtersOf(query, filter),
        stats: row,
        notes: row ? [] : ['below_source_threshold'],
        meta: dataMeta(result),
      };
    },

    /** Index `id → item` de la version courante, pour typer les achats d'une partie. */
    async index(): Promise<Map<number, CatalogItem>> {
      const { data } = await snapshot();
      return new Map(data.items.map((item) => [item.id, item]));
    },

    async list(filter: {
      type?: ItemType;
      slot?: string;
      tier?: number;
      shopable?: boolean;
      clientVersion?: number;
    }) {
      const snap = await snapshot(filter.clientVersion);
      const items = snap.data.items.filter(
        (item) =>
          (filter.type === undefined || item.type === filter.type) &&
          (filter.slot === undefined || item.slot === filter.slot) &&
          (filter.tier === undefined || item.tier === filter.tier) &&
          (filter.shopable === undefined || item.shopable === filter.shopable),
      );
      return { clientVersion: snap.data.clientVersion, items, meta: dataMeta(snap) };
    },

    async item(itemId: number, clientVersion?: number) {
      const snap = await snapshot(clientVersion);
      const item = snap.data.items.find((i) => i.id === itemId);
      if (!item) throw notFound('Item introuvable.');
      return { clientVersion: snap.data.clientVersion, item, meta: dataMeta(snap) };
    },
  };
  return service;
}

export type ItemsService = ReturnType<typeof createItemsService>;
