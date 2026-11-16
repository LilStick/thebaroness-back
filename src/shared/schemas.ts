import { z } from 'zod';

/** SteamID64 individuel : 17 chiffres, préfixe des comptes utilisateurs Steam. */
export const steamIdSchema = z
  .string()
  .regex(/^7656119\d{10}$/, 'steamId : SteamID64 de 17 chiffres attendu');

export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'id : identifiant invalide')
  .transform((value) => value.toLowerCase());

/** SteamID64 → account_id (SteamID3, 32 bits) utilisé par Deadlock API. */
const STEAM_ID64_BASE = 76561197960265728n;

export const steamIdToAccountId = (steamId: string): number =>
  Number(BigInt(steamId) - STEAM_ID64_BASE);

export const accountIdToSteamId = (accountId: number): string =>
  (BigInt(accountId) + STEAM_ID64_BASE).toString();
