import { cached, type Cached } from '../../database/api-cache';
import type { DeadlockApi } from '../../integrations/deadlock/deadlock.api';
import type { RawItemAsset } from '../../integrations/deadlock/deadlock.schemas';
import { notFound } from '../../shared/errors';
import { dataMeta } from '../catalog/catalog.service';

/** Version du client : relue toutes les heures (un patch change la version). */
const VERSIONS_TTL = 3600_000;
/** Instantané d'une version donnée : immuable, gardé 30 jours (rechargé s'il est purgé). */
const SNAPSHOT_TTL = 30 * 24 * 3600_000;
/** Sans version connue : catalogue « dernier » relu chaque jour. */
const LATEST_TTL = 24 * 3600_000;

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

  return {
    snapshot,

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
}

export type ItemsService = ReturnType<typeof createItemsService>;
