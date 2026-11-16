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

export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'id : identifiant invalide')
  .transform((value) => value.toLowerCase());

export const steamIdToAccountId = (steamId: string): number =>
  Number(BigInt(steamId) - STEAM_ID64_BASE);

export const accountIdToSteamId = (accountId: number): string =>
  (BigInt(accountId) + STEAM_ID64_BASE).toString();
