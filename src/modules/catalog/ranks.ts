import type { RawRankAsset } from '../../integrations/deadlock/deadlock.schemas';

/** Palier de rang exposé au front (`RankTier`, contrat back-p1-contract.md). */
export interface RankTier {
  tier: number;
  name: string;
  color: string;
  imageUrl: string;
  /** Images des 6 sous-rangs (index 0 = sous-rang 1), `null` si indisponible. */
  subranks: (string | null)[];
}

/** Rang d'un joueur : `badgeId`/`name` historiques, le reste ajouté par le contrat P1. */
export interface PlayerRank {
  badgeId: number | null;
  name: string | null;
  tier: number | null;
  subrank: number | null;
  imageUrl: string | null;
  color: string | null;
}

export const SUBRANKS = 6;

export const UNRANKED: PlayerRank = {
  badgeId: null,
  name: null,
  tier: null,
  subrank: null,
  imageUrl: null,
  color: null,
};

const pick = (images: RawRankAsset['images'], ...keys: string[]) =>
  keys.map((key) => images[key]).find((value): value is string => Boolean(value)) ?? null;

export function toRankTier(raw: RawRankAsset): RankTier {
  const { images } = raw;
  return {
    tier: raw.tier,
    name: raw.name,
    color: raw.color ?? '#333333',
    imageUrl: pick(images, 'large_webp', 'large', 'small_webp', 'small') ?? '',
    subranks: Array.from({ length: SUBRANKS }, (_, i) =>
      // Même source que les fixtures du front (scripts/build-fixtures.mjs).
      pick(images, `large_subrank${i + 1}_webp`, `subrank${i + 1}_webp`, `large_subrank${i + 1}`),
    ),
  };
}

/**
 * Badge Deadlock (`tier * 10 + subrank`) → rang lisible. Badge absent, nul ou incohérent
 * → non classé (jamais de rang inventé).
 */
export function rankFromBadge(badge: number | null | undefined, tiers: RankTier[]): PlayerRank {
  if (!badge) return UNRANKED;
  const tierNumber = Math.floor(badge / 10);
  const subrank = badge % 10;
  const tier = tiers.find((t) => t.tier === tierNumber);
  if (!tier || subrank < 1 || subrank > SUBRANKS) return UNRANKED;
  return {
    badgeId: badge,
    name: `${tier.name} ${subrank}`,
    tier: tierNumber,
    subrank,
    imageUrl: tier.subranks[subrank - 1] ?? tier.imageUrl,
    color: tier.color,
  };
}

/** Score comparable entre joueurs : `tier * 6 + subrank` (1 à 72). */
export const rankScore = (badge: number): number =>
  Math.floor(badge / 10) * SUBRANKS + (badge % 10);

/** Saison classée d'un instant (epoch s), ou `null` hors de toute saison connue. */
export function seasonAt(
  seconds: number,
  seasons: ReadonlyArray<{ season: number; startAt: number; endAt: number | null }>,
): number | null {
  const found = seasons.find(
    (s) => s.startAt <= seconds && (s.endAt === null || seconds < s.endAt),
  );
  return found?.season ?? null;
}

/**
 * Progression de rang comparable : dernier − premier score parmi les points de la même saison
 * que le dernier point (les rangs de deux saisons ne se comparent pas). Sans saisons connues,
 * tous les points sont considérés. `null` sous 2 points comparables.
 */
export function seasonRankDelta(
  points: ReadonlyArray<{ score: number; season: number | null }>,
): number | null {
  const last = points.at(-1);
  if (!last) return null;
  const segment = points.filter((p) => p.season === last.season);
  const first = segment[0];
  return segment.length >= 2 && first ? last.score - first.score : null;
}
