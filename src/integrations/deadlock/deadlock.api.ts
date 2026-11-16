import { accountIdToSteamId } from '../../shared/schemas';
import type { DeadlockClient } from './deadlock.client';
import {
  heroesSchema,
  matchHistorySchema,
  steamProfilesSchema,
  type RawMatchHistoryEntry,
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

    /** `GET /v1/assets/heroes` : correspondance id → nom de héros. */
    async getHeroNames(): Promise<Record<number, string>> {
      const raw = await client.get('/v1/assets/heroes', {}, heroesSchema);
      return Object.fromEntries((raw ?? []).map((hero) => [hero.id, hero.name]));
    },
  };
}

export type DeadlockApi = ReturnType<typeof createDeadlockApi>;
