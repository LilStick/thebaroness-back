import { combineMeta } from '../../shared/data-meta';
import { rawKda, round2 } from '../../shared/metrics';
import { AppError } from '../../shared/errors';
import { rankFromBadge, rankScore, type PlayerRank, type RankTier } from '../catalog/ranks';
import type { CatalogService } from '../catalog/catalog.service';
import type { HeroIndexEntry } from '../catalog/heroes';
import {
  computeStats,
  type PlayersService,
  type ReadOptions,
  type StoredMatch,
} from '../players/players.service';
import type { GroupDto } from './group.model';

export const COMPARE_PERIODS = ['7d', '30d', 'season'] as const;
export type ComparePeriod = (typeof COMPARE_PERIODS)[number];

const DAY_MS = 86_400_000;
const PERIOD_DAYS: Record<Exclude<ComparePeriod, 'season'>, number> = { '7d': 7, '30d': 30 };

export interface BestMatch {
  matchId: string;
  playedAt: string;
  heroName: string;
  heroImageUrl: string | null;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number | null;
  kda: number | null;
}

export interface GroupMemberStats {
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  rank: PlayerRank | null;
  matches: number;
  wins: number;
  losses: number;
  winRate: number | null;
  kda: number | null;
  longestWinStreak: number;
  bestMatch: BestMatch | null;
  /** Du plus ancien au plus récent ; `score = tier * 6 + subrank`, `badge = tier * 10 + subrank`. */
  rankHistory: { at: string; score: number; badge: number }[];
  /** v1.12.0 : parties de la période où K, D et A sont tous connus (dénominateur du KDA). */
  kdaSampleSize: number;
  /** v1.12.0 : `rankScore` du rang actuel (`rank`), `null` si non classé. */
  currentRankScore: number | null;
  /** v1.12.0 : dernier − premier score de `rankHistory` ; `null` sous 2 points. */
  rankDelta: number | null;
}

/** Seuil de parties pour les highlights de ratio (winrate, KDA). */
export const HIGHLIGHT_MIN_MATCHES = 5;

export const HIGHLIGHT_KEYS = [
  'biggest_climb',
  'best_win_rate',
  'most_wins',
  'best_kda',
  'longest_win_streak',
  'best_match',
] as const;
export type HighlightKey = (typeof HIGHLIGHT_KEYS)[number];

export interface GroupHighlight {
  key: HighlightKey;
  /** Gagnants dans l'ordre des membres du groupe (plusieurs en cas d'égalité) ; vide si aucun. */
  steamIds: string[];
  value: number | null;
  /** `best_match` seulement : partie retenue du premier gagnant. */
  matchId: string | null;
  /** Membres éligibles (valeur connue, seuil de parties atteint). */
  eligibleMembers: number;
  minMatches: number;
}

/**
 * Highlights de groupe. Règles : valeur strictement positive ; égalité → tous les ex æquo,
 * dans l'ordre du groupe ; winrate et KDA seulement à partir de `HIGHLIGHT_MIN_MATCHES` parties.
 */
export function groupHighlights(members: GroupMemberStats[]): GroupHighlight[] {
  const rules: Record<
    HighlightKey,
    { value: (m: GroupMemberStats) => number | null; minMatches: number }
  > = {
    biggest_climb: { value: (m) => m.rankDelta, minMatches: 0 },
    best_win_rate: { value: (m) => m.winRate, minMatches: HIGHLIGHT_MIN_MATCHES },
    most_wins: { value: (m) => m.wins, minMatches: 0 },
    best_kda: { value: (m) => m.kda, minMatches: HIGHLIGHT_MIN_MATCHES },
    longest_win_streak: { value: (m) => m.longestWinStreak, minMatches: 0 },
    best_match: { value: (m) => m.bestMatch?.kda ?? null, minMatches: 0 },
  };
  return HIGHLIGHT_KEYS.map((key) => {
    const rule = rules[key];
    const eligible = members.flatMap((m) => {
      const value = rule.value(m);
      return value !== null && m.matches >= rule.minMatches ? [{ m, value }] : [];
    });
    const top = Math.max(...eligible.map((e) => e.value));
    const winners = top > 0 ? eligible.filter((e) => e.value === top) : [];
    return {
      key,
      steamIds: winners.map((w) => w.m.steamId),
      value: winners.length ? top : null,
      matchId: key === 'best_match' ? (winners[0]?.m.bestMatch?.matchId ?? null) : null,
      eligibleMembers: eligible.length,
      minMatches: rule.minMatches,
    };
  });
}

