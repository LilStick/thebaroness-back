# Handoff front : frontière des règles métier (back v1.12.0)

Tous les changements sont **additifs**. Le front `b2effca` fonctionne sans modification. Le contrat complet se trouve dans `docs/openapi.yaml` (v1.12.0).

Règle générale : `null` signifie inconnu, jamais 0. Les SteamID64 sont des chaînes. Les pourcentages vont de 0 à 100 avec 2 décimales.

## 1. `GET /players/{steamId}/trends` (modifié)

Nouveau paramètre `period=7d|30d|season`, optionnel. Sans lui, la route porte sur tout l'historique, comme en v1.11.

```ts
interface TrendPoint {
  matchId: string;
  at: string;                         // ISO
  heroId: number;
  win: boolean;
  matchMode: string | null;           // 'ranked' | 'unranked' | ...
  gameMode: string | null;            // 'normal' | 'street_brawl' | ...
  kills: number | null; deaths: number | null; assists: number | null;
  kda: number | null;                 // (K+A)/max(D,1), 2 décimales
  netWorthPerMinute: number | null;   // souls/min, 2 décimales
  durationSeconds: number | null;
  rollingWinRate: number | null;      // % sur cette partie + 9 précédentes du périmètre ; null s'il en manque
  rollingSampleSize: number;          // ≤ 10
}
// PlayerTrends gagne :
series: TrendPoint[];                 // bloc récent (`size`), du plus ancien au plus récent
filters.period: '7d' | '30d' | 'season' | null;
coverage.seriesMatches: number;
coverage.seriesFrom: string | null; coverage.seriesTo: string | null;
coverage.rollingPointsComplete: number;
coverage.notes: ('insufficient_history' | 'history_stale' | 'season_start_unknown')[];
```

Exemple réel (Explo, `size=10`) :

```json
{
  "matchId": "139349713",
  "at": "2026-11-17T22:53:25.000Z",
  "heroId": 16,
  "win": true,
  "matchMode": "unranked",
  "gameMode": "normal",
  "kills": 14,
  "deaths": 7,
  "assists": 18,
  "kda": 4.57,
  "netWorthPerMinute": 1372.1,
  "durationSeconds": 1526,
  "rollingWinRate": 40,
  "rollingSampleSize": 10
}
```

**Côté front, dans `RecentPerformance.tsx`** :

- appeler `/trends?size=N&period=…&gameMode=…&matchMode=…` ;
- tracer `series[].kda`, `series[].netWorthPerMinute` et `series[].rollingWinRate` ;
- supprimer `matchKda`, `netPerMinute` et la boucle de glissement locale ;
- afficher les points où `rollingWinRate` vaut `null` comme « échantillon insuffisant ».

Attention : le glissement démarre désormais à la 10e partie et non plus à la 5e.

## 2. `GET /players/{steamId}/heroes` (modifié)

```ts
// PlayerHeroStat gagne :
globalMeta: { matches: number | null; winRate: number | null; pickRate: number | null } | null;
winRateVsMeta: number | null;         // winRate − globalMeta.winRate, en points, 2 décimales
// réponse gagne :
metaContext: {
  period: '30d'; gameMode: 'normal'; matchMode: 'all';
  comparable: boolean;                // true seulement si le joueur est filtré period=30d&gameMode=normal&matchMode=all
  fetchedAt: string; isStale: boolean;
} | null;                             // null : méta indisponible (globalMeta null partout)
```

**Côté front, dans `useProfileData.ts`** :

- supprimer les 12 `useQueries` sur `/heroes/:id/stats` ;
- `heroRows` lit `winRateVsMeta` ;
- si `comparable` vaut `false`, afficher « méta 30 jours, mode normal » à côté de l'écart.

## 3. `GET /matches/{matchId}` (modifié)

```ts
// MatchPlayer gagne :
kda: number | null;
netWorthRank: number | null;          // 1..12 dans la partie, ex æquo partagés (1,2,2,4) ; null si valeur nette inconnue
teamNetWorthRank: number | null;      // même règle, dans l'équipe
lastHitsPerMinute: number | null;
performanceTags: ('match_top_net_worth' | 'match_best_kda')[]; // calculés par The Baroness ; ≠ mvpRank (Valve)
// équipe gagne :
result: 'win' | 'loss' | null;        // null si vainqueur inconnu (outcome reste 'loss' dans ce cas)
totals: Record<'kills'|'deaths'|'assists'|'netWorth'|'lastHits'|'denies'|'playerDamage'|'damageTaken'|'objectiveDamage'|'healing', number | null>;
totalsCoverage: { players: number; knownPlayers: Record<string, number> };
```

