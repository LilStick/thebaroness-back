import { combineMeta } from '../../shared/data-meta';
import { percent, rawKda, round2 } from '../../shared/metrics';
import { AppError } from '../../shared/errors';
import {
  rankFromBadge,
  rankScore,
  seasonAt,
  seasonRankDelta,
  type PlayerRank,
  type RankTier,
} from '../catalog/ranks';
import type { RankedSeason } from '../../integrations/deadlock/deadlock.api';
import {
  periodWindow,
  selectMatches,
  type GAME_MODE_FILTERS,
  type MATCH_MODE_FILTERS,
  type PeriodWindow,
} from '../players/profile-stats';

type GameModeFilter = (typeof GAME_MODE_FILTERS)[number];
type MatchModeFilter = (typeof MATCH_MODE_FILTERS)[number];
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
  rankHistory: { at: string; score: number; badge: number; season: number | null }[];
  /** v1.12.0 : parties de la période où K, D et A sont tous connus (dénominateur du KDA). */
  kdaSampleSize: number;
  /** v1.12.0 : `rankScore` du rang actuel (`rank`), `null` si non classé. */
  currentRankScore: number | null;
  /**
   * Dernier − premier score de `rankHistory` parmi les points de la même saison que le dernier
   * (v1.15.0 ; v1.12–1.14 : toute la période) ; `null` sous 2 points comparables.
   */
  rankDelta: number | null;
  /** v1.15.0 : parties écartées par un filtre de mode précis car leur mode est inconnu. */
  excludedUnknownModeMatches: number;
  /** v1.15.0 : fenêtre de même durée juste avant (7d, 30d) ; `null` pour la saison. */
  previous: {
    from: string;
    to: string;
    matches: number;
    wins: number;
    winRate: number | null;
    kda: number | null;
    kdaSampleSize: number;
  } | null;
  /** v1.15.0 : écarts actuel − précédent ; winrate et KDA `null` sous 5 parties de chaque côté. */
  deltaVsPrevious: { matches: number; winRate: number | null; kda: number | null } | null;
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

/** Filtres de la comparaison (mêmes valeurs et défauts qu'`/overview`). */
export interface CompareFilter {
  gameMode: GameModeFilter;
  matchMode: MatchModeFilter;
}

/** Fenêtre de même durée juste avant `window` (7d/30d), `null` pour la saison. */
export function previousWindow(period: ComparePeriod, window: PeriodWindow): PeriodWindow | null {
  if (period === 'season' || window.from === null) return null;
  const span = window.to - window.from;
  return { from: window.from - span, to: window.from - 1, seasonUnknown: false };
}

/** Agrégat compact d'une fenêtre (précédente). */
function windowSummary(matches: StoredMatch[], window: PeriodWindow) {
  const stats = computeStats(matches);
  return {
    from: new Date((window.from ?? 0) * 1000).toISOString(),
    to: new Date(window.to * 1000).toISOString(),
    matches: matches.length,
    wins: stats.wins ?? 0,
    winRate: stats.winRate,
    kda: stats.kda,
    kdaSampleSize: matches.filter(
      (m) => m.kills !== null && m.deaths !== null && m.assists !== null,
    ).length,
  };
}

/**
 * Statistiques d'un membre. `history` est trié du plus récent au plus ancien ; les filtres de mode
 * et la période s'appliquent avant toute agrégation (une partie au mode inconnu n'est retenue
 * qu'avec le filtre « all »).
 */
