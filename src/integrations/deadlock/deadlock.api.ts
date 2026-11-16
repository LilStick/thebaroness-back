import { accountIdToSteamId } from '../../shared/schemas';
import type { DeadlockClient } from './deadlock.client';
import {
  abilitiesSchema,
  heroAnalyticsSchema,
  heroesSchema,
  leaderboardSchema,
  mapAssetSchema,
  matchHistorySchema,
  matchMetadataSchema,
  rankAssetsSchema,
  steamProfilesSchema,
  type RawAbility,
  type RawHero,
  type RawHeroAnalytics,
  type RawLeaderboard,
  type RawMatchHistoryEntry,
  type RawMatchMetadata,
  type RawRankAsset,
  type RawSteamProfile,
} from './deadlock.schemas';

/** Résumé de joueur normalisé (§19.4 A) : aucun champ brut de Deadlock API ne sort d'ici. */
export interface PlayerSummary {
  steamId: string;
  accountId: number;
  displayName: string;
  avatarUrl: string | null;
}

export interface SteamProfile extends PlayerSummary {
  region: string | null;
  /** Date de mise à jour du profil côté fournisseur (ISO) ou `null`. */
  sourceUpdatedAt: string | null;
}

const emptyToNull = (value: string | null | undefined) => (value ? value : null);

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function toPlayerSummary(raw: RawSteamProfile): PlayerSummary {
  return {
    steamId: accountIdToSteamId(raw.account_id),
    accountId: raw.account_id,
    displayName: raw.personaname,
    avatarUrl: emptyToNull(raw.avatarfull) ?? emptyToNull(raw.avatar),
  };
}

function toSteamProfile(raw: RawSteamProfile): SteamProfile {
  return {
    ...toPlayerSummary(raw),
    region: emptyToNull(raw.countrycode),
    sourceUpdatedAt: toIsoOrNull(raw.last_updated),
  };
}

/** Accès typé aux endpoints Deadlock API utilisés par l'application. */
export function createDeadlockApi(client: DeadlockClient) {
  return {
    /** `GET /v1/players/steam-search` : recherche par pseudo ou account_id. */
    async searchPlayers(query: string, limit: number): Promise<PlayerSummary[]> {
      const raw = await client.get(
        '/v1/players/steam-search',
        { search_query: query, limit },
        steamProfilesSchema,
      );
      return (raw ?? []).map(toPlayerSummary);
    },

    /** `GET /v1/players/steam` : profil Steam d'un compte, `null` s'il est inconnu. */
    async getSteamProfile(accountId: number): Promise<SteamProfile | null> {
      const raw = await client.get(
        '/v1/players/steam',
        { account_ids: accountId },
        steamProfilesSchema,
      );
      const profile = raw?.find((entry) => entry.account_id === accountId);
      return profile ? toSteamProfile(profile) : null;
    },

    /** `GET /v1/players/{account_id}/match-history` : historique complet disponible. */
    async getMatchHistory(accountId: number): Promise<RawMatchHistoryEntry[]> {
      const raw = await client.get(
        `/v1/players/${accountId}/match-history`,
        {},
        matchHistorySchema,
      );
      return raw ?? [];
    },

    /** `GET /v1/players/steam` en lot (≤ 1000 comptes) : profils connus uniquement. */
    async getSteamProfiles(accountIds: number[]): Promise<PlayerSummary[]> {
      if (accountIds.length === 0) return [];
      const raw = await client.get(
        '/v1/players/steam',
        { account_ids: [...new Set(accountIds)].sort((a, b) => a - b).join(',') },
        steamProfilesSchema,
      );
      return (raw ?? []).map(toPlayerSummary);
    },

    /** `GET /v1/leaderboard/{region}` : classement de la saison courante (mis à jour chaque heure). */
    async getLeaderboard(region: string): Promise<RawLeaderboard['entries']> {
      return (await client.get(`/v1/leaderboard/${region}`, {}, leaderboardSchema))?.entries ?? [];
    },

    /** `GET /v1/matches/{id}/metadata` : `null` si la partie est inconnue. */
    async getMatchMetadata(matchId: string): Promise<RawMatchMetadata['match_info'] | null> {
      return (
        (await client.get(`/v1/matches/${matchId}/metadata`, {}, matchMetadataSchema))
          ?.match_info ?? null
      );
    },

    /** `GET /v1/analytics/hero-stats` par badge moyen, sur les 30 derniers jours (défaut source). */
    async getHeroAnalyticsByBadge(): Promise<RawHeroAnalytics> {
      return (
        (await client.get(
          '/v1/analytics/hero-stats',
          { bucket: 'avg_badge' },
          heroAnalyticsSchema,
        )) ?? []
      );
    },

    /** `GET /v1/assets/ranks` : paliers de rang, noms en français. */
    async getRanks(): Promise<RawRankAsset[]> {
      return (await client.get('/v1/assets/ranks', { language: 'french' }, rankAssetsSchema)) ?? [];
    },

    /** `GET /v1/assets/map` : URLs des images de la carte. */
    async getMapImages(): Promise<Record<string, string | null | undefined>> {
      return (await client.get('/v1/assets/map', {}, mapAssetSchema))?.images ?? {};
    },

    /** `GET /v1/assets/heroes` : tous les héros (filtrage des jouables côté catalogue). */
    async getHeroes(): Promise<RawHero[]> {
      return (await client.get('/v1/assets/heroes', { language: 'french' }, heroesSchema)) ?? [];
    },

    /** `GET /v1/assets/items/by-type/ability` : capacités de tous les héros. */
    async getAbilities(): Promise<RawAbility[]> {
      return (
        (await client.get(
          '/v1/assets/items/by-type/ability',
          { language: 'french' },
          abilitiesSchema,
        )) ?? []
      );
    },
  };
}

export type DeadlockApi = ReturnType<typeof createDeadlockApi>;
