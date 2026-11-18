import { createHash } from 'node:crypto';
import { mapLimit, percent, round2 } from '../../shared/metrics';
import { cached } from '../../database/api-cache';
import type { DeadlockApi, KnownRank } from '../../integrations/deadlock/deadlock.api';
import type { RawHeroAnalytics } from '../../integrations/deadlock/deadlock.schemas';
import { notFound } from '../../shared/errors';
import { accountIdToSteamId } from '../../shared/schemas';
import { toGameMode, toMatchMode } from '../../integrations/deadlock/game-modes';
import { dataMeta, type CatalogService } from '../catalog/catalog.service';
import type { ItemsService } from '../items/items.service';
import {
  killParticipation,
  normalizeMatch,
  playerMatchSummary,
  playerMetrics,
  splitItems,
  teamTotals,
  type PlayerMatchSummary,
} from './match-detail';
import { rankFromBadge } from '../catalog/ranks';

export const LEADERBOARD_REGIONS = ['Europe', 'Asia', 'NAmerica', 'SAmerica', 'Oceania'] as const;
export type LeaderboardRegion = (typeof LEADERBOARD_REGIONS)[number];

const TTL = {
  /** La source se met à jour toutes les heures. */
  leaderboard: 30 * 60_000,
  /** Agrégats méta (§9.2). */
  heroStats: 30 * 60_000,
  // Les avatars changent rarement : 6 h (un appel groupé par région).
  leaderboardAvatars: 6 * 60 * 60_000,
  /** Partie terminée : ne change plus. */
  match: 7 * 24 * 3600_000,
} as const;

/** Entrées renvoyées pour le classement (la source en compte plusieurs centaines). */
/** Parties lues simultanément pour les résumés d'historique (le client plafonne à 8). */
export const SUMMARY_CONCURRENCY = 4;
const LEADERBOARD_SIZE = 100;
/** En dessous, un taux de victoire par palier n'est pas significatif → `null`. */
export const MIN_TIER_SAMPLE = 200;
const TIERS = 12;
const PLAYERS_PER_MATCH = 12;

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
/**
 * Méta de tous les héros en une entrée de cache partagée (`analytics:hero-stats`, 30 min) :
 * une seule lecture source pour la fiche héros comme pour `/players/{id}/heroes`.
 * Fenêtre fixée par la source (30 derniers jours), mode normal, ranked et unranked confondus.
 */
export function loadHeroMetaTable(deadlock: DeadlockApi) {
  return cached('analytics:hero-stats', { ttlMs: TTL.heroStats }, async () =>
    computeHeroMetaStats(await deadlock.getHeroAnalyticsByBadge()),
  );
}

/** Période de la méta globale des héros (fixée par la source). */
export const HERO_META_PERIOD = '30d' as const;

