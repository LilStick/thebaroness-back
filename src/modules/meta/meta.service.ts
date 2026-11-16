import { cached } from '../../database/api-cache';
import type { DeadlockApi, KnownRank } from '../../integrations/deadlock/deadlock.api';
import type { RawHeroAnalytics } from '../../integrations/deadlock/deadlock.schemas';
import { notFound } from '../../shared/errors';
import { accountIdToSteamId } from '../../shared/schemas';
import { toGameMode, toMatchMode } from '../../integrations/deadlock/game-modes';
import { dataMeta, type CatalogService } from '../catalog/catalog.service';
import { rankFromBadge } from '../catalog/ranks';

export const LEADERBOARD_REGIONS = ['Europe', 'Asia', 'NAmerica', 'SAmerica', 'Oceania'] as const;
export type LeaderboardRegion = (typeof LEADERBOARD_REGIONS)[number];

const TTL = {
  /** La source se met à jour toutes les heures. */
  leaderboard: 30 * 60_000,
  /** Agrégats méta (§9.2). */
  heroStats: 30 * 60_000,
  /** Partie terminée : ne change plus. */
  match: 7 * 24 * 3600_000,
} as const;

/** Entrées renvoyées pour le classement (la source en compte plusieurs centaines). */
const LEADERBOARD_SIZE = 100;
/** En dessous, un taux de victoire par palier n'est pas significatif → `null`. */
export const MIN_TIER_SAMPLE = 200;
const TIERS = 12;
const PLAYERS_PER_MATCH = 12;

const round2 = (value: number) => Math.round(value * 100) / 100;
const percent = (part: number, total: number) => (total > 0 ? round2((part / total) * 100) : null);

export interface HeroMetaStats {
  heroId: number;
  matches: number | null;
  winRate: number | null;
  pickRate: number | null;
  avgKills: number | null;
  avgDeaths: number | null;
  avgAssists: number | null;
  winRateByTier: { tier: number; winRate: number | null; matches: number | null }[];
}

type TeamSide = 'amber' | 'sapphire';
const SIDES: TeamSide[] = ['amber', 'sapphire'];

/** Agrège les lignes (héros, badge moyen) en statistiques par héros et par palier. */
export function computeHeroMetaStats(rows: RawHeroAnalytics): Record<string, HeroMetaStats> {
  const byHero = new Map<
    number,
    {
      matches: number;
      wins: number;
      kills: number;
      deaths: number;
      assists: number;
      tiers: { matches: number; wins: number }[];
    }
  >();
  let totalHeroMatches = 0;

  for (const row of rows) {
    const hero = byHero.get(row.hero_id) ?? {
      matches: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      tiers: Array.from({ length: TIERS }, () => ({ matches: 0, wins: 0 })),
    };
    hero.matches += row.matches;
    hero.wins += row.wins;
    hero.kills += row.total_kills ?? 0;
    hero.deaths += row.total_deaths ?? 0;
    hero.assists += row.total_assists ?? 0;
    // Bucket = badge moyen (tier * 10 + subrank) ; 0 = non classé (palier 0).
    const tier = Math.min(TIERS - 1, Math.max(0, Math.floor((row.bucket ?? 0) / 10)));
    const slot = hero.tiers[tier];
    if (slot) {
      slot.matches += row.matches;
      slot.wins += row.wins;
    }
    totalHeroMatches += row.matches;
    byHero.set(row.hero_id, hero);
  }

  // Chaque partie compte 12 héros : nombre de parties = participations / 12.
  const totalMatches = totalHeroMatches / PLAYERS_PER_MATCH;
  const result: Record<string, HeroMetaStats> = {};
  for (const [heroId, hero] of byHero) {
    const per = (value: number) => (hero.matches > 0 ? round2(value / hero.matches) : null);
    result[heroId] = {
      heroId,
      matches: hero.matches,
      winRate: percent(hero.wins, hero.matches),
      pickRate: percent(hero.matches, totalMatches),
      avgKills: per(hero.kills),
      avgDeaths: per(hero.deaths),
      avgAssists: per(hero.assists),
      winRateByTier: hero.tiers.map(({ matches, wins }, tier) => ({
        tier,
        matches: matches > 0 ? matches : null,
        winRate: matches >= MIN_TIER_SAMPLE ? percent(wins, matches) : null,
      })),
    };
  }
  return result;
}

