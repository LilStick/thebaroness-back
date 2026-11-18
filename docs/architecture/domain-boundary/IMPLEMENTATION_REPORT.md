# Rapport d'implémentation (v1.12.0, 18/11/2026)

## Lot A : contrats et métriques

- `src/shared/metrics.ts` regroupe `round2`, `percent`, `mean`, `rawKda`, `kda`, `perMinute`, `competitionRanks` et `mapLimit`. Les doublons ont été supprimés dans `players.service`, `profile-stats`, `meta.service`, `match-detail` et `group.compare`.
- `completeCaseKda` : un seul calcul de KDA agrégé, sur les parties où K, D et A sont tous connus. Il sert au profil et aux groupes.
- `/players/:id/trends` :
  - `series[]` donne une entrée par partie : KDA, souls/min, winrate glissant sur 10 parties et taille de son échantillon ;
  - le paramètre `period` est désormais optionnel ;
  - `coverage` gagne `seriesMatches`, `seriesFrom`, `seriesTo` et `rollingPointsComplete`, ainsi que la note `season_start_unknown`.
- `/matches/:id` : les métriques sont calculées **à la lecture**. Le cache `match:v3` reste valable, sans changer de version.
  - Par joueur : `kda`, `netWorthRank`, `teamNetWorthRank`, `lastHitsPerMinute`, `performanceTags`.
  - Par équipe : `result`, `totals`, `totalsCoverage`.

## Lot B : enrichissements groupés

- `/players/:id/heroes` : `globalMeta`, `winRateVsMeta` et `metaContext`. La méta vient d'une seule lecture de cache, `loadHeroMetaTable`, partagée avec `/heroes/:id/stats`.
- `/groups/:id/compare` :
  - par membre : `kdaSampleSize`, `currentRankScore`, `rankDelta`, et `rankHistory[].badge` ;
  - pour le groupe : `highlights[]` (6 entrées, tous les ex æquo) et `methodology`.
- `GET /tracked-players/insights` : une carte par suivi, 100 au maximum, 4 joueurs chargés simultanément, uniquement depuis le cache profil et historique. L'échec d'un joueur reste isolé sur sa ligne.
- `POST /tracked-players` : limite de 100 suivis par compte (`409 TRACKED_LIMIT_REACHED`).

## Lot C : découverte

- `/leaderboard` : `avatarUrl` (un appel `/v1/players/steam` groupé, cache `leaderboard-avatars:v1:<région>` de 6 h), `badge.badgeId`, `badge.color` et `coverage`.
- Recherche : inchangée. Pseudo et avatar sont déjà fournis, et ajouter le rang coûterait 2 appels par résultat.

## Tests

466 tests au vert, contre 453 avant. Lint, typecheck et build sont propres.

**Tests synthétiques** (fixtures construites) :

- formules de série ;
- égalités : rang compétition, highlights ;
- nullabilité : statistique absente chez un seul joueur, durée nulle ;
- totaux partiels ;
- vainqueur inconnu (`result: null`) ;
- seuil de 5 parties ;
- insights : joueur introuvable, historique en 503, isolement entre comptes, 401, second appel sans requête source, limite de 100 ;
- avatars servis par le cache ;
- méta lue une seule fois pour plusieurs requêtes.

**Vérification sur données réelles** (serveur local sur le port 3002, Deadlock API réelle, sans déploiement) :

- `/trends?size=10` d'Explo : 69 parties éligibles, 10 points de série, `rollingPointsComplete` à 10. Dernier point : KDA 4.57, 1372.1 souls/min, glissant à 40 %.
- `/heroes?period=30d&gameMode=normal` : Calico à 53.33 %, méta à 48.18 % sur 1 024 119 parties, écart de +5.15, `comparable: true`.
- `/matches/139349713` : totaux connus pour les deux équipes (6 joueurs chacune). Les dégâts infligés par l'une égalent les dégâts subis par l'autre (123 351 et 151 419), ce qui est cohérent. `result` est identique à `outcome`.
- `/leaderboard?region=Europe` : 100 entrées, 98 avec SteamID, 98 avec rang, 98 avec avatar, 43 SteamID déduits parmi des homonymes. Premier appel à froid en 10,5 s, comme avant : le coût vient des rangs.
- `players.card` sur deux comptes réels : forme sur 10 parties et dernière partie présentes. Le rang « non classé » est identique à celui de `/players/:id`.

## Écarts avec la demande

- L'enrichissement des lignes d'historique (50 appels `/matches/:id`) n'est pas fait. Il est proposé dans `API_MIGRATION_PLAN.md`.
- `DataMeta` garde trois constructeurs. C'est une dette interne, sans effet sur le contrat.
- Le front n'a pas été modifié : son dépôt est en lecture seule ici.
