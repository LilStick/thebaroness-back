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

- `DataMeta` garde trois constructeurs. C'est une dette interne, sans effet sur le contrat.
- Le front n'a pas été modifié : son dépôt est en lecture seule ici.

## v1.13.0 : lignes d'historique

- Nouveau paramètre `include=summary` sur `/players/{id}/matches`. Pour chaque partie de la page, il ajoute : `mvpRank`, `killParticipation`, `kda`, `netWorthRank`, `teamNetWorthRank`, `playersInMatch`, `lastHitsPerMinute`, `performanceTags`, `finalItemIds` et `teamAverageBadge`. La réponse gagne aussi `summaryCoverage`.
- `loadMatch` (cache `match:v3`) est désormais partagé entre `/matches/{id}` et les résumés. `killParticipation` est factorisée dans `match-detail.ts`.
- Tests synthétiques (4) :
  - résumé conforme aux règles du détail de partie ;
  - partie en 503 et joueur absent → `null` isolé ;
  - second appel servi par le cache ;
  - réponse inchangée sans `include` ;
  - curseur toujours valable ;
  - 400 sur une valeur invalide.

  470 tests au total.

- Vérification réelle sur LilStick (50 parties) : 50 résumés sur 50, 8,5 s à froid, 50 ms à chaud.

## v1.14.0 : finalisation et préparation du Sprint 2 (18/11/2026)

### A. Méta des héros groupée : `GET /heroes/stats?heroIds=…`

- **Pourquoi un endpoint groupé** : il répond à exactement ce que l'accueil affiche, alors qu'enrichir `/heroes` aurait pesé sur toutes les pages du catalogue.
- **Lectures** : une lecture du catalogue (`playableHeroIds`, même filtre que `/heroes`) et une lecture de `analytics:hero-stats` (`loadHeroMetaTable`, 30 min), quel que soit le nombre de héros.
- **Cas limites** :
  - un id inconnu ou non jouable va dans `unknownHeroIds`, sans 404 global ;
  - un héros jouable sans données a toutes ses valeurs à `null`, comme la route individuelle.
- **Réponse** : la fenêtre est exposée dans `scope` (30 jours, mode normal, ranked et unranked confondus) et la couverture dans `coverage`.
- **Montage** : le routeur méta passe avant celui du catalogue, sinon `/heroes/stats` serait lu comme `/heroes/:heroId`. Un test vérifie que `/heroes/:heroId` répond toujours.
- **Mesure réelle** : 9 héros de l'accueil. Un appel groupé prend 0,04 s, contre 0,09 s pour 9 appels parallèles. Les valeurs sont identiques à celles de `/heroes/6/stats` : 52.07 % de winrate et 32.17 % de pick rate sur 2 142 015 parties.

### B. `netWorthPerMinute` dans `include=summary`

- **Calcul** : `perMinute` partagé, arrondi à 2 décimales, identique à `/trends.series`. La valeur est `null` si la valeur nette est inconnue ou si la durée est ≤ 0.
- **Mesure réelle** : 1412.98 pour une partie de 2 865 s.
- **Périmètre** : le résumé n'a pas été élargi au-delà de ce champ.

### C. Hygiène

- **`DataMeta`** : un seul constructeur, `combineMeta` (`src/shared/data-meta.ts`). `dataMeta`, le `meta` des joueurs et `group.compare` passent par lui.
- **Cache, requêtes simultanées** : un single-flight par clé et par processus dans `cached()`.
  - Les requêtes simultanées sur une clé expirée partagent une seule lecture source. Chaque appelant reçoit sa propre copie (`structuredClone`).
  - En cas d'échec partagé, chacun applique son repli « périmé ».
  - Tests : 5 appels simultanés donnent 1 appel source.
- **Formules** : `percent` était encore dupliqué dans `builds` et `items` ; ils utilisent maintenant la version partagée.
- **Champs dépréciables** : `teams[].outcome` et `/trends.rolling` sont conservés tels quels.

### D. Correctif trouvé pendant la vérification réelle : quotas par route

- **Ce qui se passait** : un 429 sur `/v1/players/rank`, après trois classements froids d'affilée, bloquait **tout** le client Deadlock pendant `Retry-After`. Résultat : `/players/search` répondait 503, et les avatars et rangs d'Asie manquaient (3 rangs et 0 avatar sur 85).
- **Ce que montrent les en-têtes `ratelimit-*`** : les quotas sont **par route**.
  - `/v1/players/rank` : 10 000 par 60 s ;
  - `/v1/analytics/hero-stats` : 400 par 60 s ;
  - la recherche répondait 200 pendant ce temps.
- **Correctif** : le blocage est maintenant indexé par route. Les segments numériques sont normalisés (`/v1/players/:id/match-history`).
- **Après correctif** :
  - recherche en 0,4 s ;
  - Asie à 77 rangs et 78 avatars sur 85 entrées, `isPartial` à `false`.
- **Avatars du classement** : la clé de cache est liée à l'ensemble des comptes (`leaderboard-avatars:v2:<région>:<empreinte>`). Un nouvel entrant déclenche un nouvel appel groupé au lieu d'attendre 6 h sans avatar.

### Sprint 2 : état vérifié sur données réelles (18/11/2026)

**`/leaderboard`**

| Région           | Entrées | Avec SteamID | Avec rang | Avec avatar | À froid |
| ---------------- | ------- | ------------ | --------- | ----------- | ------- |
| Europe           | 100     | 98           | 98        | 98          | 10,5 s  |
| Amérique du Nord | 100     | 93           | 93        | 93          | 2,9 s   |
| Asie             | 85      | 78           | 77        | 78          | 5,6 s   |

