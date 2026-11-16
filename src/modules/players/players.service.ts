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
const encodeCursor = ({ startTime, matchId }: Cursor) =>
  Buffer.from(`${startTime}:${matchId}`).toString('base64url');

function decodeCursor(cursor: string): Cursor {
  const match = /^(\d{1,12}):(\d{1,20})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match?.[1] || !match[2]) throw invalidInput('cursor : curseur invalide');
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
  const profileOf = (accountId: number) =>
    cached<SteamProfile | null>(`profile:${accountId}`, { ttlMs: TTL.profile }, () =>
      deadlock.getSteamProfile(accountId),
    );

  const historyOf = (accountId: number) =>
    cached<StoredMatch[]>(`history:${accountId}`, { ttlMs: TTL.history }, async () =>
      toStoredMatches(await deadlock.getMatchHistory(accountId)),
    );

  /** Profil existant ou 404 (un joueur introuvable n'est pas une absence de statistiques). */
  async function requireProfile(steamId: string) {
    const profile = await profileOf(steamIdToAccountId(steamId));
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

    async profile(steamId: string) {
      const accountId = steamIdToAccountId(steamId);
      // Profil et historique en parallèle ; l'historique est partagé avec /matches.
      const [profile, history, ranks] = await Promise.allSettled([
        requireProfile(steamId),
        historyOf(accountId),
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

    async matches(steamId: string, limit: number, cursor?: string) {
      const after = cursor ? decodeCursor(cursor) : null;
      const accountId = steamIdToAccountId(steamId);
      const [, history, heroes] = await Promise.all([
        requireProfile(steamId),
        historyOf(accountId),
        // Catalogue facultatif : sans lui, nom de repli et réponse marquée partielle.
        catalog.heroIndex().catch(() => null),
      ]);

      const start = after ? history.data.findIndex((m) => isAfterCursor(m, after)) : 0;
      const page = start === -1 ? [] : history.data.slice(start, start + limit);
      const last = page.at(-1);
      const hasMore = start !== -1 && start + limit < history.data.length;
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
        })),
        nextCursor: hasMore && last ? encodeCursor(last) : null,
        meta: meta(heroes ? [history, heroes] : [history], { isPartial: !heroes }),
      };
    },

    /** Statistiques par héros sur les parties disponibles (même source que le profil). */
    async heroes(steamId: string) {
      const [, history, heroes] = await Promise.all([
        requireProfile(steamId),
        historyOf(steamIdToAccountId(steamId)),
        catalog.heroIndex().catch(() => null),
      ]);
      const index = heroes?.data ?? {};
      const byHero = new Map<number, StoredMatch[]>();
      for (const match of history.data) {
        byHero.set(match.heroId, [...(byHero.get(match.heroId) ?? []), match]);
      }
      const items = [...byHero]
        .map(([heroId, matches]) => {
          const stats = computeStats(matches);
          return {
            heroId,
            heroName: index[heroId]?.name ?? `Héros #${heroId}`,
            heroImageUrl: index[heroId]?.imageUrl ?? null,
            matches: matches.length,
            wins: stats.wins ?? 0,
            winRate: stats.winRate,
            kda: stats.kda,
          };
        })
        .sort((a, b) => b.matches - a.matches || a.heroId - b.heroId);
      return { items, meta: meta(heroes ? [history, heroes] : [history], { isPartial: !heroes }) };
    },
  };
}

export type PlayersService = ReturnType<typeof createPlayersService>;
