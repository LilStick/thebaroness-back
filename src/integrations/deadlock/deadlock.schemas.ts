import { z } from 'zod';

/**
 * Schémas des réponses brutes de Deadlock API (https://api.deadlock-api.com/openapi.json),
 * limités aux champs consommés : le reste (ex. `friends`, gros tableaux) est ignoré.
 */

export const steamProfileSchema = z.object({
  account_id: z.number().int().nonnegative(),
  personaname: z.string(),
  avatarfull: z.string().nullish(),
  avatar: z.string().nullish(),
  countrycode: z.string().nullish(),
  last_updated: z.string().nullish(),
});
export const steamProfilesSchema = z.array(steamProfileSchema);
export type RawSteamProfile = z.infer<typeof steamProfileSchema>;

/** `player_match_outcome` : 1 victoire, 2 défaite ; 0/3/4/5 = invalide, pénalisé, non scoré. */
export const matchHistoryEntrySchema = z.object({
  match_id: z.number().int().nonnegative(),
  hero_id: z.number().int().nonnegative(),
  start_time: z.number().int().nonnegative(),
  match_duration_s: z.number().int().nonnegative().nullish(),
  player_kills: z.number().int().nonnegative().nullish(),
  player_deaths: z.number().int().nonnegative().nullish(),
  player_assists: z.number().int().nonnegative().nullish(),
  net_worth: z.number().int().nonnegative().nullish(),
  player_match_outcome: z.number().int(),
});
export const matchHistorySchema = z.array(matchHistoryEntrySchema);
export type RawMatchHistoryEntry = z.infer<typeof matchHistoryEntrySchema>;

export const heroSchema = z.object({ id: z.number().int(), name: z.string() });
export const heroesSchema = z.array(heroSchema);
