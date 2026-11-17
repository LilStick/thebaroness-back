import {
  aggregate,
  filterFingerprint,
  groupByHero,
  hasFilters,
  historyFilterSchema,
  modeBreakdown,
  periodWindow,
  selectMatches,
  type ProfileMatch,
} from '../../src/modules/players/profile-stats';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const NOW_S = NOW / 1000;
const DAY = 86_400;

const m = (overrides: Partial<ProfileMatch> = {}): ProfileMatch => ({
  matchId: '1',
  heroId: 1,
  startTime: NOW_S - DAY,
  win: true,
  duration: 1800,
  kills: 10,
  deaths: 5,
  assists: 10,
  netWorth: 30000,
  matchMode: 'unranked',
  gameMode: 'normal',
  ...overrides,
});

describe('periodWindow (UTC)', () => {
  it('7d et 30d : fenêtre glissante depuis l’instant de référence', () => {
    expect(periodWindow('7d', NOW, null)).toEqual({
      from: NOW_S - 7 * DAY,
      to: NOW_S,
      seasonUnknown: false,
    });
    expect(periodWindow('30d', NOW, 123).from).toBe(NOW_S - 30 * DAY);
  });

  it('season : début de saison ; inconnu → aucune borne et seasonUnknown', () => {
    expect(periodWindow('season', NOW, 1_000)).toEqual({
      from: 1_000,
      to: NOW_S,
      seasonUnknown: false,
    });
    expect(periodWindow('season', NOW, null)).toEqual({
      from: null,
      to: NOW_S,
      seasonUnknown: true,
    });
  });

  it('sans période : tout l’historique', () => {
    expect(periodWindow(undefined, NOW, null)).toEqual({
      from: null,
      to: NOW_S,
      seasonUnknown: false,
    });
  });
});

describe('selectMatches', () => {
  const all = { from: null, to: NOW_S, seasonUnknown: false };

  it('bornes : début inclus, parties hors fenêtre ou futures exclues', () => {
    const window = periodWindow('7d', NOW, null);
    const history = [
      m({ matchId: 'future', startTime: NOW_S + 10 }),
      m({ matchId: 'edge', startTime: NOW_S - 7 * DAY }),
      m({ matchId: 'old', startTime: NOW_S - 7 * DAY - 1 }),
    ];
    expect(selectMatches(history, {}, window).matches.map((x) => x.matchId)).toEqual(['edge']);
  });

  it('gameMode et matchMode indépendants : normal inclut ranked et unranked', () => {
    const history = [
      m({ matchId: 'a', gameMode: 'normal', matchMode: 'ranked' }),
      m({ matchId: 'b', gameMode: 'normal', matchMode: 'unranked' }),
      m({ matchId: 'c', gameMode: 'street_brawl', matchMode: 'unranked' }),
    ];
    const ids = (filter: object) =>
      selectMatches(history, filter, all).matches.map((x) => x.matchId);
    expect(ids({ gameMode: 'normal' })).toEqual(['a', 'b']);
    expect(ids({ matchMode: 'unranked' })).toEqual(['b', 'c']);
    expect(ids({ gameMode: 'normal', matchMode: 'unranked' })).toEqual(['b']);
    expect(ids({ gameMode: 'street_brawl', matchMode: 'ranked' })).toEqual([]);
  });

  it('mode inconnu : retenu sous « all » (compté), écarté d’un filtre précis (compté)', () => {
    const history = [
      m({ matchId: 'x', gameMode: null }),
      m({ matchId: 'y', matchMode: undefined }),
      m(),
    ];
    expect(selectMatches(history, {}, all)).toMatchObject({
      excludedUnknownMode: 0,
      unknownModeMatches: 2,
    });
    const precise = selectMatches(history, { gameMode: 'normal', matchMode: 'unranked' }, all);
    expect(precise.matches).toHaveLength(1);
    expect(precise.excludedUnknownMode).toBe(2);
    // gameMode précis seulement : une partie au matchMode inconnu reste « all » sur cet axe.
    expect(selectMatches(history, { gameMode: 'normal' }, all)).toMatchObject({
      excludedUnknownMode: 1,
      unknownModeMatches: 1,
    });
  });

  it('héros et résultat', () => {
    const history = [m({ heroId: 2, win: false }), m({ heroId: 2 }), m({ heroId: 3, win: false })];
    expect(selectMatches(history, { heroId: 2 }, all).matches).toHaveLength(2);
    expect(selectMatches(history, { outcome: 'loss' }, all).matches).toHaveLength(2);
    expect(selectMatches(history, { heroId: 2, outcome: 'loss' }, all).matches).toHaveLength(1);
  });
});