Règles :

- Un total vaut `null` dès qu'un joueur de l'équipe n'a pas la valeur.
- Une distinction (`performanceTags`) n'est attribuée que si la statistique est connue pour tous les joueurs de la partie. Tous les ex æquo la reçoivent.
- Le MVP officiel reste `mvpRank === 1`.

**Côté front** :

- supprimer `kdaOf`, les deux versions de `netRank`, `teamTotal`, `csPerMin`, les badges calculés et le repli de KP dans `matchModel.ts` et `detail/model.ts` ;
- utiliser `result` à la place de `outcome`.

## 4. `GET /groups/{id}/compare` (modifié)

```ts
// membre gagne :
kdaSampleSize: number;
currentRankScore: number | null;      // tier*6+subrank de `rank`
rankDelta: number | null;             // dernier − premier score de rankHistory ; null sous 2 points
rankHistory: { at: string; score: number; badge: number }[]; // `badge` ajouté
// réponse gagne :
highlights: {
  key: 'biggest_climb' | 'best_win_rate' | 'most_wins' | 'best_kda' | 'longest_win_streak' | 'best_match';
  steamIds: string[];                 // tous les ex æquo, ordre du groupe ; [] si personne
  value: number | null;
  matchId: string | null;             // best_match seulement
  eligibleMembers: number;
  minMatches: number;                 // 5 pour best_win_rate et best_kda, 0 sinon
}[];                                  // toujours 6 entrées, dans cet ordre
methodology: { periodFrom: string | null; rankScore: string; kda: string; highlightMinMatches: number; ties: string };
```

Règles des highlights :

- la valeur doit être strictement positive ;
- une valeur inconnue rend le membre non éligible ;
- l'égalité ne donne pas lieu à un départage par nom.

**Côté front, dans `compare.ts`** :

- supprimer `currentScore`, `rankDelta`, `best` et `buildHighlights` ;
- garder `sortMembers` (tri local) et `scoreLabel` (libellé, ou nom de rang via `badge`).

Changement visible : avec un seul point d'historique, la progression était à 0 ; elle vaut maintenant `null`.

## 5. `GET /tracked-players/insights` (nouveau, JWT obligatoire)

```ts
interface TrackedInsights {
  items: {
    trackedPlayerId: string;
    steamId: string;
    alias: string;
    tags: string[];
    status: 'ok' | 'partial' | 'not_found' | 'unavailable';
    player: { displayName: string; avatarUrl: string | null } | null;
    rank: PlayerRank | null; // rang « non classé » (champs null) si aucune partie classée ; null si inconnu
    lastMatchAt: string | null;
    form: {
      results: ('win' | 'loss')[]; // du plus récent au plus ancien
      matchIds: string[];
      wins: number;
      losses: number;
      winRate: number | null;
      sampleSize: number;
      requestedSize: 10;
    } | null;
    meta: DataMeta | null;
    error: { code: string; message: string } | null;
  }[];
  total: number; // nombre de suivis du compte
  truncated: boolean; // > 100
  meta: DataMeta; // isPartial si une ligne n'est pas 'ok'
}
```

**Côté front, dans `insights.ts`** :

- remplacer les deux `useQueries` par un seul appel ;
- dans `TrackedPage`, lire `form.wins` et `form.sampleSize`.

Les métadonnées (`alias`, `note`, `tags`) continuent de passer par `GET /tracked-players`.

Nouveau statut : `POST /tracked-players` renvoie `409 TRACKED_LIMIT_REACHED` au-delà de 100 suivis.

## 6. `GET /leaderboard` (modifié)

```ts
// entrée gagne :
avatarUrl: string | null;
badge: { tier; subrank; name; imageUrl; badgeId: number | null; color: string | null } | null;
// réponse gagne :
coverage: { entries; withSteamId; inferredSteamId; withBadge; withAvatar; ranksComplete: boolean };
```

Mesure réelle en Europe le 18/11 : 98 entrées sur 100 ont un SteamID, un rang et un avatar.

**Côté front, dans `LeaderboardPage.tsx`** :

