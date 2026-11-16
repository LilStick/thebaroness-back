import { z } from 'zod';

/** SteamID64 → account_id (SteamID3, 32 bits) utilisé par Deadlock API. */
const STEAM_ID64_BASE = 76561197960265728n;
const ACCOUNT_ID_MAX = 0xffffffffn;

/** SteamID64 d'un compte individuel : 17 chiffres, account_id 32 bits positif. */
export const isSteamId64 = (value: string): boolean => {
  if (!/^\d{17}$/.test(value)) return false;
  const accountId = BigInt(value) - STEAM_ID64_BASE;
  return accountId > 0n && accountId <= ACCOUNT_ID_MAX;
};

export const steamIdSchema = z
  .string()
  .refine(isSteamId64, 'steamId : SteamID64 de 17 chiffres attendu');

const ACCOUNT_ID_PATTERN = /^\d{1,10}$/;
const STEAM3_PATTERN = /^\[U:1:(\d{1,10})\]$/i;
const PROFILE_URL_PATTERN =
  /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{17})\/?(?:[?#].*)?$/i;

const fromAccountId = (raw: string): string | null => {
  const accountId = BigInt(raw);
  return accountId > 0n && accountId <= ACCOUNT_ID_MAX
    ? (accountId + STEAM_ID64_BASE).toString()
    : null;
};

/**
 * Saisie libre d'un joueur Steam → SteamID64, ou `null` si non reconnue.
 * Accepte : SteamID64, code ami (account ID 32 bits), `[U:1:n]`, URL `steamcommunity.com/profiles/<id>`.
 * Les URL personnalisées `/id/<pseudo>` exigeraient la Web API Steam : refusées.
 */
export const normalizeSteamIdInput = (input: string): string | null => {
  const value = input.trim();
  if (isSteamId64(value)) return value;
  if (ACCOUNT_ID_PATTERN.test(value)) return fromAccountId(value);
  const steam3 = STEAM3_PATTERN.exec(value)?.[1];
  if (steam3) return fromAccountId(steam3);
  const profile = PROFILE_URL_PATTERN.exec(value)?.[1];
  return profile && isSteamId64(profile) ? profile : null;
};

/** Corps de requête : forme libre normalisée en SteamID64 (les réponses restent en SteamID64). */
export const steamIdInputSchema = z.string().transform((value, ctx) => {
  const steamId = normalizeSteamIdInput(value);
  if (steamId) return steamId;
  ctx.addIssue({
    code: 'custom',
    message: 'steamId : SteamID64, code ami, [U:1:n] ou URL steamcommunity.com/profiles/ attendu',
  });
  return z.NEVER;
});

export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'id : identifiant invalide')
  .transform((value) => value.toLowerCase());

export const steamIdToAccountId = (steamId: string): number =>
  Number(BigInt(steamId) - STEAM_ID64_BASE);

export const accountIdToSteamId = (accountId: number): string =>
  (BigInt(accountId) + STEAM_ID64_BASE).toString();