type RawLeaderboardEntry = Awaited<ReturnType<DeadlockApi['getLeaderboard']>>[number];

/**
 * Compte et badge d'une entrée du classement. Pseudo univoque : ce compte. Pseudo partagé par
 * plusieurs comptes : le candidat au rang le plus élevé (puis à la partie classée la plus
 * récente), seul plausible dans le haut du classement ; marqué `inferred`. Sans déduction si un
 * candidat n'a pas pu être vérifié.
 */
export function resolveEntry(
  entry: RawLeaderboardEntry,
  ranks: Map<number, KnownRank>,
  unchecked: Set<number> = new Set(),
) {
  const ids = entry.possible_account_ids ?? [];
  let best: number | null = ids.length === 1 ? (ids[0] ?? null) : null;
  // Jamais de déduction si un candidat n'a pas pu être vérifié : le bon compte peut être celui-là.
  if (ids.length > 1 && !ids.some((id) => unchecked.has(id))) {
    for (const id of ids) {
      const candidate = ranks.get(id);
      const current = best === null ? undefined : ranks.get(best);
      if (
        candidate &&
        (!current ||
          candidate.badge > current.badge ||
          (candidate.badge === current.badge && candidate.at > current.at))
      )
        best = id;
    }
  }
  return {
    rank: entry.rank ?? null,
    account_name: entry.account_name ?? null,
    top_hero_ids: entry.top_hero_ids ?? [],
    accountId: best,
    badge: best === null ? null : (ranks.get(best)?.badge ?? null),
    inferred: ids.length > 1 && best !== null,
  };
}