- supprimer `EntryRank`, qui faisait jusqu'à 10 appels `/players/:id`. Un `badge` à `null` signifie qu'aucun rang n'est connu, y compris dans le profil.
- afficher `avatarUrl`.

## 6 bis. `GET /players/{steamId}/matches?include=summary` (v1.13.0)

```ts
// avec include=summary, chaque MatchSummary gagne :
summary: {
  mvpRank: number | null;             // officiel (Valve)
  killParticipation: number | null;
  kda: number | null;
  netWorthRank: number | null;        // sur playersInMatch, ex æquo partagés
  teamNetWorthRank: number | null;
  playersInMatch: number;
  lastHitsPerMinute: number | null;
  performanceTags: ('match_top_net_worth' | 'match_best_kda')[];
  finalItemIds: number[] | null;      // null si catalogue d'items indisponible
  teamAverageBadge: number | null;
} | null;                             // null : partie indisponible ou joueur absent
// et la page gagne :
summaryCoverage: { requested: number; available: number; notes: ('some_matches_unavailable' | 'item_catalog_unavailable')[] };
```

Exemple réel (LilStick) :

```json
{
  "mvpRank": null,
  "killParticipation": 58.33,
  "kda": 3.18,
  "netWorthRank": 2,
  "teamNetWorthRank": 1,
  "playersInMatch": 12,
  "lastHitsPerMinute": 3.62,
  "performanceTags": [],
  "finalItemIds": [84321454, 3074274290],
  "teamAverageBadge": null
}
```

**Côté front** : `useMatchEnrichment` et `enrichMatch` (`matchModel.ts`) disparaissent. Il suffit d'ajouter `include=summary` à `usePlayerHistory`.

Une page de 50 parties met environ 8 s à froid et 50 ms à chaud. Pour un premier affichage rapide, mieux vaut charger 20 parties.

## 6 ter. `GET /heroes/stats?heroIds=6,11,13` (nouveau, v1.14.0)

```ts
interface HeroMetaBatch {
  items: HeroMetaStats[]; // même forme que `/heroes/{id}/stats` → `stats`, ordre demandé
  unknownHeroIds: number[]; // inconnus ou non jouables (pas de 404)
  scope: { period: '30d'; gameMode: 'normal'; matchMode: 'all' };
  coverage: { requested: number; known: number; withStats: number };
  meta: DataMeta;
}
```

`heroIds` est une liste séparée par des virgules, de 1 à 64 ids. Les doublons sont retirés. Sans ce paramètre, la route renvoie tous les héros jouables, par id croissant.

**Côté React (`features/home/widgets.tsx`)** : `HeroLine` ne doit plus appeler `useHeroStats` pour chaque héros. Il faut un hook `useHeroStatsBatch(ids)` dans `MetaWidget`, qui passe `stats` à chaque ligne. Cela fait un appel au lieu de 7 à 9.

Gain mesuré : 0,04 s au lieu de 0,09 s, et une requête HTTP au lieu de 9.

`/heroes/{id}/stats` reste inchangé pour la fiche héros.

**`include=summary` (v1.14.0)** : `summary.netWorthPerMinute: number | null` a été ajouté. Il suit la même formule que `series[].netWorthPerMinute`.

## 7. Inchangé

- `/players/search` : pseudo et avatar, sans rang (ajouter le rang coûterait 2 appels par résultat).
- `/overview`, `/activity`, `/rank-history`, `/relationships`, `/items*`, `/builds`, `/heroes/:id/stats`.

## 8. Endpoints à conserver pendant la transition

Tous. Deux champs sont amenés à être dépréciés plus tard, après accord du front : `teams[].outcome` (remplacé par `result`) et `/trends.rolling` (remplacé par `series[].rollingWinRate`). Aucun retrait n'est prévu dans cette version.

## 9. Code mort à supprimer côté front

Dans `lib/stats.ts` :

- `aggregate`, `recentDelta`, `rollingWinRate`, `streaks`, `kdaDistribution`, `winRateByDuration`, `hourDistribution`, `modeBreakdown` ;
- `calendar` (doublon de `calendarFromDays`), `rolesPlayed`, `KDA_BINS`, `kdaBinIndex`, `DURATION_BUCKETS` ;
- les types associés.

Dans les autres fichiers :

- `kdaOf`, exporté par `detail/model.ts` ;
- `ROMAN`, en double dans `items/tone.ts` ;
- `components/charts/Histogram.tsx`, s'il n'a plus de consommateur (à confirmer).