export function memberStats(
  history: StoredMatch[],
  window: PeriodWindow,
  tiers: RankTier[] | null,
  heroes: Record<string, HeroIndexEntry>,
  options: {
    filter?: CompareFilter;
    previous?: PeriodWindow | null;
    seasons?: RankedSeason[] | null;
  } = {},
): Omit<GroupMemberStats, 'steamId' | 'displayName' | 'avatarUrl'> {
  const filter = options.filter ?? { gameMode: 'all', matchMode: 'all' };
  const selection = selectMatches(history, filter, window);
  const inPeriod = selection.matches;
  const chronological = [...inPeriod].reverse();
  const stats = computeStats(inPeriod);
  // Rang actuel : dernière partie classée connue, même hors période et hors filtre.
  const latestBadge = history.find((m) => m.badge)?.badge ?? null;
  const rank = latestBadge && tiers ? rankFromBadge(latestBadge, tiers) : null;
  const seasons = options.seasons ?? null;
  const rankHistory = chronological
    .filter((m): m is StoredMatch & { badge: number } => Boolean(m.badge))
    .map((m) => ({
      at: new Date(m.startTime * 1000).toISOString(),
      score: rankScore(m.badge),
      badge: m.badge,
      season: seasons ? seasonAt(m.startTime, seasons) : null,
    }));
  const kdaSampleSize = inPeriod.filter(
    (m) => m.kills !== null && m.deaths !== null && m.assists !== null,
  ).length;

  const previousMatches = options.previous
    ? selectMatches(history, filter, options.previous).matches
    : null;
  const previous =
    previousMatches && options.previous ? windowSummary(previousMatches, options.previous) : null;
  const comparable = (a: number, b: number) =>
    a >= HIGHLIGHT_MIN_MATCHES && b >= HIGHLIGHT_MIN_MATCHES;
  const diff = (a: number | null, b: number | null) =>
    a === null || b === null ? null : round2(a - b);

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
    kdaSampleSize,
    currentRankScore: rank?.badgeId ? rankScore(rank.badgeId) : null,
    // Progression sur la dernière saison de la période : deux saisons ne se comparent pas.
    rankDelta: seasonRankDelta(rankHistory),
    excludedUnknownModeMatches: selection.excludedUnknownMode,
    previous,
    deltaVsPrevious: previous
      ? {
          matches: inPeriod.length - previous.matches,
          winRate: comparable(inPeriod.length, previous.matches)
            ? diff(stats.winRate, previous.winRate)
            : null,
          kda: comparable(kdaSampleSize, previous.kdaSampleSize)
            ? diff(stats.kda, previous.kda)
            : null,
        }
      : null,
  };
}

/** Relation exacte entre deux membres, déduite de l'intersection de leurs historiques. */
export interface GroupPair {
  steamIds: [string, string];
  /** Même partie, même résultat : forcément la même équipe (une seule équipe gagne). */
  together: {
    matches: number;
    wins: number;
    losses: number;
    winRate: number | null;
    lastPlayedAt: string | null;
  };
  /** Même partie, résultats opposés : équipes adverses. `firstWins` : victoires de `steamIds[0]`. */
  against: { matches: number; firstWins: number };
}

/**
 * Paires de membres ayant au moins une partie commune dans la sélection (période et modes).
 * Calcul exact sur les historiques déjà chargés : aucun appel externe. Une partie abandonnée ou
 * non scorée par l'un des deux n'apparaît pas dans son historique et n'est pas comptée.
 */
export function groupPairs(members: Array<{ steamId: string; matches: StoredMatch[] }>) {
  const indexes = members.map((m) => new Map(m.matches.map((x) => [x.matchId, x])));
  const items: GroupPair[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = indexes[i] as Map<string, StoredMatch>;
      const b = indexes[j] as Map<string, StoredMatch>;
      const [small, other, flip] = a.size <= b.size ? [a, b, false] : [b, a, true];
      let together = 0;
      let wins = 0;
      let last = 0;
      let against = 0;
      let firstWins = 0;
      for (const [matchId, x] of small) {
        const y = other.get(matchId);
        if (!y) continue;
        if (x.win === y.win) {
          together++;
          if (x.win) wins++;
          last = Math.max(last, x.startTime);
        } else {
          against++;
          // Victoire du premier membre de la paire (ordre du groupe).
          if ((flip ? y : x).win) firstWins++;
        }
      }
      if (together === 0 && against === 0) continue;
      items.push({
        steamIds: [members[i]?.steamId as string, members[j]?.steamId as string],
        together: {
          matches: together,
          wins,
          losses: together - wins,
          winRate: percent(wins, together),
          lastPlayedAt: last ? new Date(last * 1000).toISOString() : null,
        },
        against: { matches: against, firstWins },
      });
    }
  }
  // Paires les plus jouées ensemble d'abord ; à égalité, ordre du groupe (tri stable).
  items.sort((x, y) => y.together.matches - x.together.matches);
  const n = members.length;
  return { items, pairsEvaluated: (n * (n - 1)) / 2 };
}

/** Raison d'indisponibilité d'un membre, seulement quand l'erreur source permet de l'établir. */
export type UnavailableReason =
  'not_found' | 'rate_limited' | 'timeout' | 'provider_error' | 'unknown';

export function unavailableReason(error: unknown): UnavailableReason {
  if (!(error instanceof AppError)) return 'unknown';
  if (error.status === 404) return 'not_found';
  if (error.upstreamReason === 'rate_limited') return 'rate_limited';
  if (error.upstreamReason === 'timeout') return 'timeout';
  if (error.status === 502 || error.status === 503) return 'provider_error';
  return 'unknown';
}

