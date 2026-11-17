import type { RawMatchMetadata } from '../../integrations/deadlock/deadlock.schemas';
import type { CatalogItem } from '../items/items.service';

export const round2 = (value: number) => Math.round(value * 100) / 100;
const ratio = (part: number | null, total: number | null) =>
  part !== null && total ? round2((part / total) * 100) : null;

type RawPlayer = RawMatchMetadata['match_info']['players'][number];
type RawStats = NonNullable<RawPlayer['stats']>[number];

/** Statistiques de fin de partie (dernier relevé de la source), valeurs inconnues à null. */
export interface FinalStats {
  /** Dégâts infligés aux héros adverses. */
  playerDamage: number | null;
  /** Dégâts subis de la part des héros. */
  damageTaken: number | null;
  /** Dégâts aux objectifs (gardiens, walkers, patrons). */
  objectiveDamage: number | null;
  creepDamage: number | null;
  neutralDamage: number | null;
  /** Soins prodigués (total), dont soins personnels et soins aux alliés. */
  healing: number | null;
  selfHealing: number | null;
  teammateHealing: number | null;
  damageMitigated: number | null;
  /** Balles touchant un héros, dont coups critiques (tirs à la tête). */
  heroBulletsHit: number | null;
  heroBulletsHitCrit: number | null;
  /** `heroBulletsHitCrit / heroBulletsHit` en %, 2 décimales. */
  heroCritRate: number | null;
  shotsHit: number | null;
  shotsMissed: number | null;
  /** `shotsHit / (shotsHit + shotsMissed)` en %, 2 décimales (toutes cibles). */
  accuracy: number | null;
  headshotKills: number | null;
  creepKills: number | null;
  neutralKills: number | null;
}

const num = (value: number | null | undefined) => (typeof value === 'number' ? value : null);

export function finalStats(last: RawStats | undefined): FinalStats | null {
  if (!last) return null;
  const shotsHit = num(last.shots_hit);
  const shotsMissed = num(last.shots_missed);
  const heroBulletsHit = num(last.hero_bullets_hit);
  const heroBulletsHitCrit = num(last.hero_bullets_hit_crit);
  return {
    playerDamage: num(last.player_damage),
    damageTaken: num(last.player_damage_taken),
    objectiveDamage: num(last.boss_damage),
    creepDamage: num(last.creep_damage),
    neutralDamage: num(last.neutral_damage),
    healing: num(last.player_healing),
    selfHealing: num(last.self_healing),
    teammateHealing: num(last.teammate_healing),
    damageMitigated: num(last.damage_mitigated),
    heroBulletsHit,
    heroBulletsHitCrit,
    heroCritRate: ratio(heroBulletsHitCrit, heroBulletsHit),
    shotsHit,
    shotsMissed,
    accuracy:
      shotsHit !== null && shotsMissed !== null ? ratio(shotsHit, shotsHit + shotsMissed) : null,
    headshotKills: num(last.headshot_kills),
    creepKills: num(last.creep_kills),
    neutralKills: num(last.neutral_kills),
  };
}

/** Évènement d'item brut (achat d'objet ou montée de capacité). */
export interface ItemEvent {
  itemId: number;
  atSeconds: number | null;
  soldAtSeconds: number | null;
}

/** Partie normalisée stockée en cache (forme compacte, sans le brut). */
export function normalizeMatch(info: RawMatchMetadata['match_info']) {
  return {
    startTime: info.start_time ?? null,
    durationSeconds: info.duration_s ?? null,
    winningTeam: info.winning_team ?? null,
    matchMode: info.match_mode ?? null,
    gameMode: info.game_mode ?? null,
    averageBadges: [info.average_badge_team0 ?? null, info.average_badge_team1 ?? null],
    players: info.players.map((p) => ({
      accountId: p.account_id ?? null,
      team: p.team,
      heroId: p.hero_id,
      level: p.level ?? null,
      kills: p.kills ?? null,
      deaths: p.deaths ?? null,
      assists: p.assists ?? null,
      netWorth: p.net_worth ?? null,
      lastHits: p.last_hits ?? null,
      denies: p.denies ?? null,
      mvpRank: p.mvp_rank ?? null,
      stats: finalStats(p.stats?.at(-1)),
      items:
        p.items?.map((i): ItemEvent => ({
          itemId: i.item_id,
          atSeconds: i.game_time_s ?? null,
          soldAtSeconds: i.sold_time_s || null,
        })) ?? null,
    })),
  };
}

/**
 * Sépare les évènements d'items avec le catalogue : achats d'objets (type `upgrade`), objets
 * gardés en fin de partie (non revendus), montées de capacités. Sans catalogue ou sans
 * évènements : null (inconnu), jamais une liste vide inventée.
 */
export function splitItems(events: ItemEvent[] | null, index: Map<number, CatalogItem> | null) {
  if (!events || !index) return { purchases: null, finalItemIds: null, abilityUpgrades: null };
  const sorted = [...events].sort((a, b) => (a.atSeconds ?? 0) - (b.atSeconds ?? 0));
  const purchases = sorted.filter((e) => index.get(e.itemId)?.type === 'upgrade');
  return {
    purchases,
    finalItemIds: purchases.filter((e) => e.soldAtSeconds === null).map((e) => e.itemId),
    abilityUpgrades: sorted
      .filter((e) => index.get(e.itemId)?.type === 'ability')
      .map((e) => ({ abilityId: e.itemId, atSeconds: e.atSeconds })),
  };
}
