import request from 'supertest';
import { rankFromBadge, rankScore, toRankTier } from '../../src/modules/catalog/ranks';
import { stripHtml } from '../../src/modules/catalog/heroes';
import { buildTestApp } from '../helpers/app';
import { useTestDb } from '../helpers/db';
import { createFetchMock, type FetchMock } from '../helpers/fetch-mock';

const ASSET = 'https://assets-bucket.test/assets-api-res';

/** Héros brut tel que renvoyé par /v1/assets/heroes?language=french. */
const rawHero = (id: number, name: string, extra: object = {}) => ({
  id,
  class_name: `hero_${name.toLowerCase()}`,
  name,
  hero_type: 'brawler',
  gun_tag: 'Fusil à pompe',
  complexity: 1,
  tags: ['Tank'],
  colors: { style_hex: '#2092AE' },
  player_selectable: true,
  disabled: false,
  in_development: false,
  development_state: 'release',
  description: { lore: '<p>Brut&nbsp;de décoffrage.Il protège.</p>', role: 'x' },
  images: {
    icon_hero_card: `${ASSET}/${id}_card.png`,
    icon_hero_card_webp: `${ASSET}/${id}_card.webp`,
    icon_image_small_webp: `${ASSET}/${id}_sm.webp`,
    top_bar_vertical_image: `${ASSET}/${id}_vertical.png`,
    background_image_webp: `${ASSET}/${id}_bg.webp`,
    name_image: `${ASSET}/${id}.svg`,
  },
  starting_stats: {
    max_health: { value: 800, display_stat_name: 'x' },
    stamina: { value: 3 },
    reload_speed: { value: 'n/a' },
  },
  items: { signature1: 'ability_drain', signature4: 'ability_ult', weapon_primary: 'gun' },
  ...extra,
});

const ABILITIES = [
  {
    id: 4072270083,
    class_name: 'ability_drain',
    name: 'Siphonnage',
    hero: 6,
    image: `${ASSET}/drain.png`,
    image_webp: `${ASSET}/drain.webp`,
    ability_type: 'signature',
    description: { desc: 'Draine <svg><path/></svg><b>la vie</b>.' },
    properties: { AbilityCooldown: { value: '42' } },
  },
  {
    id: 2,
    class_name: 'ability_ult',
    name: 'Charge',
    heroes: [6],
    image: null,
    ability_type: 'ultimate',
    description: { desc: 'x'.repeat(400) },
    properties: { AbilityCooldown: { value: 0 } },
  },
  // Même class_name mais pour un autre héros : ne doit pas être attribuée à Abrams.
  { id: 3, class_name: 'ability_drain', name: 'Autre', hero: 99, ability_type: 'signature' },
];

const HEROES = [
  rawHero(6, 'Abrams'),
  rawHero(1, 'Infernus', { hero_type: 'mystic', items: {} }),
  rawHero(50, 'Prototype', { in_development: true, development_state: 'testing' }),
  rawHero(51, 'Retiré', { player_selectable: false }),
];

const RANKS = [
  {
    tier: 11,
    name: 'Éternus',
    color: '#5CE9A9',
    images: { large_webp: `${ASSET}/r11.webp`, large_subrank6_webp: `${ASSET}/r11_6.webp` },
  },
  { tier: 0, name: 'Obscurus', color: '#333333', images: { large: `${ASSET}/r0.png` } },
];