export interface CompareOptions extends ReadOptions {
  filter?: CompareFilter;
  includePairs?: boolean;
}

export function createGroupCompareService(players: PlayersService, catalog: CatalogService) {
  async function periodWindowOf(period: ComparePeriod, now: number): Promise<PeriodWindow> {
    // Saison inconnue : toutes les parties disponibles (contrat).
    const seasonStart = period === 'season' ? await catalog.seasonStart().catch(() => null) : null;
    return periodWindow(period, now, seasonStart);
  }

  return async function compare(
    group: GroupDto,
    period: ComparePeriod,
    options: CompareOptions = {},
  ) {
    const filter = options.filter ?? { gameMode: 'all', matchMode: 'all' };
    const readOptions = options.refresh ? { refresh: true } : undefined;
    const [window, members, tiers, heroes, seasons] = await Promise.all([
      periodWindowOf(period, Date.now()),
      Promise.allSettled(group.steamIds.map((steamId) => players.member(steamId, readOptions))),
      catalog.ranks().catch(() => null),
      catalog.heroIndex().catch(() => null),
      catalog.rankedSeasons().catch(() => null),
    ]);

    const available = members.flatMap((result, i) =>
      result.status === 'fulfilled'
        ? [{ steamId: group.steamIds[i] as string, ...result.value }]
        : [],
    );
    const unavailable = members.flatMap((result, i) =>
      result.status === 'rejected'
        ? [{ steamId: group.steamIds[i] as string, reason: unavailableReason(result.reason) }]
        : [],
    );
    if (available.length === 0) {
      throw new AppError(
        503,
        'SERVICE_UNAVAILABLE',
        'Les statistiques des membres sont temporairement indisponibles.',
      );
    }

    const previous = previousWindow(period, window);
    const sources = available.flatMap((m) => [m.profile, m.history]);
    const memberList = available.map(({ steamId, profile, history }): GroupMemberStats => ({
      steamId,
      displayName: profile.data.displayName,
      avatarUrl: profile.data.avatarUrl,
      ...memberStats(history.data, window, tiers?.data ?? null, heroes?.data ?? {}, {
        filter,
        previous,
        seasons,
      }),
    }));
    const iso = (seconds: number | null) =>
      seconds === null ? null : new Date(seconds * 1000).toISOString();
    const seasonsInPeriod = (seasons ?? []).filter(
      (s) =>
        (s.endAt === null || window.from === null || s.endAt > window.from) &&
        s.startAt <= window.to,
    );

    let pairs = undefined;
    if (options.includePairs) {
      const { items, pairsEvaluated } = groupPairs(
        available.map((m) => ({
          steamId: m.steamId,
          matches: selectMatches(m.history.data, filter, window).matches,
        })),
      );
      pairs = {
        scope: {
          relation: 'same_team' as const,
          partyConfirmed: false,
          basis: 'match_history_intersection' as const,
          period,
          gameMode: filter.gameMode,
          matchMode: filter.matchMode,
        },
        items,
        coverage: {
          membersIncluded: available.length,
          membersMissing: unavailable.map((u) => u.steamId),
          pairsEvaluated,
          pairsWithCommonMatches: items.length,
        },
      };
    }

    return {
      group,
      period,
      appliedFilters: { period, gameMode: filter.gameMode, matchMode: filter.matchMode },
      members: memberList,
      unavailable,
      highlights: groupHighlights(memberList),
      ...(pairs ? { pairs } : {}),
      methodology: {
        periodFrom: iso(window.from),
        rankScore: 'tier * 6 + subrank',
        kda: '(kills + assists) / max(deaths, 1) sur les parties complètes',
        highlightMinMatches: HIGHLIGHT_MIN_MATCHES,
        ties: 'all_tied_members_in_group_order',
        rankDeltaScope: 'latest_season_in_period' as const,
        seasons: seasonsInPeriod.map((s) => ({
          season: s.season,
          name: s.name,
          startedAt: iso(s.startAt),
          endedAt: iso(s.endAt),
        })),
        seasonBoundariesKnown: seasons !== null,
        previousPeriod: previous ? { from: iso(previous.from), to: iso(previous.to) } : null,
      },
      meta: combineMeta(sources, {
        // Membre omis, ou rangs/héros indisponibles.
        isPartial: unavailable.length > 0 || !tiers || !heroes,
      }),
    };
  };
}

export type GroupCompare = ReturnType<typeof createGroupCompareService>;
