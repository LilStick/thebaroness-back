# Plan de migration de l'API (v1.12.0)

Principe : uniquement des **ajouts**. Aucun champ, aucune route ni aucun statut existant n'est retiré ou renommé. Le front actuel (`b2effca`) continue de fonctionner sans modification.

## Étapes

1. **Back v1.12.0 (cette livraison)** : nouveaux champs et route `GET /tracked-players/insights`.
2. **Front, sprint suivant** : remplacer les calculs locaux par les champs back (voir `FRONTEND_HANDOFF.md`), supprimer les N+1 et le code mort.
3. **Back, après confirmation du front** : marquer comme dépréciés (sans les supprimer) les champs devenus inutiles :
   - `teams[].outcome`, remplacé par `result` ;
   - `/trends.rolling`, remplacé par `series[].rollingWinRate`.

   Une suppression n'interviendra qu'après accord écrit du front et dans une version majeure.

## Changements de comportement (non cassants)

| Changement                                                                                                                   | Effet observable                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Le KDA de `/players/:id` (`stats.kda`) et de `/groups/:id/compare` est calculé sur les parties où K, D et A sont tous connus | identique dès qu'aucune partie n'a de K, D ou A partiel, ce qui est le cas de toutes les parties réelles observées                                                               |
| `relationships[].winRate` utilise `percent`                                                                                  | même valeur (2 décimales)                                                                                                                                                        |
| `POST /tracked-players` au-delà de 100 suivis                                                                                | `409 TRACKED_LIMIT_REACHED`. Aucun compte réel n'approche ce seuil                                                                                                               |
| `/players/:id/heroes` lit la méta globale en cache                                                                           | +1 lecture Mongo par requête. À froid, +1 appel source au plus toutes les 30 min (partagé avec `/heroes/:id/stats`). En cas d'échec, `globalMeta` et `metaContext` valent `null` |
| `/leaderboard` lit les avatars                                                                                               | +1 lecture Mongo. À froid, +1 appel groupé par région toutes les 6 h. En cas d'échec, `avatarUrl` vaut `null`                                                                    |

## Non fait, proposé pour la suite

| Sujet                  | Proposition                                                            | Pourquoi pas maintenant                                                           |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `DataMeta`             | fusionner `meta()`, `dataMeta()` et la construction de `group.compare` | refactor interne sans effet sur le contrat                                        |
| Stampede du cache      | verrou par clé dans `cached()`                                         | utile si le trafic augmente ; aujourd'hui, la déduplication HTTP du client suffit |
| Rang dans la recherche | lire le rang seulement s'il est déjà en cache                          | lecture Mongo par résultat ; gain faible                                          |

## v1.13.0 : résumés des lignes d'historique

`GET /players/{id}/matches?include=summary` joint un `summary` à chaque partie de la page. Les parties manquantes sont lues à la source, 4 à la fois, puis gardées 7 jours dans le cache `match:v3`, partagé avec `/matches/{id}`. Sans `include`, la réponse est identique à celle de la v1.12.

Mesure réelle pour 50 parties : 8,5 s à froid, 50 ms à chaud. C'est le même nombre d'appels source que les 50 appels `/matches/:id` que faisait le front, mais en une seule requête HTTP, avec une concurrence bornée et un cache partagé.
