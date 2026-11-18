import { combineMeta, type DataMeta } from '../../shared/data-meta';
import { kda, percent, round2 } from '../../shared/metrics';
import { HERO_META_PERIOD, loadHeroMetaTable } from '../meta/meta.service';
import {
  type ActivityQuery,
  activityDays,
  activityWindow,
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
  type ProfilePeriod,
  rankPoints,
  type RelationshipsQuery,
  ROLLING_WINDOW,
  selectMatches,
  trends,
  type TrendsQuery,
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
import { accountIdToSteamId, isSteamId64, steamIdToAccountId } from '../../shared/schemas';
import type { CatalogService } from '../catalog/catalog.service';
import { rankFromBadge, rankScore, UNRANKED, type PlayerRank } from '../catalog/ranks';

/** TTL initiaux (§9.2) : choix du projet, pas des garanties du fournisseur. */
const TTL = {
  search: 5 * 60_000,
  profile: 15 * 60_000,
  history: 3 * 60_000,
  /** Coéquipiers et adversaires : agrégats lourds côté source. */
  relations: 10 * 60_000,
} as const;

const SEARCH_LIMIT = 20;
/** Coéquipiers/adversaires gardés en cache par liste (la réponse en montre `limit` ≤ 50). */
const RELATIONS_MAX = 50;
/** Borne basse des périodes glissantes arrondie à 10 min (partage du cache). */
const RELATIONS_BUCKET_S = 600;

interface RelationRow {
  accountId: number;
  wins: number;
  matches: number;
}

interface RelationsSnapshot {
  teammates: RelationRow[] | null;
  opponents: RelationRow[] | null;
  profiles: Record<string, PlayerSummary> | null;
  complete: boolean;
}
/** Héros mis en avant par `/overview`. */
const TOP_HEROES = 3;

/** Taille de la « forme » des cartes joueur (dernières parties scorées). */
export const FORM_SIZE = 10;

/** Délai minimum entre deux appels au fournisseur pour un même joueur lors d'un refresh forcé. */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

/** `refresh` : relit le fournisseur si la copie a plus de {@link REFRESH_MIN_INTERVAL_MS}. */
export interface ReadOptions {
  refresh?: boolean;
}

const maxAge = (options?: ReadOptions) => (options?.refresh ? REFRESH_MIN_INTERVAL_MS : undefined);

/** Métadonnées de fraîcheur (§19.4) jointes à toute réponse issue de Deadlock API. */
export type { DataMeta };

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
 * (voir `matchWin`), triées de la plus récente à la plus ancienne.
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

/**
 * Résultat d'une partie pour le joueur, ou `null` si elle n'est pas scorée pour lui.
 * 1/2 : victoire/défaite. 0 (parties anciennes, résultat par joueur non enregistré) : déduit de
 * l'équipe gagnante, sauf abandon. 3/4/5 (abandon, pénalité, non scoré) : exclue.
 */
export function matchWin(entry: RawMatchHistoryEntry): boolean | null {
  if (entry.player_match_outcome === 1) return true;
  if (entry.player_match_outcome === 2) return false;
  if (
    entry.player_match_outcome === 0 &&
    !entry.abandoned_time_s &&
    (entry.match_result === 0 || entry.match_result === 1) &&
    (entry.player_team === 0 || entry.player_team === 1)
  ) {
    return entry.match_result === entry.player_team;
  }
  return null;
}

function toStoredMatches(entries: RawMatchHistoryEntry[]): StoredMatch[] {
  return entries
    .flatMap((entry) => {
      const win = matchWin(entry);
      return win === null ? [] : [{ entry, win }];
    })
    .map(({ entry, win }) => ({
      matchId: String(entry.match_id),
      heroId: entry.hero_id,
      startTime: entry.start_time,
      win,
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
/**
 * KDA agrégé sur les seules parties où K, D et A sont tous connus (même population pour les
 * trois totaux, comme `/overview`). `null` si aucune partie complète.
 */
export function completeCaseKda(matches: StoredMatch[]): number | null {
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let complete = 0;
  for (const m of matches) {
    if (m.kills === null || m.deaths === null || m.assists === null) continue;
    kills += m.kills;
    deaths += m.deaths;
    assists += m.assists;
    complete++;
  }
  return complete ? kda(kills, deaths, assists) : null;
}

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
    winRate: percent(wins, matches.length),
    kills,
    deaths,
    assists,
    kda: completeCaseKda(matches),
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

const meta = combineMeta;

export function createPlayersService(deadlock: DeadlockApi, catalog: CatalogService) {
  const profileOf = (accountId: number, options?: ReadOptions) =>
    cached<SteamProfile | null>(
      `profile:${accountId}`,
      { ttlMs: TTL.profile, maxAgeMs: maxAge(options) },
      () => deadlock.getSteamProfile(accountId),
    );

  const historyOf = (accountId: number, options?: ReadOptions) =>
    cached<StoredMatch[]>(
      // v2 : parties anciennes (outcome 0) incluses ; les copies v1 en sont dépourvues.
      `history:v2:${accountId}`,
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

    /**
     * Historique de rang : un point par partie classée dont le badge est connu, du plus ancien au
     * plus récent. Score = `tier * 6 + subrank` (même échelle que la comparaison de groupe).
     */
    async rankHistory(steamId: string, period: ProfilePeriod) {
      const [, history, ranks, seasonStart] = await Promise.all([
        requireProfile(steamId),
        historyOf(steamIdToAccountId(steamId)),
        catalog.ranks().catch(() => null),
        period === 'season' ? catalog.seasonStart().catch(() => null) : null,
      ]);
      const window = periodWindow(period, Date.now(), seasonStart);
      const { matches } = selectMatches(history.data, {}, window);
      const { points, rankedMatches, missingBadge } = rankPoints(matches);
      const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
      return {
        period,
        points: points.map((p) => {
          const rank = ranks ? rankFromBadge(p.badge, ranks.data) : null;
          return {
            at: iso(p.at),
            matchId: p.matchId,
            badge: p.badge,
            tier: Math.floor(p.badge / 10),
            subrank: p.badge % 10,
            score: rankScore(p.badge),
            name: rank?.name ?? null,
            imageUrl: rank?.imageUrl ?? null,
            outcome: p.win ? ('win' as const) : ('loss' as const),
          };
        }),
        coverage: {
          requestedFrom: window.from === null ? null : iso(window.from),
          requestedTo: iso(window.to),
          rankedMatches,
          pointCount: points.length,
          missingBadge,
          isPartial: window.seasonUnknown,
          notes: [
            ...(window.seasonUnknown ? ['season_start_unknown'] : []),
            ...(missingBadge ? ['badge_missing_on_some_ranked_matches'] : []),
            ...(history.isStale ? ['history_stale'] : []),
          ],
        },
        meta: meta(ranks ? [history, ranks] : [history], {
          isPartial: !ranks || window.seasonUnknown,
        }),
      };
    },

    /** Tendances : N dernières parties éligibles contre les N précédentes, winrate glissant. */
    async trends(steamId: string, query: TrendsQuery) {
      const [, history, seasonStart] = await Promise.all([
        requireProfile(steamId),
        historyOf(steamIdToAccountId(steamId)),
        query.period === 'season' ? catalog.seasonStart().catch(() => null) : null,
      ]);
      const window = periodWindow(query.period, Date.now(), seasonStart);
      const { matches } = selectMatches(history.data, query, window);
      const result = trends(matches, query.size);
      const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
      const series = result.series.map((p) => ({ ...p, at: iso(p.at) }));
      return {
        filters: {
          size: query.size,
          period: query.period ?? null,
          gameMode: query.gameMode,
          matchMode: query.matchMode,
        },
        recent: result.recent,
        previous: result.previous,
        delta: result.delta,
        rolling: result.rolling.map((p) => ({ ...p, at: iso(p.at) })),
        series,
        coverage: {
          eligibleMatches: matches.length,
          rollingWindow: ROLLING_WINDOW,
          seriesMatches: series.length,
          seriesFrom: series[0]?.at ?? null,
          seriesTo: series.at(-1)?.at ?? null,
          rollingPointsComplete: series.filter((p) => p.rollingWinRate !== null).length,
          notes: [
            ...(result.complete ? [] : ['insufficient_history']),
            ...(history.isStale ? ['history_stale'] : []),
            ...(window.seasonUnknown ? ['season_start_unknown'] : []),
          ],
        },
        meta: meta([history]),
      };
    },

    /** Activité par jour UTC sur `weeks` semaines (heatmap), depuis l'historique en cache. */
    async activity(steamId: string, query: ActivityQuery) {
      const [, history] = await Promise.all([
        requireProfile(steamId),
        historyOf(steamIdToAccountId(steamId)),
      ]);
      const window = activityWindow(query.weeks, Date.now());
      const selection = selectMatches(history.data, query, window);
      const days = activityDays(selection.matches, window);
      const wins = selection.matches.filter((m) => m.win).length;
      return {
        weeks: query.weeks,
        filters: { gameMode: query.gameMode, matchMode: query.matchMode },
        days,
        summary: {
          matches: selection.matches.length,
          wins,
          losses: selection.matches.length - wins,
          activeDays: days.filter((d) => d.matches > 0).length,
        },
        coverage: {
          from: days[0]?.date ?? null,
          to: days.at(-1)?.date ?? null,
          timezone: 'UTC',
          excludedUnknownMode: selection.excludedUnknownMode,
          notes: history.isStale ? ['history_stale'] : [],
        },
        meta: meta([history]),
      };
    },

    /**
     * Coéquipiers et adversaires fréquents (agrégats Deadlock API, `wins` = victoires du joueur).
     * Un joueur souvent rencontré n'est PAS présenté comme un ami Steam ; `sameParty` ne garde que
     * les parties jouées dans le même groupe (information de la source).
     */
    async relationships(steamId: string, query: RelationshipsQuery) {
      const accountId = steamIdToAccountId(steamId);
      const [, seasonStart] = await Promise.all([
        requireProfile(steamId),
        query.period === 'season' ? catalog.seasonStart().catch(() => null) : null,
      ]);
      const window = periodWindow(query.period, Date.now(), seasonStart);
      const sameParty = query.sameParty === 'true';
      // Borne basse arrondie à 10 min (vers le passé) : requêtes voisines = même entrée de cache.
      const minTimestamp =
        window.from === null ? null : window.from - (window.from % RELATIONS_BUCKET_S);
      const result = await cached(
        `relations:v1:${accountId}:${minTimestamp ?? 'all'}:${query.gameMode}:${sameParty}:${query.minMatches}`,
        { ttlMs: (data: RelationsSnapshot) => (data.complete ? TTL.relations : 60_000) },
        async (): Promise<RelationsSnapshot> => {
          const options = {
            minTimestamp,
            gameMode: query.gameMode,
            minMatches: query.minMatches,
            sameParty,
          };
          const [mates, enemies] = await Promise.allSettled([
            deadlock.getRelationStats(accountId, 'mates', options),
            deadlock.getRelationStats(accountId, 'enemies', options),
          ]);
          if (mates.status === 'rejected' && enemies.status === 'rejected') throw mates.reason;
          const top = (settled: typeof mates, idKey: 'mate_id' | 'enemy_id') =>
            settled.status === 'fulfilled'
              ? settled.value
                  .flatMap((r) => {
                    const id = r[idKey];
                    return id ? [{ accountId: id, wins: r.wins, matches: r.matches_played }] : [];
                  })
                  .sort(
                    (a, b) => b.matches - a.matches || b.wins - a.wins || a.accountId - b.accountId,
                  )
                  .slice(0, RELATIONS_MAX)
              : null;
          const teammates = top(mates, 'mate_id');
          const opponents = top(enemies, 'enemy_id');
          // Pseudos et avatars en un seul appel ; sans eux, repli sur le SteamID.
          const ids = [...(teammates ?? []), ...(opponents ?? [])].map((r) => r.accountId);
          const profiles = await deadlock.getSteamProfiles(ids).catch(() => null);
          return {
            teammates,
            opponents,
            profiles: profiles ? Object.fromEntries(profiles.map((p) => [p.accountId, p])) : null,
            complete: teammates !== null && opponents !== null && profiles !== null,
          };
        },
      );
      const { teammates, opponents, profiles } = result.data;
      const present = (list: RelationRow[] | null) =>
        list?.slice(0, query.limit).map((r) => {
          const profile = profiles?.[r.accountId];
          const id = accountIdToSteamId(r.accountId);
          return {
            steamId: id,
            displayName: profile?.displayName ?? id,
            avatarUrl: profile?.avatarUrl ?? null,
            matches: r.matches,
            wins: r.wins,
            losses: r.matches - r.wins,
            winRate: percent(r.wins, r.matches),
          };
        }) ?? null;
      return {
        appliedFilters: {
          period: query.period ?? null,
          gameMode: query.gameMode,
          sameParty,
          minMatches: query.minMatches,
          limit: query.limit,
        },
        teammates: present(teammates),
        opponents: present(opponents),
        coverage: {
          requestedFrom: minTimestamp === null ? null : new Date(minTimestamp * 1000).toISOString(),
          notes: window.seasonUnknown ? ['season_start_unknown'] : [],
        },
        meta: meta([result], { isPartial: !result.data.complete || window.seasonUnknown }),
      };
    },

    /**
     * Carte compacte d'un joueur pour les listes (suivis) : identité, rang connu, dernière
     * partie et forme sur les `formSize` dernières parties scorées. Lit uniquement le cache
     * partagé profil/historique (aucun appel si les copies sont fraîches). Historique en échec →
     * carte partielle (rang, forme et dernière partie `null`) ; profil introuvable → 404.
     */
    async card(steamId: string, formSize = FORM_SIZE) {
      const [profile, history, ranks] = await Promise.allSettled([
        requireProfile(steamId),
        historyOf(steamIdToAccountId(steamId)),
        catalog.ranks(),
      ]);
      if (profile.status === 'rejected') throw profile.reason;
      const hasHistory = history.status === 'fulfilled';
      const matches = hasHistory ? history.value.data : [];
      const badge = matches.find((m) => m.badge)?.badge ?? null;
      const recent = matches.slice(0, formSize);
      const wins = recent.filter((m) => m.win).length;
      return {
        player: {
          displayName: profile.value.data.displayName,
          avatarUrl: profile.value.data.avatarUrl,
        },
        rank: !hasHistory
          ? null
          : badge && ranks.status === 'fulfilled'
            ? rankFromBadge(badge, ranks.value.data)
            : badge
              ? null
              : UNRANKED,
        lastMatchAt:
          hasHistory && matches[0] ? new Date(matches[0].startTime * 1000).toISOString() : null,
        form: hasHistory
          ? {
              // Du plus récent au plus ancien.
              results: recent.map((m) => (m.win ? ('win' as const) : ('loss' as const))),
              matchIds: recent.map((m) => m.matchId),
              wins,
              losses: recent.length - wins,
              winRate: percent(wins, recent.length),
              sampleSize: recent.length,
              requestedSize: formSize,
            }
          : null,
        meta: meta(hasHistory ? [profile.value, history.value] : [profile.value], {
          isPartial: !hasHistory || (Boolean(badge) && ranks.status === 'rejected'),
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
      // Méta globale : une lecture de cache partagée pour tous les héros (pas de N+1).
      const heroMeta = await loadHeroMetaTable(deadlock).catch(() => null);
      const window = periodWindow(filter.period, Date.now(), seasonStart);
      const { matches } = selectMatches(history.data, filter, window);
      const index = heroes?.data ?? {};
      const items = groupByHero(matches).map(([heroId, list]) => {
        const stats = aggregate(list);
        const global = heroMeta ? (heroMeta.data[heroId] ?? null) : null;
        const metaWinRate = global?.winRate ?? null;
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
          globalMeta: global
            ? { matches: global.matches, winRate: global.winRate, pickRate: global.pickRate }
            : null,
          winRateVsMeta:
            stats.winRate !== null && metaWinRate !== null
              ? round2(stats.winRate - metaWinRate)
              : null,
        };
      });
      return {
        items,
        appliedFilters: appliedFilters(filter),
        metaContext: heroMeta
          ? {
              period: HERO_META_PERIOD,
              gameMode: 'normal' as const,
              matchMode: 'all' as const,
              // Comparaison directe seulement si le périmètre du joueur est le même.
              comparable:
                filter.period === HERO_META_PERIOD &&
                filter.gameMode === 'normal' &&
                filter.matchMode === 'all',
              fetchedAt: heroMeta.fetchedAt.toISOString(),
              isStale: heroMeta.isStale,
            }
          : null,
        meta: meta(heroes ? [history, heroes] : [history], {
          isPartial: !heroes || window.seasonUnknown,
        }),
      };
    },
  };
}

export type PlayersService = ReturnType<typeof createPlayersService>;