/** Héros jouable sans donnée dans la fenêtre : toutes les valeurs à `null` (jamais 0). */
export function emptyHeroStats(heroId: number): HeroMetaStats {
  return {
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
}

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

/** Au plus ce nombre d'historiques lus par classement (repli rare, historiques volumineux). */
const HISTORY_FALLBACK_MAX = 10;

/**
 * Repli pour un compte identifié sans rang alors qu'il a joué en classé : dernier
 * `ranked_display_badge` non nul de son historique (même règle que le profil).
 * Renvoie false si un historique n'a pas pu être lu.
 */
async function fillFromHistory(
  deadlock: DeadlockApi,
  entries: ReturnType<typeof resolveEntry>[],
  rankedWithoutBadge: Set<number>,
): Promise<boolean> {
  const targets = entries
    .filter((e) => e.accountId !== null && !e.badge && rankedWithoutBadge.has(e.accountId))
    .slice(0, HISTORY_FALLBACK_MAX);
  const results = await Promise.allSettled(
    targets.map(async (entry) => {
      const history = await deadlock.getMatchHistory(entry.accountId as number);
      const latest = history
        .filter((m) => m.ranked_display_badge)
        .sort((a, b) => b.start_time - a.start_time)[0];
      entry.badge = latest?.ranked_display_badge ?? null;
    }),
  );
  return results.every((r) => r.status === 'fulfilled');
}

export function createMetaService(
  deadlock: DeadlockApi,
  catalog: CatalogService,
  items: Pick<ItemsService, 'index'>,
) {
  /** Index des héros facultatif : sans lui, noms de repli et réponse partielle. */
  const heroIndex = () => catalog.heroIndex().catch(() => null);

  /** Partie normalisée en cache (7 jours), partagée par le détail et les résumés d'historique. */
  const loadMatch = (matchId: string) =>
    // Clé v3 : partie normalisée (achats, statistiques de fin de partie), sans le brut (≈ 1,3 Mo).
    cached(`match:v3:${matchId}`, { ttlMs: TTL.match }, async () => {
      const info = await deadlock.getMatchMetadata(matchId);
      if (!info) return null;
      const accountIds = info.players
        .map((p) => p.account_id)
        .filter((id): id is number => Boolean(id));
      // Pseudos en un seul appel ; sans eux, repli sur le SteamID.
      const profiles = await deadlock.getSteamProfiles(accountIds).catch(() => []);
      const names = new Map(profiles.map((p) => [p.accountId, p.displayName]));
      return {
        match: normalizeMatch(info),
        names: Object.fromEntries(names) as Record<string, string>,
      };
    });

  return {
    /**
     * Résumés de parties du point de vue d'un joueur, pour une page d'historique (≤ 50 parties).
     * Concurrence bornée ; chaque partie passe par le cache `match:v3` (lue à la source une seule
     * fois, puis partagée avec `/matches/{id}`). Une partie en échec donne `null`, jamais une erreur.
     */
    async matchSummaries(matchIds: string[], accountId: number) {
      const itemIndex = await items.index().catch(() => null);
      let stale = false;
      const summaries = await mapLimit(matchIds, SUMMARY_CONCURRENCY, async (matchId) => {
        try {
          const detail = await loadMatch(matchId);
          if (detail.isStale) stale = true;
          return detail.data ? playerMatchSummary(detail.data.match, accountId, itemIndex) : null;
        } catch {
          return null;
        }
      });
      return {
        summaries: new Map<string, PlayerMatchSummary | null>(
          matchIds.map((id, i) => [id, summaries[i] ?? null]),
        ),
        itemCatalogAvailable: itemIndex !== null,
        stale,
      };
    },

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
            const { ranks, unchecked, rankedWithoutBadge } = await deadlock.getPlayerRanks(
              entries.flatMap((e) => e.possible_account_ids ?? []),
            );
            const resolved = entries.map((e) => resolveEntry(e, ranks, unchecked));
            const fallbackOk = await fillFromHistory(deadlock, resolved, rankedWithoutBadge);
            return { entries: resolved, complete: unchecked.size === 0 && fallbackOk };
          },
        ),
        heroIndex(),
        catalog.ranks().catch(() => null),
      ]);
      const index = heroes?.data ?? {};
      const { entries, complete } = board.data;
      // Avatars : un seul appel groupé pour les 100 comptes, en cache séparé (échec → null).
      const accountIds = entries.flatMap((e) => (e.accountId ? [e.accountId] : []));
      // Clé liée à l'ensemble des comptes : un nouvel entrant déclenche un nouvel appel groupé
      // (au plus un par mise à jour du classement) au lieu d'attendre 6 h sans avatar.
      const accountsKey = createHash('sha1')
        .update([...accountIds].sort((a, b) => a - b).join(','))
        .digest('base64url')
        .slice(0, 12);
      const avatars = await cached(
        `leaderboard-avatars:v2:${region}:${accountsKey}`,
        { ttlMs: TTL.leaderboardAvatars, staleMs: 24 * 3600_000 },
        async () =>
          Object.fromEntries(
            (await deadlock.getSteamProfiles(accountIds)).map((p) => [p.accountId, p.avatarUrl]),
          ) as Record<string, string | null>,
      ).catch(() => null);
      let missingRank = false;
      const items = entries.map((entry, position) => {
        const rank = entry.badge && tiers ? rankFromBadge(entry.badge, tiers.data) : null;
        if (entry.badge && !tiers) missingRank = true;
        return {
          rank: entry.rank ?? position + 1,
          displayName: entry.account_name ?? '',
          steamId: entry.accountId ? accountIdToSteamId(entry.accountId) : null,
          avatarUrl: (entry.accountId && avatars?.data[entry.accountId]) || null,
          // Compte choisi parmi plusieurs homonymes (celui au rang le plus élevé).
          inferred: entry.inferred,
          badge:
            rank?.tier != null && rank.subrank != null && rank.name
              ? {
                  tier: rank.tier,
                  subrank: rank.subrank,
                  name: rank.name,
                  imageUrl: rank.imageUrl,
                  badgeId: rank.badgeId,
                  color: rank.color,
                }
              : null,
          topHeroes: [...new Set(entry.top_hero_ids ?? [])].slice(0, 3).map((heroId) => ({
            heroId,
            name: index[heroId]?.name ?? `Héros #${heroId}`,
            imageUrl: index[heroId]?.imageUrl ?? null,
          })),
        };
      });
      return {
        region,
        items,
        coverage: {
          entries: items.length,
          withSteamId: items.filter((i) => i.steamId).length,
          inferredSteamId: items.filter((i) => i.inferred).length,
          withBadge: items.filter((i) => i.badge).length,
          withAvatar: items.filter((i) => i.avatarUrl).length,
          ranksComplete: complete,
        },
        meta: { ...dataMeta(board), isPartial: !heroes || !complete || missingRank },
      };
    },

    async heroStats(heroId: number) {
      // Vérifie l'existence du héros (404) avant d'interroger les agrégats.
      await catalog.hero(heroId);
      const all = await loadHeroMetaTable(deadlock);
      return { stats: all.data[heroId] ?? emptyHeroStats(heroId), meta: dataMeta(all) };
    },

    /**
     * Méta de plusieurs héros en une requête (v1.14.0) : une lecture du catalogue et une lecture
     * de `analytics:hero-stats`, quel que soit le nombre de héros. Sans `heroIds` : tous les héros
     * jouables. Un id inconnu ou non jouable est listé dans `unknownHeroIds` (pas de 404 global).
     */
    async heroStatsBatch(heroIds?: number[]) {
      const [ids, all] = await Promise.all([
        catalog.playableHeroIds(),
        loadHeroMetaTable(deadlock),
      ]);
      const playableSet = new Set(ids.data);
      const playable = (id: number) => playableSet.has(id);
      const requested = heroIds ?? ids.data;
      const known = requested.filter(playable);
      const items = known.map((id) => all.data[id] ?? emptyHeroStats(id));
      return {
        items,
        unknownHeroIds: requested.filter((id) => !playable(id)),
        scope: { period: HERO_META_PERIOD, gameMode: 'normal' as const, matchMode: 'all' as const },
        coverage: {
          requested: requested.length,
          known: known.length,
          withStats: items.filter((s) => s.matches !== null).length,
        },
        meta: dataMeta(all),
      };
    },

    async match(matchId: string) {
      const detail = await loadMatch(matchId);
      if (!detail.data) throw notFound('Partie introuvable.');

      const [heroes, itemIndex, tiers] = await Promise.all([
        heroIndex(),
        items.index().catch(() => null),
        catalog.ranks().catch(() => null),
      ]);
      const index = heroes?.data ?? {};
      const { match: info, names } = detail.data;
      const winningSide = SIDES[info.winningTeam ?? -1] ?? null;

      // Métriques calculées à la lecture (le cache stocke la partie normalisée, pas les dérivés).
      const computed = playerMetrics(info);
      const metrics = new Map(info.players.map((p, i) => [p, computed[i]]));
      const teams = SIDES.map((side, team) => {
        const players = info.players.filter((p) => p.team === team);
        const averageBadge = info.averageBadges[team] || null;
        const averageRank = averageBadge && tiers ? rankFromBadge(averageBadge, tiers.data) : null;
        return {
          side,
          outcome: side === winningSide ? ('win' as const) : ('loss' as const),
          // `outcome` vaut « loss » quand le vainqueur est inconnu (historique) ; `result` → null.
          result: winningSide === null ? null : side === winningSide ? 'win' : 'loss',
          ...teamTotals(players),
          averageBadge,
          averageRankName: averageRank?.name ?? null,
          players: players
            .sort((a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0))
            .map((p) => {
              const steamId = p.accountId ? accountIdToSteamId(p.accountId) : null;
              return {
                steamId,
                displayName: (p.accountId && names[p.accountId]) || steamId || 'Joueur inconnu',
                heroId: p.heroId,
                heroName: index[p.heroId]?.name ?? `Héros #${p.heroId}`,
                heroImageUrl: index[p.heroId]?.imageUrl ?? null,
                level: p.level,
                kills: p.kills,
                deaths: p.deaths,
                assists: p.assists,
                netWorth: p.netWorth,
                lastHits: p.lastHits,
                denies: p.denies,
                mvpRank: p.mvpRank,
                killParticipation: killParticipation(p, players),
                stats: p.stats,
                ...splitItems(p.items, itemIndex),
                ...metrics.get(p),
              };
            }),
        };
      });

      return {
        match: {
          matchId,
          playedAt: info.startTime ? new Date(info.startTime * 1000).toISOString() : null,
          durationSeconds: info.durationSeconds,
          matchMode: toMatchMode(info.matchMode),
          gameMode: toGameMode(info.gameMode),
          winningSide,
          teams,
        },
        meta: {
          ...dataMeta(detail),
          isPartial: !heroes || !itemIndex || !info.startTime,
        },
      };
    },
  };
}

export type MetaService = ReturnType<typeof createMetaService>;