describe('Catalogue', () => {
  useTestDb();
  let upstream: FetchMock;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    upstream = createFetchMock()
      .on(/^\/v1\/assets\/heroes$/, { body: HEROES })
      .on(/^\/v1\/assets\/items\/by-type\/ability$/, { body: ABILITIES })
      .on(/^\/v1\/assets\/ranks$/, { body: RANKS })
      .on(/^\/v1\/assets\/map$/, {
        body: {
          radius: 10752,
          images: {
            minimap: `${ASSET}/minimap.png`,
            mid: `${ASSET}/mid.png`,
            mid_tunnels: `${ASSET}/tunnels.png`,
            frame: `${ASSET}/frame.png`,
          },
        },
      });
    app = buildTestApp({}, upstream.fetch);
  });

  describe('GET /api/heroes', () => {
    it('héros jouables uniquement, triés par nom, au format HeroSummary', async () => {
      const res = await request(app).get('/api/heroes');
      expect(res.status).toBe(200);
      expect(res.body.items.map((h: { name: string }) => h.name)).toEqual(['Abrams', 'Infernus']);
      expect(res.body.items[0]).toStrictEqual({
        id: 6,
        name: 'Abrams',
        role: 'brawler',
        gunTag: 'Fusil à pompe',
        complexity: 1,
        tags: ['Tank'],
        color: '#2092AE',
        images: {
          card: `${ASSET}/6_card.webp`,
          small: `${ASSET}/6_sm.webp`,
          vertical: `${ASSET}/6_vertical.png`,
          background: `${ASSET}/6_bg.webp`,
          name: `${ASSET}/6.svg`,
        },
      });
      expect(res.body.meta).toMatchObject({ isStale: false, isPartial: false });
    });

    it('textes demandés en français ; second appel servi par le cache', async () => {
      await request(app).get('/api/heroes');
      await request(app).get('/api/heroes/6');
      expect(upstream.calls.filter((u) => u.pathname === '/v1/assets/heroes')).toHaveLength(1);
      expect(upstream.calls[0]?.searchParams.get('language')).toBe('french');
    });
  });

  describe('GET /api/heroes/:heroId', () => {
    it('détail : lore nettoyé, stats numériques libellées, capacités du héros', async () => {
      const res = await request(app).get('/api/heroes/6');
      expect(res.status).toBe(200);
      const { hero } = res.body;
      expect(hero.lore).toBe('Brut de décoffrage. Il protège.');
      expect(hero.stats).toEqual([
        { key: 'max_health', label: 'Santé', value: 800 },
        { key: 'stamina', label: 'Endurance', value: 3 },
      ]);
      expect(hero.abilities).toEqual([
        {
          id: 4072270083,
          name: 'Siphonnage',
          imageUrl: `${ASSET}/drain.webp`,
          type: 'signature',
          description: 'Draine la vie.',
          cooldownSeconds: 42,
        },
        {
          id: 2,
          name: 'Charge',
          imageUrl: null,
          type: 'ultimate',
          description: 'x'.repeat(260),
          cooldownSeconds: null,
        },
      ]);
    });

    it.each(['0', '-1', '1.5', 'abc'])('heroId %s → 400', async (id) => {
      const res = await request(app).get(`/api/heroes/${id}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    it.each(['999', '50'])('héros %s inconnu ou non jouable → 404', async (id) => {
      const res = await request(app).get(`/api/heroes/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Héros introuvable.');
    });

    it('fournisseur indisponible sans cache → 503', async () => {
      upstream.reset();
      upstream.on(/assets/, { status: 503 });
      const res = await request(app).get('/api/heroes');
      expect(res.status).toBe(503);
    });
  });

  it('GET /api/ranks → paliers triés, sous-rangs, sans meta', async () => {
    const res = await request(app).get('/api/ranks');
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      items: [
        {
          tier: 0,
          name: 'Obscurus',
          color: '#333333',
          imageUrl: `${ASSET}/r0.png`,
          subranks: [null, null, null, null, null, null],
        },
        {
          tier: 11,
          name: 'Éternus',
          color: '#5CE9A9',
          imageUrl: `${ASSET}/r11.webp`,
          subranks: [null, null, null, null, null, `${ASSET}/r11_6.webp`],
        },
      ],
    });
    expect(upstream.calls[0]?.searchParams.get('language')).toBe('french');
  });

  it('GET /api/map → minimap (vue « mid »), tunnels et cadre, sans meta', async () => {
    const res = await request(app).get('/api/map');
    expect(res.body).toStrictEqual({
      minimap: `${ASSET}/mid.png`,
      tunnels: `${ASSET}/tunnels.png`,
      frame: `${ASSET}/frame.png`,
    });
  });
});

describe('Rangs : conversions', () => {
  const tiers = RANKS.map(toRankTier);

  it('badge 116 → Éternus 6, image du sous-rang', () => {
    expect(rankFromBadge(116, tiers)).toStrictEqual({
      badgeId: 116,
      name: 'Éternus 6',
      tier: 11,
      subrank: 6,
      imageUrl: `${ASSET}/r11_6.webp`,
      color: '#5CE9A9',
    });
  });

  it('sous-rang sans image → image du palier', () => {
    expect(rankFromBadge(113, tiers).imageUrl).toBe(`${ASSET}/r11.webp`);
  });

  it.each([null, undefined, 0, 7, 117, 125])('badge %p → non classé', (badge) => {
    expect(rankFromBadge(badge, tiers)).toMatchObject({ badgeId: null, name: null, tier: null });
  });

  it('score = tier * 6 + sous-rang, maximum 72', () => {
    expect(rankScore(116)).toBe(72);
    expect(rankScore(11)).toBe(7);
    expect(rankScore(92)).toBe(56);
  });

  it('stripHtml retire SVG, balises et espaces superflus', () => {
    expect(stripHtml('<svg a><g/></svg> Un<br/>  deux&nbsp;!Trois')).toBe('Un deux ! Trois');
    expect(stripHtml(null)).toBe('');
  });
});