describe('aggregate', () => {
  it('aucune partie → compteurs à 0, ratios null, échantillons à 0', () => {
    expect(aggregate([])).toEqual({
      matches: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      kills: null,
      deaths: null,
      assists: null,
      kda: null,
      kdaSampleSize: 0,
      avgNetWorthPerMinute: null,
      netWorthPerMinuteSampleSize: 0,
      avgDurationSeconds: null,
      durationSampleSize: 0,
    });
  });

  it('KDA sur le même sous-ensemble complet (une partie sans D est exclue des trois totaux)', () => {
    const stats = aggregate([
      m({ kills: 10, deaths: 2, assists: 4 }),
      m({ kills: 6, deaths: null, assists: 6, win: false }),
      m({ kills: 1, deaths: 1, assists: 1 }),
    ]);
    expect(stats).toMatchObject({
      matches: 3,
      wins: 2,
      losses: 1,
      winRate: 66.67,
      kills: 11,
      deaths: 3,
      assists: 5,
      // (11 + 5) / 3
      kda: 5.33,
      kdaSampleSize: 2,
    });
  });

  it('morts à 0 → dénominateur 1', () => {
    expect(aggregate([m({ kills: 3, deaths: 0, assists: 2 })]).kda).toBe(5);
  });

  it('net worth/min = moyenne des ratios par partie, durée > 0 et net worth connu seulement', () => {
    const stats = aggregate([
      m({ netWorth: 30000, duration: 1800 }), // 1000 / min
      m({ netWorth: 20000, duration: 600 }), // 2000 / min
      m({ netWorth: null, duration: 1200 }),
      m({ netWorth: 5000, duration: 0 }),
      m({ netWorth: 5000, duration: null }),
    ]);
    // Moyenne des ratios (1500), et non total / total (50000 / 40 min = 1250).
    expect(stats.avgNetWorthPerMinute).toBe(1500);
    expect(stats.netWorthPerMinuteSampleSize).toBe(2);
    // Durées valides : 1800, 600, 1200 (0 et null exclues).
    expect(stats.avgDurationSeconds).toBe(1200);
    expect(stats.durationSampleSize).toBe(3);
  });

  it('aucune partie complète → KDA null, pas 0', () => {
    expect(aggregate([m({ kills: null })])).toMatchObject({
      kills: null,
      kda: null,
      kdaSampleSize: 0,
      winRate: 100,
    });
  });
});

describe('modeBreakdown et groupByHero', () => {
  it('combinaisons observées, modes inconnus ignorés, volume décroissant', () => {
    expect(
      modeBreakdown([
        m({ matchMode: 'ranked' }),
        m({ matchMode: 'unranked', win: false }),
        m({ matchMode: 'unranked' }),
        m({ gameMode: 'street_brawl' }),
        m({ gameMode: null }),
      ]),
    ).toEqual([
      { gameMode: 'normal', matchMode: 'unranked', matches: 2, wins: 1, losses: 1, winRate: 50 },
      { gameMode: 'normal', matchMode: 'ranked', matches: 1, wins: 1, losses: 0, winRate: 100 },
      {
        gameMode: 'street_brawl',
        matchMode: 'unranked',
        matches: 1,
        wins: 1,
        losses: 0,
        winRate: 100,
      },
    ]);
  });

  it('égalité de volume départagée par mode de jeu puis type', () => {
    const modes = modeBreakdown([
      m({ gameMode: 'street_brawl', matchMode: 'unranked' }),
      m({ gameMode: 'normal', matchMode: 'unranked' }),
      m({ gameMode: 'normal', matchMode: 'ranked' }),
    ]);
    expect(modes.map((x) => `${x.gameMode}/${x.matchMode}`)).toEqual([
      'normal/ranked',
      'normal/unranked',
      'street_brawl/unranked',
    ]);
  });

  it('héros par volume puis id', () => {
    const groups = groupByHero([
      m({ heroId: 5 }),
      m({ heroId: 2 }),
      m({ heroId: 5 }),
      m({ heroId: 1 }),
    ]);
    expect(groups.map(([id, list]) => [id, list.length])).toEqual([
      [5, 2],
      [1, 1],
      [2, 1],
    ]);
  });
});

describe('filtres de requête', () => {
  it('défauts sans filtre ; empreinte stable et différente selon les filtres', () => {
    const none = historyFilterSchema.parse({});
    expect(hasFilters(none)).toBe(false);
    expect(hasFilters(historyFilterSchema.parse({ gameMode: 'all', outcome: 'all' }))).toBe(false);
    const a = historyFilterSchema.parse({ period: '7d' });
    expect(hasFilters(a)).toBe(true);
    expect(filterFingerprint(a)).toBe(
      filterFingerprint(historyFilterSchema.parse({ period: '7d' })),
    );
    expect(filterFingerprint(a)).not.toBe(
      filterFingerprint(historyFilterSchema.parse({ period: '30d' })),
    );
    expect(filterFingerprint(a)).toMatch(/^[\w-]{10}$/);
  });

  it.each([
    [{ period: '1y' }],
    [{ gameMode: 'sandbox' }],
    [{ matchMode: 'private_lobby' }],
    [{ outcome: 'draw' }],
    [{ heroId: '0' }],
    [{ heroId: 'abc' }],
  ])('%p → invalide', (query) => {
    expect(historyFilterSchema.safeParse(query).success).toBe(false);
  });
});
