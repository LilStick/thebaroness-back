/**
 * Modes de jeu de Deadlock API (énumérations `ActiveMatchMode` et `ActiveMatchGameMode` de son
 * OpenAPI). La valeur numérique est l'index dans l'énumération ; 0 (`Invalid`) et l'inconnu → null.
 */
export const MATCH_MODES = [
  'unranked',
  'private_lobby',
  'coop_bot',
  'ranked',
  'server_test',
  'tutorial',
  'hero_labs',
  'new_player_placement',
] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const GAME_MODES = ['normal', '1v1_test', 'sandbox', 'street_brawl', 'explore_nyc'] as const;
export type GameMode = (typeof GAME_MODES)[number];

/** `match_mode` brut (1 = unranked … 8 = new_player_placement) → code stable, sinon null. */
export const toMatchMode = (value: number | null | undefined): MatchMode | null =>
  (value && MATCH_MODES[value - 1]) || null;

/** `game_mode` brut (1 = normal, 4 = street_brawl…) → code stable, sinon null. */
export const toGameMode = (value: number | null | undefined): GameMode | null =>
  (value && GAME_MODES[value - 1]) || null;
