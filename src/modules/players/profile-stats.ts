import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GameMode, MatchMode } from '../../integrations/deadlock/game-modes';

/**
 * Filtres et agrégats du profil V2 (overview, matches et heroes filtrés).
 * Fonctions pures sur l'historique normalisé en cache : aucun appel au fournisseur.
 */

export const PROFILE_PERIODS = ['7d', '30d', 'season'] as const;
export type ProfilePeriod = (typeof PROFILE_PERIODS)[number];
export const GAME_MODE_FILTERS = ['all', 'normal', 'street_brawl'] as const;
export const MATCH_MODE_FILTERS = ['all', 'ranked', 'unranked'] as const;
export const OUTCOME_FILTERS = ['all', 'win', 'loss'] as const;

/** Partie normalisée minimale utilisée par les calculs (sous-ensemble de `StoredMatch`). */
export interface ProfileMatch {
  matchId: string;
  heroId: number;
  startTime: number;
  win: boolean;
  duration: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  netWorth: number | null;
  matchMode?: MatchMode | null;
  gameMode?: GameMode | null;
  /** `ranked_display_badge` (tier * 10 + subrank) si connu. */
  badge?: number | null;
}

const periodSchema = z.enum(PROFILE_PERIODS, 'period : 7d, 30d ou season');
const gameModeSchema = z.enum(GAME_MODE_FILTERS, 'gameMode : all, normal ou street_brawl');
const matchModeSchema = z.enum(MATCH_MODE_FILTERS, 'matchMode : all, ranked ou unranked');

/** `/overview` : période par défaut 30 jours, modes « all ». */
export const overviewQuerySchema = z.object({
  period: periodSchema.default('30d'),
  gameMode: gameModeSchema.default('all'),
  matchMode: matchModeSchema.default('all'),
});
export type OverviewFilter = z.infer<typeof overviewQuerySchema>;

/** Filtres optionnels de `/matches` et `/heroes` : sans eux, comportement v1.8 (tout l'historique). */
export const historyFilterSchema = z.object({
  period: periodSchema.optional(),
  gameMode: gameModeSchema.default('all'),
  matchMode: matchModeSchema.default('all'),
  heroId: z.coerce
    .number('heroId : entier positif attendu')
    .int('heroId : entier positif attendu')
    .positive('heroId : entier positif attendu')
    .optional(),
  outcome: z.enum(OUTCOME_FILTERS, 'outcome : all, win ou loss').default('all'),
});
export type HistoryFilter = z.infer<typeof historyFilterSchema>;

/** Filtres effectivement appliqués, sous forme publiée (`null` = non filtré). */
export const appliedFilters = (filter: HistoryFilter) => ({
  period: filter.period ?? null,
  gameMode: filter.gameMode,
  matchMode: filter.matchMode,
  heroId: filter.heroId ?? null,
  outcome: filter.outcome,
});

/** Vrai si au moins un filtre restreint l'historique (sinon : comportement v1.8 inchangé). */
export const hasFilters = (filter: HistoryFilter) =>
  filter.period !== undefined ||
  filter.gameMode !== 'all' ||
  filter.matchMode !== 'all' ||
  filter.heroId !== undefined ||
  filter.outcome !== 'all';

/** Empreinte courte des filtres, liée au curseur pour refuser un curseur d'une autre requête. */
export const filterFingerprint = (filter: HistoryFilter) =>
  createHash('sha256')
    .update(JSON.stringify(appliedFilters(filter)))
    .digest('base64url')
    .slice(0, 10);

const DAY_S = 86_400;
const PERIOD_DAYS = { '7d': 7, '30d': 30 } as const;

export interface PeriodWindow {
  /** Début inclus (secondes UTC) ; `null` = pas de borne basse. */
  from: number | null;
  /** Fin incluse (secondes UTC) : instant de référence de la requête. */
  to: number;
  /** `season` demandée mais début de saison inconnu : aucune borne appliquée. */
  seasonUnknown: boolean;
}

/** Fenêtre glissante UTC (`7d`, `30d`) ou depuis le début de la saison classée courante. */
export function periodWindow(
  period: ProfilePeriod | undefined,
  nowMs: number,
  seasonStart: number | null,
): PeriodWindow {
  const to = Math.floor(nowMs / 1000);
  if (period === undefined) return { from: null, to, seasonUnknown: false };
  if (period === 'season') return { from: seasonStart, to, seasonUnknown: seasonStart === null };
  return { from: to - PERIOD_DAYS[period] * DAY_S, to, seasonUnknown: false };
}

