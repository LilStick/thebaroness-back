import type { RawAbility, RawHero } from '../../integrations/deadlock/deadlock.schemas';

/**
 * Catalogue des héros au format du front (`HeroSummary` / `HeroDetail`, back-p1-contract.md).
 * Correspondance identique au générateur de fixtures du front (`scripts/build-fixtures.mjs`).
 */
export type HeroRole = 'assassin' | 'brawler' | 'marksman' | 'mystic' | 'healer';

export interface HeroImages {
  card: string;
  small: string;
  vertical: string;
  background: string;
  name: string | null;
}

export interface HeroAbility {
  id: number;
  name: string;
  imageUrl: string | null;
  type: 'signature' | 'ultimate';
  description: string;
  cooldownSeconds: number | null;
}

export interface HeroStatLine {
  key: string;
  label: string;
  value: number;
}

export interface HeroSummary {
  id: number;
  name: string;
  role: HeroRole;
  gunTag: string | null;
  complexity: number | null;
  tags: string[];
  color: string;
  images: HeroImages;
}

export interface HeroDetail extends HeroSummary {
  lore: string;
  stats: HeroStatLine[];
  abilities: HeroAbility[];
}

/** Entrée légère pour résoudre nom et portrait d'un héros dans les parties. */
export interface HeroIndexEntry {
  name: string;
  imageUrl: string | null;
}

/** Statistiques de départ affichées, dans l'ordre, avec libellés français. */
const STAT_LABELS: Array<[string, string]> = [
  ['max_health', 'Santé'],
  ['base_health_regen', 'Régénération de santé'],
  ['max_move_speed', 'Vitesse de déplacement'],
  ['sprint_speed', 'Vitesse de sprint'],
  ['stamina', 'Endurance'],
  ['light_melee_damage', 'Mêlée légère'],
  ['heavy_melee_damage', 'Mêlée lourde'],
  ['reload_speed', 'Vitesse de rechargement'],
];

const ROLES: Record<string, HeroRole> = {
  assassin: 'assassin',
  brawler: 'brawler',
  bagarreur: 'brawler',
  marksman: 'marksman',
  tireur: 'marksman',
  "tireur d'élite": 'marksman',
  mystic: 'mystic',
  mystique: 'mystic',
  healer: 'healer',
  soigneur: 'healer',
};

const DEFAULT_COLOR = '#5B4BF0';
const DESCRIPTION_MAX = 260;

/** Texte affichable : sans SVG ni balises HTML, espaces normalisés. */
export function stripHtml(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/([.!?»])(?=\p{Lu})/gu, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

const firstImage = (images: RawHero['images'], ...keys: string[]) =>
  keys.map((key) => images[key]).find((value): value is string => Boolean(value)) ?? null;

/** Héros jouable et publié. */
export const isPlayableHero = (hero: RawHero) =>
  Boolean(hero.player_selectable) &&
  !hero.disabled &&
  !hero.in_development &&
  hero.development_state === 'release';

export const heroSmallImage = (hero: RawHero) =>
  firstImage(hero.images, 'icon_image_small_webp', 'icon_image_small');

function toNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toAbility(raw: RawAbility): HeroAbility {
  const cooldown = toNumber(raw.properties?.AbilityCooldown?.value);
  return {
    id: raw.id,
    name: raw.name,
    imageUrl: raw.image_webp ?? raw.image ?? null,
    type: raw.ability_type === 'ultimate' ? 'ultimate' : 'signature',
    description: stripHtml(raw.description?.desc).slice(0, DESCRIPTION_MAX),
    cooldownSeconds: cooldown ? cooldown : null,
  };
}

export function toHeroDetail(
  hero: RawHero,
  abilitiesByClass: Map<string, RawAbility[]>,
): HeroDetail {
  const images = hero.images;
  const slots = ['signature1', 'signature2', 'signature3', 'signature4'];
  const abilities = slots
    .map((slot) => hero.items?.[slot])
    .map((className) =>
      (className ? abilitiesByClass.get(className) : undefined)?.find(
        (a) => a.hero === hero.id || a.heroes?.includes(hero.id),
      ),
    )
    .filter((ability): ability is RawAbility => ability !== undefined)
    .map(toAbility);

  const stats = STAT_LABELS.flatMap(([key, label]): HeroStatLine[] => {
    const value = toNumber(hero.starting_stats?.[key]?.value);
    return value === null ? [] : [{ key, label, value }];
  });

  return {
    id: hero.id,
    name: hero.name,
    role: ROLES[(hero.hero_type ?? '').toLowerCase()] ?? 'brawler',
    gunTag: hero.gun_tag ?? null,
    complexity: hero.complexity ?? null,
    tags: hero.tags ?? [],
    color: hero.colors?.style_hex ?? DEFAULT_COLOR,
    images: {
      card: firstImage(images, 'icon_hero_card_webp', 'icon_hero_card') ?? '',
      small: heroSmallImage(hero) ?? '',
      vertical: firstImage(images, 'top_bar_vertical_image_webp', 'top_bar_vertical_image') ?? '',
      background: firstImage(images, 'background_image_webp', 'background_image') ?? '',
      name: images.name_image ?? null,
    },
    lore: stripHtml(hero.description?.lore),
    stats,
    abilities,
  };
}

export const toHeroSummary = ({ lore: _l, stats: _s, abilities: _a, ...summary }: HeroDetail) =>
  summary as HeroSummary;
