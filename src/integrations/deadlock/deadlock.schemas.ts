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
  /** Badge affiché en partie classée : `tier * 10 + subrank` (ex. 113 = tier 11, sous-rang 3). */
  ranked_display_badge: z.number().int().nonnegative().nullish(),
});
export const matchHistorySchema = z.array(matchHistoryEntrySchema);
export type RawMatchHistoryEntry = z.infer<typeof matchHistoryEntrySchema>;

/** `GET /v1/assets/ranks` : 12 paliers (0 à 11), images par sous-rang (1 à 6) sauf le palier 0. */
export const rankAssetSchema = z.object({
  tier: z.number().int().nonnegative(),
  name: z.string(),
  color: z.string().nullish(),
  images: z.record(z.string(), z.string().nullish()).default({}),
});
export const rankAssetsSchema = z.array(rankAssetSchema);
export type RawRankAsset = z.infer<typeof rankAssetSchema>;

/** `GET /v1/assets/map` : seules les images sont consommées. */
export const mapAssetSchema = z.object({
  images: z.record(z.string(), z.string().nullish()),
});

const imageMap = z.record(z.string(), z.string().nullish()).catch({});

/** `GET /v1/assets/heroes?language=french` : champs consommés par le catalogue. */
export const heroSchema = z.object({
  id: z.number().int(),
  class_name: z.string().nullish(),
  name: z.string(),
  hero_type: z.string().nullish(),
  gun_tag: z.string().nullish(),
  complexity: z.number().nullish(),
  tags: z.array(z.string()).nullish(),
  colors: z.object({ style_hex: z.string().nullish() }).partial().nullish(),
  images: imageMap.default({}),
  description: z.object({ lore: z.string().nullish() }).partial().nullish(),
  player_selectable: z.boolean().nullish(),
  disabled: z.boolean().nullish(),
  in_development: z.boolean().nullish(),
  development_state: z.string().nullish(),
  starting_stats: z
    .record(z.string(), z.object({ value: z.unknown() }).partial().nullish())
    .nullish(),
  /** Emplacements → class_name des capacités (`signature1` à `signature4`). */
  items: z.record(z.string(), z.string().nullish()).nullish(),
});
export const heroesSchema = z.array(heroSchema);
export type RawHero = z.infer<typeof heroSchema>;

/** `GET /v1/assets/items/by-type/ability?language=french`. */
export const abilitySchema = z.object({
  id: z.number().int(),
  class_name: z.string(),
  name: z.string(),
  hero: z.number().int().nullish(),
  heroes: z.array(z.number().int()).nullish(),
  image: z.string().nullish(),
  image_webp: z.string().nullish(),
  ability_type: z.string().nullish(),
  description: z.object({ desc: z.string().nullish() }).partial().nullish(),
  properties: z
    .object({ AbilityCooldown: z.object({ value: z.unknown() }).partial().nullish() })
    .partial()
    .nullish(),
});
export const abilitiesSchema = z.array(abilitySchema);
export type RawAbility = z.infer<typeof abilitySchema>;
