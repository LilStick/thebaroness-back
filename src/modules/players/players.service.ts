import {
  aggregate,
  appliedFilters,
  filterFingerprint,
  groupByHero,
  hasFilters,
  type HistoryFilter,
  historyFilterSchema,
  modeBreakdown,
  type OverviewFilter,
  periodWindow,
  selectMatches,
} from './profile-stats';
import {
  type GameMode,
  type MatchMode,
  toGameMode,
  toMatchMode,
} from '../../integrations/deadlock/game-modes';
import { cached, type Cached } from '../../database/api-cache';
import type {
  DeadlockApi,
  PlayerSummary,
  SteamProfile,
} from '../../integrations/deadlock/deadlock.api';
import type { RawMatchHistoryEntry } from '../../integrations/deadlock/deadlock.schemas';
import { invalidInput, notFound } from '../../shared/errors';
import { isSteamId64, steamIdToAccountId } from '../../shared/schemas';
import type { CatalogService } from '../catalog/catalog.service';
import { rankFromBadge, UNRANKED, type PlayerRank } from '../catalog/ranks';

/** TTL initiaux (§9.2) : choix du projet, pas des garanties du fournisseur. */
const TTL = {
  search: 5 * 60_000,
  profile: 15 * 60_000,
  history: 3 * 60_000,
} as const;

const SEARCH_LIMIT = 20;
/** Héros mis en avant par `/overview`. */
const TOP_HEROES = 3;

/** Délai minimum entre deux appels au fournisseur pour un même joueur lors d'un refresh forcé. */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

/** `refresh` : relit le fournisseur si la copie a plus de {@link REFRESH_MIN_INTERVAL_MS}. */
export interface ReadOptions {
  refresh?: boolean;
}

const maxAge = (options?: ReadOptions) => (options?.refresh ? REFRESH_MIN_INTERVAL_MS : undefined);

/** Métadonnées de fraîcheur (§19.4) jointes à toute réponse issue de Deadlock API. */
export interface DataMeta {
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  isStale: boolean;
  isPartial: boolean;
}

export interface PlayerStats {
  matchesPlayed: number | null;
  wins: number | null;
  losses: number | null;
  winRate: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  kda: number | null;
}

export interface MatchSummary {
  matchId: string;
  playedAt: string;
  heroId: number;
  heroName: string;
  /** Portrait du héros, `null` si le catalogue est indisponible. */
  heroImageUrl: string | null;
  outcome: 'win' | 'loss';
  durationSeconds: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  netWorth: number | null;
  /** Type de partie (`ranked`, `unranked`, `private_lobby`…), null si inconnu. */
  matchMode: MatchMode | null;
  /** Mode de jeu (`normal`, `street_brawl`…), null si inconnu. */
  gameMode: GameMode | null;
}

/**
 * Partie compacte stockée en cache : seulement les parties classées victoire/défaite
 * (`player_match_outcome` 1 ou 2), triées de la plus récente à la plus ancienne.
 */
export interface StoredMatch {
  matchId: string;
  heroId: number;
  startTime: number;
  win: boolean;
  duration: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  netWorth: number | null;
  /** `ranked_display_badge` (tier * 10 + subrank) en partie classée, sinon `null`. */
  badge: number | null;
  /** Absents des copies en cache antérieures à leur ajout : lire avec `?? null`. */
  matchMode?: MatchMode | null;
  gameMode?: GameMode | null;
}

const NULL_STATS: PlayerStats = {
  matchesPlayed: null,
  wins: null,
  losses: null,
  winRate: null,
  kills: null,
  deaths: null,
  assists: null,
  kda: null,
};

const round2 = (value: number) => Math.round(value * 100) / 100;

function toStoredMatches(entries: RawMatchHistoryEntry[]): StoredMatch[] {
  return entries
    .filter((entry) => entry.player_match_outcome === 1 || entry.player_match_outcome === 2)
    .map((entry) => ({
      matchId: String(entry.match_id),
      heroId: entry.hero_id,
      startTime: entry.start_time,
      win: entry.player_match_outcome === 1,
      duration: entry.match_duration_s ?? null,
      kills: entry.player_kills ?? null,
      deaths: entry.player_deaths ?? null,
      assists: entry.player_assists ?? null,
      netWorth: entry.net_worth ?? null,
      badge: entry.ranked_display_badge || null,
      matchMode: toMatchMode(entry.match_mode),
      gameMode: toGameMode(entry.game_mode),
    }))
    .sort((a, b) => b.startTime - a.startTime || Number(BigInt(b.matchId) - BigInt(a.matchId)));
}