export function createMetaService(deadlock: DeadlockApi, catalog: CatalogService) {
  /** Index des héros facultatif : sans lui, noms de repli et réponse partielle. */
  const heroIndex = () => catalog.heroIndex().catch(() => null);

  return {
    async leaderboard(region: LeaderboardRegion) {
      const [board, heroes, tiers] = await Promise.all([
        // Clé v3 : le cache contient le compte retenu et son badge pour chaque entrée.
        cached(
          `leaderboard:v3:${region}`,
          // Incomplet (lots de rangs en échec) : nouvel essai à la requête suivante après 1 min.
          { ttlMs: (data: { complete: boolean }) => (data.complete ? TTL.leaderboard : 60_000) },
          async () => {
            const entries = (await deadlock.getLeaderboard(region)).slice(0, LEADERBOARD_SIZE);
            // Ne lève pas : les comptes d'un lot en échec sont `unchecked`.
            const { ranks, unchecked } = await deadlock.getPlayerRanks(
              entries.flatMap((e) => e.possible_account_ids ?? []),
            );
            return {
              entries: entries.map((e) => resolveEntry(e, ranks, unchecked)),
              complete: unchecked.size === 0,
            };
          },
        ),
        heroIndex(),
        catalog.ranks().catch(() => null),
      ]);
      const index = heroes?.data ?? {};
      const { entries, complete } = board.data;
      let missingRank = false;
      return {
        region,
        items: entries.map((entry, position) => {
          const rank = entry.badge && tiers ? rankFromBadge(entry.badge, tiers.data) : null;
          if (entry.badge && !tiers) missingRank = true;
          return {
            rank: entry.rank ?? position + 1,
            displayName: entry.account_name ?? '',
            steamId: entry.accountId ? accountIdToSteamId(entry.accountId) : null,
            // Compte choisi parmi plusieurs homonymes (celui au rang le plus élevé).
            inferred: entry.inferred,
            badge:
              rank?.tier != null && rank.subrank != null && rank.name
                ? {
                    tier: rank.tier,
                    subrank: rank.subrank,
                    name: rank.name,
                    imageUrl: rank.imageUrl,
                  }
                : null,
            topHeroes: [...new Set(entry.top_hero_ids ?? [])].slice(0, 3).map((heroId) => ({
              heroId,
              name: index[heroId]?.name ?? `Héros #${heroId}`,
              imageUrl: index[heroId]?.imageUrl ?? null,
            })),
          };
        }),
        meta: { ...dataMeta(board), isPartial: !heroes || !complete || missingRank },
      };
    },

    async heroStats(heroId: number) {
      // Vérifie l'existence du héros (404) avant d'interroger les agrégats.
      await catalog.hero(heroId);
      const all = await cached('analytics:hero-stats', { ttlMs: TTL.heroStats }, async () =>
        computeHeroMetaStats(await deadlock.getHeroAnalyticsByBadge()),
      );
      const stats: HeroMetaStats = all.data[heroId] ?? {
        heroId,
        matches: null,
        winRate: null,
        pickRate: null,
        avgKills: null,
        avgDeaths: null,
        avgAssists: null,
        winRateByTier: Array.from({ length: TIERS }, (_, tier) => ({
          tier,
          winRate: null,
          matches: null,
        })),
      };
      return { stats, meta: dataMeta(all) };
    },

    async match(matchId: string) {
      // Clé v2 : les copies antérieures n'ont pas les modes de jeu.
      const detail = await cached(`match:v2:${matchId}`, { ttlMs: TTL.match }, async () => {
        const info = await deadlock.getMatchMetadata(matchId);
        if (!info) return null;
        const accountIds = info.players
          .map((p) => p.account_id)
          .filter((id): id is number => Boolean(id));
        // Pseudos en un seul appel ; sans eux, repli sur le SteamID.
        const profiles = await deadlock.getSteamProfiles(accountIds).catch(() => []);
        const names = new Map(profiles.map((p) => [p.accountId, p.displayName]));
        return { info, names: Object.fromEntries(names) as Record<string, string> };
      });
      if (!detail.data) throw notFound('Partie introuvable.');

      const heroes = await heroIndex();
      const index = heroes?.data ?? {};
      const { info, names } = detail.data;
      const winningSide = SIDES[info.winning_team ?? -1] ?? null;

      const teams = SIDES.map((side, team) => ({
        side,
        outcome: side === winningSide ? ('win' as const) : ('loss' as const),
        players: info.players
          .filter((p) => p.team === team)
          .sort((a, b) => (b.net_worth ?? 0) - (a.net_worth ?? 0))
          .map((p) => {
            const steamId = p.account_id ? accountIdToSteamId(p.account_id) : null;
            return {
              steamId,
              displayName: (p.account_id && names[p.account_id]) || steamId || 'Joueur inconnu',
              heroId: p.hero_id,
              heroName: index[p.hero_id]?.name ?? `Héros #${p.hero_id}`,
              heroImageUrl: index[p.hero_id]?.imageUrl ?? null,
              level: p.level ?? null,
              kills: p.kills ?? null,
              deaths: p.deaths ?? null,
              assists: p.assists ?? null,
              netWorth: p.net_worth ?? null,
              lastHits: p.last_hits ?? null,
              denies: p.denies ?? null,
            };
          }),
      }));

      return {
        match: {
          matchId,
          playedAt: info.start_time ? new Date(info.start_time * 1000).toISOString() : null,
          durationSeconds: info.duration_s ?? null,
          matchMode: toMatchMode(info.match_mode),
          gameMode: toGameMode(info.game_mode),
          winningSide,
          teams,
        },
        meta: { ...dataMeta(detail), isPartial: !heroes || !info.start_time },
      };
    },
  };
}

export type MetaService = ReturnType<typeof createMetaService>;
