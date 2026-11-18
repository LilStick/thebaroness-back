/**
 * Formules métier partagées : une seule définition pour tout le backend.
 * Convention : une valeur inconnue (entrée `null`, dénominateur nul) donne `null`, jamais 0.
 */

/** Arrondi à 2 décimales (convention de toutes les métriques exposées). */
export const round2 = (value: number) => Math.round(value * 100) / 100;

/** Pourcentage arrondi à 2 décimales ; `null` si le dénominateur est nul ou inconnu. */
export const percent = (part: number | null, total: number | null) =>
  part !== null && total ? round2((part / total) * 100) : null;

/** Moyenne arithmétique ; `null` sur un échantillon vide. */
export const mean = (values: number[]) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

/**
 * KDA `(K + A) / max(D, 1)` non arrondi ; `null` si l'une des trois valeurs est inconnue.
 * Les ratios agrégés s'appliquent à des totaux pris sur les mêmes parties (cas complets).
 */
export function rawKda(
  kills: number | null | undefined,
  deaths: number | null | undefined,
  assists: number | null | undefined,
): number | null {
  if (kills == null || deaths == null || assists == null) return null;
  return (kills + assists) / Math.max(deaths, 1);
}

/** KDA arrondi à 2 décimales (voir `rawKda`). */
export function kda(
  kills: number | null | undefined,
  deaths: number | null | undefined,
  assists: number | null | undefined,
): number | null {
  const value = rawKda(kills, deaths, assists);
  return value === null ? null : round2(value);
}

/** Valeur par minute de jeu ; `null` si la valeur ou une durée strictement positive manque. */
export function perMinute(
  value: number | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  if (value == null || durationSeconds == null || durationSeconds <= 0) return null;
  return value / (durationSeconds / 60);
}

/**
 * Classement « compétition » (1, 2, 2, 4) par valeur décroissante. Les valeurs `null` ne sont
 * pas classées (`null`). Renvoie le rang de chaque entrée dans l'ordre d'origine.
 */
export function competitionRanks(values: Array<number | null>): Array<number | null> {
  return values.map((value) =>
    value === null ? null : 1 + values.filter((other) => other !== null && other > value).length,
  );
}

/** Exécute `fn` sur chaque élément avec au plus `limit` exécutions simultanées ; ordre conservé. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
  return results;
}