/**
 * Agrégats sur les parties disponibles (victoires/défaites). Les totaux K/D/A ne comptent
 * que les parties où la valeur est connue ; tout inconnu reste `null`, jamais 0 (§19.4).
 */
export function computeStats(matches: StoredMatch[]): PlayerStats {
  if (matches.length === 0) return { ...NULL_STATS, matchesPlayed: 0, wins: 0, losses: 0 };

  let wins = 0;
  const totals = { kills: 0, deaths: 0, assists: 0 };
  const known = { kills: 0, deaths: 0, assists: 0 };
  for (const match of matches) {
    if (match.win) wins++;
    for (const field of ['kills', 'deaths', 'assists'] as const) {
      const value = match[field];
      if (value !== null) {
        totals[field] += value;
        known[field]++;
      }
    }
  }
  const total = (field: keyof typeof totals) => (known[field] ? totals[field] : null);
  const kills = total('kills');
  const deaths = total('deaths');
  const assists = total('assists');

  return {
    matchesPlayed: matches.length,
    wins,
    losses: matches.length - wins,
    winRate: round2((wins / matches.length) * 100),
    kills,
    deaths,
    assists,
    kda:
      kills !== null && deaths !== null && assists !== null
        ? round2((kills + assists) / Math.max(deaths, 1))
        : null,
  };
}

interface Cursor {
  startTime: number;
  matchId: string;
}

/** Curseur opaque (base64url) : position de la dernière partie renvoyée. */
/**
 * Curseur opaque (base64url) : position de la dernière partie renvoyée, suivie de l'empreinte
 * des filtres quand il y en a. Un curseur sans empreinte (v1.8) reste valable sans filtre.
 */
const encodeCursor = ({ startTime, matchId }: Cursor, fingerprint?: string) =>
  Buffer.from(`${startTime}:${matchId}${fingerprint ? `:${fingerprint}` : ''}`).toString(
    'base64url',
  );

function decodeCursor(cursor: string, fingerprint?: string): Cursor {
  const match = /^(\d{1,12}):(\d{1,20})(?::([\w-]{10}))?$/.exec(
    Buffer.from(cursor, 'base64url').toString(),
  );
  if (!match?.[1] || !match[2]) throw invalidInput('cursor : curseur invalide');
  if (match[3] !== fingerprint) {
    throw invalidInput('cursor : curseur obtenu avec d’autres filtres, recommencer sans curseur');
  }
  return { startTime: Number(match[1]), matchId: match[2] };
}

/** Vrai si `match` vient strictement après le curseur dans l'ordre décroissant. */
function isAfterCursor(match: StoredMatch, cursor: Cursor): boolean {
  if (match.startTime !== cursor.startTime) return match.startTime < cursor.startTime;
  return BigInt(match.matchId) < BigInt(cursor.matchId);
}

const meta = (
  sources: Array<Pick<Cached<unknown>, 'fetchedAt' | 'isStale'>>,
  extra: Partial<DataMeta> = {},
): DataMeta => ({
  // Date de la donnée la plus ancienne utilisée.
  fetchedAt: new Date(Math.min(...sources.map((s) => s.fetchedAt.getTime()))).toISOString(),
  sourceUpdatedAt: null,
  isStale: sources.some((s) => s.isStale),
  isPartial: false,
  ...extra,
});