/** Plus longue série de victoires consécutives, dans l'ordre chronologique. */
export function longestWinStreak(chronological: StoredMatch[]): number {
  let best = 0;
  let current = 0;
  for (const match of chronological) {
    current = match.win ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

/** Meilleure partie par KDA `(K + A) / max(D, 1)` ; à égalité, la plus récente. */
export function bestMatchOf(
  matches: StoredMatch[],
  heroes: Record<string, HeroIndexEntry>,
): BestMatch | null {
  let best: { match: StoredMatch; kda: number } | null = null;
  for (const match of matches) {
    const kda = rawKda(match.kills, match.deaths, match.assists);
    if (kda === null) continue;
    if (!best || kda > best.kda) best = { match, kda };
  }
  if (!best) return null;
  const { match } = best;
  return {
    matchId: match.matchId,
    playedAt: new Date(match.startTime * 1000).toISOString(),
    heroName: heroes[match.heroId]?.name ?? `Héros #${match.heroId}`,
    heroImageUrl: heroes[match.heroId]?.imageUrl ?? null,
    kills: match.kills as number,
    deaths: match.deaths as number,
    assists: match.assists as number,
    netWorth: match.netWorth,
    kda: round2(best.kda),
  };
}

/** Statistiques d'un membre sur la période (`history` trié du plus récent au plus ancien). */
export function memberStats(
  history: StoredMatch[],
  sinceSeconds: number | null,
  tiers: RankTier[] | null,
  heroes: Record<string, HeroIndexEntry>,
): Omit<GroupMemberStats, 'steamId' | 'displayName' | 'avatarUrl'> {
  const inPeriod =
    sinceSeconds === null ? history : history.filter((m) => m.startTime >= sinceSeconds);
  const chronological = [...inPeriod].reverse();
  const stats = computeStats(inPeriod);
  // Rang actuel : dernière partie classée connue, même hors période.
  const latestBadge = history.find((m) => m.badge)?.badge ?? null;
  const rank = latestBadge && tiers ? rankFromBadge(latestBadge, tiers) : null;
  const rankHistory = chronological
    .filter((m): m is StoredMatch & { badge: number } => Boolean(m.badge))
    .map((m) => ({
      at: new Date(m.startTime * 1000).toISOString(),
      score: rankScore(m.badge),
      badge: m.badge,
    }));

  return {
    rank: rank?.badgeId ? rank : null,
    matches: inPeriod.length,
    wins: stats.wins ?? 0,
    losses: stats.losses ?? 0,
    winRate: stats.winRate,
    kda: stats.kda,
    longestWinStreak: longestWinStreak(chronological),
    bestMatch: bestMatchOf(inPeriod, heroes),
    rankHistory,
    kdaSampleSize: inPeriod.filter(
      (m) => m.kills !== null && m.deaths !== null && m.assists !== null,
    ).length,
    currentRankScore: rank?.badgeId ? rankScore(rank.badgeId) : null,
    rankDelta:
      rankHistory.length >= 2
        ? (rankHistory.at(-1) as { score: number }).score -
          (rankHistory[0] as { score: number }).score
        : null,
  };
}

export function createGroupCompareService(players: PlayersService, catalog: CatalogService) {
  async function periodStart(period: ComparePeriod, now: number): Promise<number | null> {
    if (period !== 'season') return Math.floor((now - PERIOD_DAYS[period] * DAY_MS) / 1000);
    // Saison inconnue : toutes les parties disponibles (contrat).
    return catalog.seasonStart().catch(() => null);
  }

  return async function compare(group: GroupDto, period: ComparePeriod, options?: ReadOptions) {
    const now = Date.now();
    const [since, members, tiers, heroes] = await Promise.all([
      periodStart(period, now),
      Promise.allSettled(group.steamIds.map((steamId) => players.member(steamId, options))),
      catalog.ranks().catch(() => null),
      catalog.heroIndex().catch(() => null),
    ]);

    const available = members.flatMap((result, i) =>
      result.status === 'fulfilled'
        ? [{ steamId: group.steamIds[i] as string, ...result.value }]
        : [],
    );
    if (available.length === 0) {
      throw new AppError(
        503,
        'SERVICE_UNAVAILABLE',
        'Les statistiques des membres sont temporairement indisponibles.',
      );
    }

    const sources = available.flatMap((m) => [m.profile, m.history]);
    const memberList = available.map(({ steamId, profile, history }): GroupMemberStats => ({
      steamId,
      displayName: profile.data.displayName,
      avatarUrl: profile.data.avatarUrl,
      ...memberStats(history.data, since, tiers?.data ?? null, heroes?.data ?? {}),
    }));
    return {
      group,
      period,
      members: memberList,
      highlights: groupHighlights(memberList),
      methodology: {
        periodFrom: since === null ? null : new Date(since * 1000).toISOString(),
        rankScore: 'tier * 6 + subrank',
        kda: '(kills + assists) / max(deaths, 1) sur les parties complètes',
        highlightMinMatches: HIGHLIGHT_MIN_MATCHES,
        ties: 'all_tied_members_in_group_order',
      },
      meta: combineMeta(sources, {
        // Membre omis, ou rangs/héros indisponibles.
        isPartial: available.length < group.steamIds.length || !tiers || !heroes,
      }),
    };
  };
}

export type GroupCompare = ReturnType<typeof createGroupCompareService>;