- **Position** : `rank` reprend la source, ex æquo compris (doublons possibles, par exemple deux 77e en Asie).
- **Champs** : `inferred` et `coverage` sont présents. `isPartial` vaut `true` si les rangs sont incomplets, et la copie est alors refaite après 1 min.
- **Limite** : enchaîner plusieurs régions à froid en moins d'une minute peut épuiser le quota de `/v1/players/rank`. Les autres routes ne sont plus touchées.

**`/players/search`**

- 20 résultats au maximum, avec pseudo et avatar ; environ 0,4 s à froid, cache de 5 min.
- Aucun enrichissement ajouté : le rang coûterait 2 appels par résultat.

### Tests

483 au vert, contre 470 avant. Lint, typecheck, build et prettier sont propres.

Tests synthétiques ajoutés :

- méta groupée : 8 cas (ordre, doublons, ids inconnus et non jouables, héros sans données, égalité avec la route individuelle, une seule lecture source, 400, 503, routes du catalogue intactes) ;
- résumé : souls/min, durée nulle, joueur absent ;
- single-flight : 2 cas ;
- blocage par route ;
- avatars d'un nouvel entrant.

## v1.15.0 : groupes et comparaison (Sprint 3, 19/11/2026)

Référence : demandes du front dans `docs/back-groups-sprint3-requests.md` (front `2762ced`).

| Demande                           | État                                       | Détail                                                                                     |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| P1-1 Identité des membres         | **Livré**                                  | `GET /groups?include=members`                                                              |
| P1-2 Jouer ensemble               | **Livré, sur une autre base que proposée** | `include=pairs`, intersection exacte des historiques ; `mate-stats` écarté (voir plus bas) |
| P1-3 Filtres de mode              | **Livré**                                  | `gameMode`, `matchMode`, `appliedFilters`                                                  |
| P1-4 Membres indisponibles        | **Livré**                                  | `unavailable[]` avec 5 raisons réellement distinguables                                    |
| P2-1 Période précédente           | **Livré avec limites**                     | 7d et 30d ; `null` pour `season`                                                           |
| P2-2 Chute des rangs              | **Cause établie et corrigée**              | Changement de saison de la source ; voir `docs/architecture/rank-season-change.md`         |
| Marqueur `rankReset` heuristique  | **Refusé**                                 | Les frontières de saison publiées par la source suffisent et sont fiables                  |
| Escouade de matchmaking confirmée | **Refusé**                                 | Information absente de la source                                                           |

### P1-2 : pourquoi pas `mate-stats`

D'après la spécification de la source, `same_party` signifie : même équipe **et amis Steam** au début de la partie, d'après la liste d'amis publique. C'est une heuristique, pas une escouade de matchmaking. La description de `relationships` disait l'inverse ; elle est corrigée dans l'OpenAPI et le HANDOFF.

`mate-stats` aurait aussi demandé N appels supplémentaires, une troncature (`minMatches`) et ne gère pas `matchMode`.

L'intersection des historiques que la comparaison a déjà chargés est **exacte** :

- même partie et même résultat signifie forcément la même équipe, puisqu'une seule équipe gagne ;
- résultats opposés signifie des adversaires ;
- elle ne coûte **aucun appel** ;
- elle honore la période et les deux filtres de mode.

Recoupement réel : sur une paire Eternus, `mate-stats` donne 16 parties et 11 victoires (identique dans les deux sens), nous 15 et 11. La partie d'écart a `player_match_outcome = 5` (non scorée) pour les deux joueurs : elle est exclue, comme dans toutes nos statistiques.

### P1-4 : raisons

Le client Deadlock porte maintenant la cause de chaque indisponibilité (`AppError.upstreamReason`, jamais sérialisé) :

- `rate_limited` : 429, ou route bloquée après un 429 ;
- `timeout` ;
- `unreachable` ;
- `unavailable` : 503 ou 504.

La comparaison en déduit `not_found`, `rate_limited`, `timeout`, `provider_error` (unreachable, 502, 503) et `unknown`.

### Coût et performances (données réelles, back local)

| Opération                                     | À froid | À chaud | Appels externes                |
| --------------------------------------------- | ------- | ------- | ------------------------------ |
| Comparaison de 6 Eternus avec `include=pairs` | 3,1 s   | 47 ms   | aucun de plus que sans `pairs` |
| Avec filtre `normal` + `ranked`               | n/a     | 35 ms   | aucun (filtre en mémoire)      |
| `identities` de 9 joueurs                     | 0,9 s   | 4 ms    | 1 appel groupé                 |

Pour les identités, 6 des 9 joueurs venaient des copies `profile:` existantes. Il faut un appel `/v1/players/steam` par tranche de 100 comptes manquants. En cas de quota épuisé, la liste reste en 200 : copie périmée si elle existe, sinon repli explicite.

### Tests

502 tests au vert, contre 483 avant. Les nouveaux tests synthétiques couvrent :

- les modes : `all`, `normal`, `street_brawl`, `ranked`, `unranked`, mode inconnu, période vide, valeurs invalides ;
- les saisons : points annotés, progression sur la dernière saison, saisons indisponibles, `rank-history` ;
- la période précédente : 30 jours, et `season` à null ;
- les paires : même équipe, adversaires, filtres, aucun appel, 20 membres (190 paires évaluées) ;
- les indisponibilités : 404, 429, classification ;
- les causes côté client : quota, délai dépassé, réseau, panne ;
- les identités : déduplication entre groupes, un seul appel, cache chaud, réutilisation de `profile:`, source en 429, copie périmée, rétrocompatibilité.