export function createPlayersService(deadlock: DeadlockApi, catalog: CatalogService) {
  const profileOf = (accountId: number, options?: ReadOptions) =>
    cached<SteamProfile | null>(
      `profile:${accountId}`,
      { ttlMs: TTL.profile, maxAgeMs: maxAge(options) },
      () => deadlock.getSteamProfile(accountId),
    );

  const historyOf = (accountId: number, options?: ReadOptions) =>
    cached<StoredMatch[]>(
      `history:${accountId}`,
      { ttlMs: TTL.history, maxAgeMs: maxAge(options) },
      async () => toStoredMatches(await deadlock.getMatchHistory(accountId)),
    );

  /** Profil existant ou 404 (un joueur introuvable n'est pas une absence de statistiques). */
  async function requireProfile(steamId: string, options?: ReadOptions) {
    const profile = await profileOf(steamIdToAccountId(steamId), options);
    if (!profile.data) throw notFound('Joueur introuvable.');
    return profile as Cached<SteamProfile>;
  }

  return {
    async search(query: string): Promise<{ items: PlayerSummary[]; meta: DataMeta }> {
      // Un SteamID64 est recherché par account_id (format attendu par le fournisseur).
      const term = isSteamId64(query) ? String(steamIdToAccountId(query)) : query;
      const result = await cached(`search:${term.toLowerCase()}`, { ttlMs: TTL.search }, () =>
        deadlock.searchPlayers(term, SEARCH_LIMIT),
      );
      return { items: result.data, meta: meta([result]) };
    },

    async profile(steamId: string, options?: ReadOptions) {
      const accountId = steamIdToAccountId(steamId);
      // Profil et historique en parallèle ; l'historique est partagé avec /matches.
      const [profile, history, ranks] = await Promise.allSettled([
        requireProfile(steamId, options),
        historyOf(accountId, options),
        catalog.ranks(),
      ]);
      if (profile.status === 'rejected') throw profile.reason;

      const { region, sourceUpdatedAt, ...player } = profile.value.data;
      const hasHistory = history.status === 'fulfilled';
      // Rang = badge de la partie classée la plus récente (l'historique est trié du plus récent).
      const badge = hasHistory ? (history.value.data.find((m) => m.badge)?.badge ?? null) : null;
      const rank: PlayerRank =
        badge && ranks.status === 'fulfilled' ? rankFromBadge(badge, ranks.value.data) : UNRANKED;
      return {
        player: { ...player, region },
        stats: hasHistory ? computeStats(history.value.data) : NULL_STATS,
        rank,
        meta: meta(hasHistory ? [profile.value, history.value] : [profile.value], {
          sourceUpdatedAt,
          isPartial: !hasHistory || (Boolean(badge) && ranks.status === 'rejected'),
        }),
      };
    },

    /**
     * Historique paginé. Filtres optionnels appliqués à tout l'historique en cache AVANT le tri
     * et la pagination ; sans filtre, comportement v1.8 inchangé.
     */
    async matches(
      steamId: string,
      limit: number,
      cursor?: string,
      filter: HistoryFilter = historyFilterSchema.parse({}),
    ) {
      const filtered = hasFilters(filter);
      const fingerprint = filtered ? filterFingerprint(filter) : undefined;
      const after = cursor ? decodeCursor(cursor, fingerprint) : null;
      const accountId = steamIdToAccountId(steamId);
      const [, history, heroes, seasonStart] = await Promise.all([
        requireProfile(steamId),
        historyOf(accountId),
        // Catalogue facultatif : sans lui, nom de repli et réponse marquée partielle.
        catalog.heroIndex().catch(() => null),
        filter.period === 'season' ? catalog.seasonStart().catch(() => null) : null,
      ]);
      const window = periodWindow(filter.period, Date.now(), seasonStart);
      const list = filtered ? selectMatches(history.data, filter, window).matches : history.data;

      const start = after ? list.findIndex((m) => isAfterCursor(m, after)) : 0;
      const page = start === -1 ? [] : list.slice(start, start + limit);
      const last = page.at(-1);
      const hasMore = start !== -1 && start + limit < list.length;
      const index = heroes?.data ?? {};

      return {
        items: page.map((m): MatchSummary => ({
          matchId: m.matchId,
          playedAt: new Date(m.startTime * 1000).toISOString(),
          heroId: m.heroId,
          heroName: index[m.heroId]?.name ?? `Héros #${m.heroId}`,
          heroImageUrl: index[m.heroId]?.imageUrl ?? null,
          outcome: m.win ? 'win' : 'loss',
          durationSeconds: m.duration,
          kills: m.kills,
          deaths: m.deaths,
          assists: m.assists,
          netWorth: m.netWorth,
          matchMode: m.matchMode ?? null,
          gameMode: m.gameMode ?? null,
        })),
        nextCursor: hasMore && last ? encodeCursor(last, fingerprint) : null,
        appliedFilters: appliedFilters(filter),
        meta: meta(heroes ? [history, heroes] : [history], {
          isPartial: !heroes || window.seasonUnknown,
        }),
      };
    },

    /**
     * Profil V2 : agrégats d'une période exacte, combinaisons de modes observées, top 3 héros et
     * couverture. Calculé depuis l'historique en cache (aucun appel supplémentaire au fournisseur).
     */
    async overview(steamId: string, filter: OverviewFilter) {
      const accountId = steamIdToAccountId(steamId);
      const [, history, heroes, seasonStart] = await Promise.all([
        requireProfile(steamId),
        historyOf(accountId),
        catalog.heroIndex().catch(() => null),
        filter.period === 'season' ? catalog.seasonStart().catch(() => null) : null,
      ]);
      const now = Date.now();
      const window = periodWindow(filter.period, now, seasonStart);
      const selection = selectMatches(history.data, filter, window);
      const { matches } = selection;
      const index = heroes?.data ?? {};
      const notes = [
        ...(window.seasonUnknown ? ['season_start_unknown'] : []),
        ...(selection.excludedUnknownMode ? ['unknown_mode_excluded'] : []),
        ...(selection.unknownModeMatches ? ['unknown_mode_included'] : []),
        ...(history.isStale ? ['history_stale'] : []),
      ];
      const iso = (seconds: number | undefined) =>
        seconds === undefined ? null : new Date(seconds * 1000).toISOString();

      return {
        filters: filter,
        summary: { ...aggregate(matches), lastMatchAt: iso(matches[0]?.startTime) },
        modes: modeBreakdown(matches),
        topHeroes: groupByHero(matches)
          .slice(0, TOP_HEROES)
          .map(([heroId, list]) => {
            const stats = aggregate(list);
            return {
              heroId,
              heroName: index[heroId]?.name ?? `Héros #${heroId}`,
              heroImageUrl: index[heroId]?.imageUrl ?? null,
              matches: stats.matches,
              wins: stats.wins,
              losses: stats.losses,
              winRate: stats.winRate,
              kda: stats.kda,
              kdaSampleSize: stats.kdaSampleSize,
            };
          }),
        coverage: {
          requestedFrom: iso(window.from ?? undefined),
          requestedTo: new Date(window.to * 1000).toISOString(),
          // Historique trié du plus récent au plus ancien.
          observedFrom: iso(matches.at(-1)?.startTime),
          observedTo: iso(matches[0]?.startTime),
          includedMatches: matches.length,
          excludedUnknownMode: selection.excludedUnknownMode,
          unknownModeMatches: selection.unknownModeMatches,
          isPartial: window.seasonUnknown,
          notes,
        },
        meta: meta(heroes ? [history, heroes] : [history], {
          isPartial: !heroes || window.seasonUnknown,
        }),
      };
    },

    /** Profil et historique bruts d'un joueur (cache partagé), pour la comparaison de groupe. */
    async member(steamId: string, options?: ReadOptions) {
      const [profile, history] = await Promise.all([
        requireProfile(steamId, options),
        historyOf(steamIdToAccountId(steamId), options),
      ]);
      return { profile, history };
    },

    /**
     * Statistiques par héros, filtrables (période, modes). KDA sur les parties où K, D et A sont
     * connus (`kdaSampleSize`) ; net worth/min = moyenne des ratios par partie.
     */
    async heroes(steamId: string, filter: HistoryFilter = historyFilterSchema.parse({})) {
      const [, history, heroes, seasonStart] = await Promise.all([
        requireProfile(steamId),
        historyOf(steamIdToAccountId(steamId)),
        catalog.heroIndex().catch(() => null),
        filter.period === 'season' ? catalog.seasonStart().catch(() => null) : null,
      ]);
      const window = periodWindow(filter.period, Date.now(), seasonStart);
      const { matches } = selectMatches(history.data, filter, window);
      const index = heroes?.data ?? {};
      const items = groupByHero(matches).map(([heroId, list]) => {
        const stats = aggregate(list);
        return {
          heroId,
          heroName: index[heroId]?.name ?? `Héros #${heroId}`,
          heroImageUrl: index[heroId]?.imageUrl ?? null,
          matches: stats.matches,
          wins: stats.wins,
          losses: stats.losses,
          winRate: stats.winRate,
          kda: stats.kda,
          kdaSampleSize: stats.kdaSampleSize,
          avgNetWorthPerMinute: stats.avgNetWorthPerMinute,
          netWorthPerMinuteSampleSize: stats.netWorthPerMinuteSampleSize,
        };
      });
      return {
        items,
        appliedFilters: appliedFilters(filter),
        meta: meta(heroes ? [history, heroes] : [history], {
          isPartial: !heroes || window.seasonUnknown,
        }),
      };
    },
  };
}

export type PlayersService = ReturnType<typeof createPlayersService>;