export interface Selection<M extends ProfileMatch> {
  matches: M[];
  /** Parties écartées uniquement parce qu'un filtre de mode est précis et leur mode inconnu. */
  excludedUnknownMode: number;
  /** Parties retenues (filtre « all ») dont le mode de jeu ou le type est inconnu. */
  unknownModeMatches: number;
}

/**
 * Sélection sur tout l'historique (avant tri et pagination). `gameMode` et `matchMode` sont deux
 * axes indépendants ; un mode inconnu n'est retenu que sous « all ».
 */
export function selectMatches<M extends ProfileMatch>(
  history: M[],
  filter: Partial<HistoryFilter>,
  window: PeriodWindow,
): Selection<M> {
  const result: Selection<M> = { matches: [], excludedUnknownMode: 0, unknownModeMatches: 0 };
  const gameMode = filter.gameMode ?? 'all';
  const matchMode = filter.matchMode ?? 'all';
  const outcome = filter.outcome ?? 'all';
  for (const match of history) {
    if (window.from !== null && match.startTime < window.from) continue;
    if (match.startTime > window.to) continue;
    if (outcome !== 'all' && match.win !== (outcome === 'win')) continue;
    if (filter.heroId !== undefined && match.heroId !== filter.heroId) continue;
    const game = match.gameMode ?? null;
    const queue = match.matchMode ?? null;
    if ((gameMode !== 'all' && game === null) || (matchMode !== 'all' && queue === null)) {
      result.excludedUnknownMode++;
      continue;
    }
    if (gameMode !== 'all' && game !== gameMode) continue;
    if (matchMode !== 'all' && queue !== matchMode) continue;
    if (game === null || queue === null) result.unknownModeMatches++;
    result.matches.push(match);
  }
  return result;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const percent = (part: number, total: number) => (total ? round2((part / total) * 100) : null);
const mean = (values: number[]) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

export interface Aggregate {
  matches: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Totaux sur les seules parties où K, D et A sont tous connus (`kdaSampleSize`). */
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  /** `(K + A) / max(D, 1)` sur ce même sous-ensemble complet, 2 décimales. */
  kda: number | null;
  kdaSampleSize: number;
  /** Moyenne des ratios par partie `netWorth / (durée / 60)` (pas total / total), 2 décimales. */
  avgNetWorthPerMinute: number | null;
  netWorthPerMinuteSampleSize: number;
  /** Durée moyenne en secondes (arrondie) sur les parties de durée connue. */
  avgDurationSeconds: number | null;
  durationSampleSize: number;
}

/** Agrégats cohérents : chaque ratio est calculé sur un seul sous-ensemble, publié avec sa taille. */
export function aggregate(matches: ProfileMatch[]): Aggregate {
  const wins = matches.filter((m) => m.win).length;
  const complete = matches.filter(
    (m) => m.kills !== null && m.deaths !== null && m.assists !== null,
  );
  const sum = (field: 'kills' | 'deaths' | 'assists') =>
    complete.length ? complete.reduce((total, m) => total + Number(m[field]), 0) : null;
  const kills = sum('kills');
  const deaths = sum('deaths');
  const assists = sum('assists');
  const perMinute = matches.flatMap((m) =>
    m.netWorth !== null && m.duration !== null && m.duration > 0
      ? [m.netWorth / (m.duration / 60)]
      : [],
  );
  const durations = matches.flatMap((m) =>
    m.duration !== null && m.duration > 0 ? [m.duration] : [],
  );
  const avgPerMinute = mean(perMinute);
  const avgDuration = mean(durations);
  return {
    matches: matches.length,
    wins,
    losses: matches.length - wins,
    winRate: percent(wins, matches.length),
    kills,
    deaths,
    assists,
    kda:
      kills !== null && deaths !== null && assists !== null
        ? round2((kills + assists) / Math.max(deaths, 1))
        : null,
    kdaSampleSize: complete.length,
    avgNetWorthPerMinute: avgPerMinute === null ? null : round2(avgPerMinute),
    netWorthPerMinuteSampleSize: perMinute.length,
    avgDurationSeconds: avgDuration === null ? null : Math.round(avgDuration),
    durationSampleSize: durations.length,
  };
}

/** Combinaisons observées `gameMode` × `matchMode` (modes connus seulement), par volume décroissant. */
export function modeBreakdown(matches: ProfileMatch[]) {
  const groups = new Map<
    string,
    { gameMode: GameMode; matchMode: MatchMode; wins: number; n: number }
  >();
  for (const m of matches) {
    if (!m.gameMode || !m.matchMode) continue;
    const key = `${m.gameMode}|${m.matchMode}`;
    const group = groups.get(key) ?? {
      gameMode: m.gameMode,
      matchMode: m.matchMode,
      wins: 0,
      n: 0,
    };
    group.n++;
    if (m.win) group.wins++;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.n - a.n || a.gameMode.localeCompare(b.gameMode) || a.matchMode.localeCompare(b.matchMode),
    )
    .map((g) => ({
      gameMode: g.gameMode,
      matchMode: g.matchMode,
      matches: g.n,
      wins: g.wins,
      losses: g.n - g.wins,
      winRate: percent(g.wins, g.n),
    }));
}

/** Parties regroupées par héros, triées par volume décroissant (puis id croissant). */
export function groupByHero<M extends ProfileMatch>(matches: M[]): Array<[number, M[]]> {
  const byHero = new Map<number, M[]>();
  for (const m of matches) {
    const list = byHero.get(m.heroId);
    if (list) list.push(m);
    else byHero.set(m.heroId, [m]);
  }
  return [...byHero].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
}

/** Historique de rang : `/rank-history`, période par défaut `season`. */
export const rankHistoryQuerySchema = z.object({ period: periodSchema.default('season') });

/**
 * Points de rang observés sur les parties classées de la sélection, du plus ancien au plus récent.
 * Seules les parties dont le badge est connu donnent un point (aucune interpolation).
 */
export function rankPoints(matches: ProfileMatch[]) {
  const ranked = matches.filter((m) => m.matchMode === 'ranked' || m.badge);
  const points = ranked
    .filter((m): m is ProfileMatch & { badge: number } => Boolean(m.badge))
    .sort((a, b) => a.startTime - b.startTime || compareMatchIds(a.matchId, b.matchId))
    .map((m) => ({ at: m.startTime, matchId: m.matchId, badge: m.badge, win: m.win }));
  return { points, rankedMatches: ranked.length, missingBadge: ranked.length - points.length };
}

/** Comparaison de deux matchId (chaînes d'entiers) sans perte de précision. */
export const compareMatchIds = (a: string, b: string) =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** Activité : 1 à 52 semaines (défaut 12), filtres de mode optionnels. */
export const activityQuerySchema = z.object({
  weeks: z.coerce
    .number('weeks : entier entre 1 et 52')
    .int('weeks : entier entre 1 et 52')
    .min(1, 'weeks : entier entre 1 et 52')
    .max(52, 'weeks : entier entre 1 et 52')
    .default(12),
  gameMode: gameModeSchema.default('all'),
  matchMode: matchModeSchema.default('all'),
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

/** Fenêtre d'activité : de minuit UTC il y a `weeks * 7 - 1` jours jusqu'à maintenant. */
export function activityWindow(weeks: number, nowMs: number): PeriodWindow {
  const to = Math.floor(nowMs / 1000);
  const todayStart = to - (to % DAY_S);
  return { from: todayStart - (weeks * 7 - 1) * DAY_S, to, seasonUnknown: false };
}

/** Un jour UTC par case, jours sans partie compris (0 connu : l'historique source est complet). */
export function activityDays(matches: ProfileMatch[], window: PeriodWindow) {
  const from = window.from ?? window.to;
  const count = Math.floor((window.to - from) / DAY_S) + 1;
  const days = Array.from({ length: count }, (_, i) => ({
    date: new Date((from + i * DAY_S) * 1000).toISOString().slice(0, 10),
    matches: 0,
    wins: 0,
    losses: 0,
  }));
  for (const m of matches) {
    const day = days[Math.floor((m.startTime - from) / DAY_S)];
    if (!day) continue;
    day.matches++;
    if (m.win) day.wins++;
    else day.losses++;
  }
  return days;
}

/** Coéquipiers et adversaires : période optionnelle (tout l'historique par défaut). */
export const relationshipsQuerySchema = z.object({
  period: periodSchema.optional(),
  gameMode: z
    .enum(['normal', 'street_brawl'], 'gameMode : normal ou street_brawl')
    .default('normal'),
  sameParty: z.enum(['true', 'false'], 'sameParty : true ou false').default('false'),
  minMatches: z.coerce
    .number('minMatches : entier entre 1 et 50')
    .int('minMatches : entier entre 1 et 50')
    .min(1, 'minMatches : entier entre 1 et 50')
    .max(50, 'minMatches : entier entre 1 et 50')
    .default(2),
  limit: z.coerce
    .number('limit : entier entre 1 et 50')
    .int('limit : entier entre 1 et 50')
    .min(1, 'limit : entier entre 1 et 50')
    .max(50, 'limit : entier entre 1 et 50')
    .default(10),
});
export type RelationshipsQuery = z.infer<typeof relationshipsQuerySchema>;
