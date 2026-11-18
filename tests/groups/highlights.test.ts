import { groupHighlights, type GroupMemberStats } from '../../src/modules/groups/group.compare';

const member = (steamId: string, extra: Partial<GroupMemberStats> = {}): GroupMemberStats => ({
  steamId,
  displayName: steamId,
  avatarUrl: null,
  rank: null,
  matches: 10,
  wins: 5,
  losses: 5,
  winRate: 50,
  kda: 2,
  longestWinStreak: 2,
  bestMatch: null,
  rankHistory: [],
  kdaSampleSize: 10,
  currentRankScore: null,
  rankDelta: null,
  excludedUnknownModeMatches: 0,
  previous: null,
  deltaVsPrevious: null,
  ...extra,
});

const byKey = (members: GroupMemberStats[]) =>
  Object.fromEntries(groupHighlights(members).map((h) => [h.key, h]));

describe('Highlights de groupe (synthétique)', () => {
  it('égalité → tous les ex æquo, dans l’ordre du groupe', () => {
    const h = byKey([member('a'), member('b', { kda: 3 }), member('c', { kda: 3 })]);
    expect(h.best_kda).toMatchObject({ steamIds: ['b', 'c'], value: 3, eligibleMembers: 3 });
    expect(h.most_wins?.steamIds).toEqual(['a', 'b', 'c']);
  });

  it('seuil de 5 parties pour winrate et KDA, pas pour les victoires', () => {
    const h = byKey([member('a', { matches: 4, wins: 4, winRate: 100 }), member('b')]);
    expect(h.best_win_rate).toMatchObject({ steamIds: ['b'], value: 50, eligibleMembers: 1 });
    expect(h.most_wins).toMatchObject({ steamIds: ['b'], value: 5 });
  });

  it('valeur nulle ou négative → aucun gagnant ; inconnue → non éligible', () => {
    const h = byKey([
      member('a', { rankDelta: 0, wins: 0, longestWinStreak: 0 }),
      member('b', { rankDelta: -2, wins: 0, longestWinStreak: 0 }),
    ]);
    expect(h.biggest_climb).toEqual({
      key: 'biggest_climb',
      steamIds: [],
      value: null,
      matchId: null,
      eligibleMembers: 2,
      minMatches: 0,
    });
    expect(h.most_wins?.steamIds).toEqual([]);
    expect(h.best_match).toMatchObject({ steamIds: [], eligibleMembers: 0 });
    expect(byKey([]).best_kda).toMatchObject({ steamIds: [], value: null, eligibleMembers: 0 });
  });
});
