# HANDOFF : back vers front

Fichier de liaison entre le Claude du back (`thebaroness-back`) et celui du front (`thebaroness`).
Le Claude du front le lit après un `pull` du back. Pendant côté front : `thebaroness/docs/HANDOFF.md`, lu par le back à chaque session.

Dernière mise à jour : 17/11/2026 (voir `git log -- docs/HANDOFF.md` pour le SHA). HANDOFF front relu sur `refonte-ui` au commit `5ec268f` (pack Profil joueur V2). Phase P1 livrée en v1.10.0.

## A lire en premier

- **Phase P1 livrée en v1.10.0** (section suivante) : détail de partie enrichi, historique de rang, activité, coéquipiers et adversaires, catalogue des items. **Correction de données à lire : l'historique complet inclut désormais les parties anciennes** (voir « Changement de comportement »).
- **Profil joueur V2, P0 livré en v1.9.0** : section suivante. Contrat : `docs/openapi.yaml` **v1.9.0** (aussi sur `/api/docs`), à recopier dans `src/contracts/openapi.yaml`. Tout est additif : aucun client v1.8 n'est cassé.
- Production : front `https://thebaroness.4esport.fr` et back `https://api.thebaroness.4esport.fr`. La v1.9.0 n'y sera qu'après le prochain déploiement du back (LilStick).
- Dépôt GitHub `LilStick/thebaroness-back` (l'ancienne URL `deadlock-tracker-back` redirige).

## Phase P1 : état de livraison (v1.10.0, 17/11/2026)

| Demande                                                            | Statut                           | Route ou champ                                                          |
| ------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------- |
| Détail de partie enrichi (statistiques, items, MVP, participation) | **Livré**                        | `GET /matches/{matchId}` : `MatchPlayer` étendu, `teams[].averageBadge` |
| Historique de rang                                                 | **Livré**                        | `GET /players/{steamId}/rank-history?period=`                           |
| Activité (heatmap)                                                 | **Livré**                        | `GET /players/{steamId}/activity?weeks=&gameMode=&matchMode=`           |
| Coéquipiers et adversaires                                         | **Livré**                        | `GET /players/{steamId}/relationships`                                  |
| Catalogue des items (base)                                         | **Livré**                        | `GET /items`, `GET /items/{itemId}`                                     |
| Statistiques d'items, builds, associations, tendances 20 vs 20     | **Non fait** (spécifié plus bas) | —                                                                       |

Etat Git : livré sur `main` du back (issue #81, SHA dans `git log`). Vérifié sur données réelles (FunKa, partie `136927164`). Production : après le prochain déploiement du back.

### Changement de comportement : parties anciennes incluses

Deadlock API renvoie `player_match_outcome = 0` (« non enregistré ») pour les parties anciennes (avant mi-2026 environ), et 1/2 ensuite. Le back n'acceptait que 1 et 2 : **il ignorait 70 à 80 % de l'historique complet** des comptes anciens (FunKa : 384 parties sur 539 ; soÿer : 3234 sur 4076). Désormais, pour `outcome = 0` sans abandon, le résultat est déduit de `match_result === player_team`, exactement la règle de la source (vérifié : 137 agrégats coéquipiers/adversaires sur 137 concordent). Les codes 3, 4, 5 (abandon, pénalité, non scoré) restent exclus.

- Effet : `GET /players/{steamId}` (stats de carrière), `/heroes` et `/matches` **sans période** comptent plus de parties (FunKa : 150 → 531). Les périodes `7d`, `30d` et `season` ne changent pas (parties récentes déjà en 1/2).
- Cache : clé `history:v2:<accountId>` (les copies v1 sont ignorées).

### `GET /api/matches/{matchId}` (enrichi, additif)

Chargement différé conservé : la route lit les métadonnées d'UNE partie (≈ 1,3 Mo chez la source), les normalise et ne garde en cache (`match:v3:<id>`, 7 jours) que la forme compacte. Aucun appel par partie depuis l'historique.

- Par équipe : `averageBadge` (badge moyen fourni par la source, `null` si inconnu, fréquent en non classé) et `averageRankName` (ex. « Phantom 4 »).
- Par joueur (nouveaux champs, tous nullables) :
  - `mvpRank` : classement MVP **calculé par Valve** (1 = meilleur), `null` s'il est absent ;
  - `killParticipation` : `(kills + assists) / éliminations de l'équipe × 100`, `null` si une valeur de l'équipe manque ;
  - `stats` (`MatchPlayerStats`, dernier relevé = fin de partie) : `playerDamage` (dégâts aux héros), `damageTaken`, `objectiveDamage`, `creepDamage`, `neutralDamage`, `healing`, `selfHealing`, `teammateHealing`, `damageMitigated`, `heroBulletsHit`, `heroBulletsHitCrit`, `heroCritRate` (critiques / balles sur héros × 100), `shotsHit`, `shotsMissed`, `accuracy` (toutes cibles), `headshotKills`, `creepKills`, `neutralKills` ; `stats: null` sans relevé ;
  - `purchases` : achats d'objets (type `upgrade` du catalogue), par seconde d'achat, avec `soldAtSeconds` (`null` si gardé) ; `finalItemIds` : objets jamais revendus ; `abilityUpgrades` : montées de capacités. Les trois valent `null` si le catalogue d'items ou les évènements sont indisponibles (`meta.isPartial`).
- Les `itemId` se résolvent avec `GET /items` (nom, image, prix, slot) : charger le catalogue une fois, pas un appel par item.

Exemple réel (FunKa, Celeste, listes tronquées) :

```json
{
  "steamId": "76561198009781660",
  "displayName": "FunKa",
  "heroId": 81,
  "heroName": "Celeste",
  "heroImageUrl": "https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/unicorn_sm.webp",
  "level": 34,
  "kills": 10,
  "deaths": 3,
  "assists": 6,
  "netWorth": 44665,
  "lastHits": 242,
  "denies": 9,
  "mvpRank": 1,
  "killParticipation": 64,
  "stats": {
    "playerDamage": 51825,
    "damageTaken": 21162,
    "objectiveDamage": 10607,
    "creepDamage": 52957,
    "neutralDamage": 22339,
    "healing": 11166,
    "selfHealing": 11166,
    "teammateHealing": 0,
    "damageMitigated": 26219,
    "heroBulletsHit": 143,
    "heroBulletsHitCrit": 49,
    "heroCritRate": 34.27,
    "shotsHit": 577,
    "shotsMissed": 469,
    "accuracy": 55.16,
    "headshotKills": 1,
    "creepKills": 131,
    "neutralKills": 37
  },
  "purchases": [
    {
      "itemId": 2829638276,
      "atSeconds": 72,
      "soldAtSeconds": 1455
    },
    {
      "itemId": 3077079169,
      "atSeconds": 207,
      "soldAtSeconds": 1022
    },
    {
      "itemId": 1672893796,
      "atSeconds": 266,
      "soldAtSeconds": 1088
    }
  ],
  "finalItemIds": [2603935618, 1925087134, 876563814, 395944548],
  "abilityUpgrades": [
    {
      "abilityId": 3443575800,
      "atSeconds": 10
    },
    {
      "abilityId": 3443575800,
      "atSeconds": 45
    }
  ]
}
```

### `GET /api/players/{steamId}/rank-history?period=season`

- Un point par partie classée **dont la source fournit le badge** ; aucune interpolation, aucun MMR. `score = tier × 6 + subrank` (même échelle que les groupes) ; `badge = tier × 10 + subrank` (Valve).
- `coverage.missingBadge` : parties classées sans badge (fréquent : FunKa 7 sur 11 cette saison ; soÿer 0 sur 156 sur 30 jours). Note `badge_missing_on_some_ranked_matches`.
- Défaut `season` ; `7d` et `30d` disponibles.

```json
{
  "period": "season",
  "points": [
    {
      "at": "2026-11-13T14:30:41.000Z",
      "matchId": "136659782",
      "badge": 46,
      "tier": 4,
      "subrank": 6,
      "score": 30,
      "name": "Sentinel 6",
      "imageUrl": "https://api.deadlock-api.com/v1/assets/ranks/4/6/image?format=webp",
      "outcome": "win"
    }
  ],
  "coverage": {
    "requestedFrom": "2026-11-05T20:00:00.000Z",
    "requestedTo": "2026-11-17T13:15:31.000Z",
    "rankedMatches": 11,
    "pointCount": 4,
    "missingBadge": 7,
    "isPartial": false,
    "notes": ["badge_missing_on_some_ranked_matches"]
  },
  "meta": {
    "fetchedAt": "2026-11-17T13:10:28.426Z",
    "sourceUpdatedAt": null,
    "isStale": false,
    "isPartial": false
  }
}
```

### `GET /api/players/{steamId}/activity?weeks=12`

- `weeks` 1 à 52 (défaut 12), `gameMode`, `matchMode` comme `/overview`. Un objet par jour UTC, du plus ancien à aujourd'hui inclus ; jour sans partie = 0 (historique source complet).

```json
{
  "weeks": 1,
  "filters": {
    "gameMode": "all",
    "matchMode": "all"
  },
  "days": [
    {
      "date": "2026-11-11",
      "matches": 9,
      "wins": 6,
      "losses": 3
    },
    {
      "date": "2026-11-12",
      "matches": 0,
      "wins": 0,
      "losses": 0
    }
  ],
  "summary": {
    "matches": 13,
    "wins": 10,
    "losses": 3,
    "activeDays": 2
  },
  "coverage": {
    "from": "2026-11-11",
    "to": "2026-11-17",
    "timezone": "UTC",
    "excludedUnknownMode": 0,
    "notes": []
  },
  "meta": {
    "fetchedAt": "2026-11-17T13:15:25.254Z",
    "sourceUpdatedAt": null,
    "isStale": false,
    "isPartial": false
  }
}
```

### `GET /api/players/{steamId}/relationships`

- Paramètres : `period` (absent = tout l'historique), `gameMode` `normal` (défaut) ou `street_brawl` (la source ne fait pas « tous modes »), `sameParty` (`true` : coéquipiers dans le même groupe, information de la source), `minMatches` (1 à 50, défaut 2), `limit` (1 à 50, défaut 10).
- `wins` = victoires **du joueur demandé** dans les parties communes. À présenter comme « joués avec / contre », jamais comme amis Steam.
- Une source en panne : sa liste vaut `null` et `meta.isPartial` ; les deux : 503. Cache 10 min (1 min si incomplet), borne basse arrondie à 10 min.

```json
{
  "appliedFilters": {
    "period": "season",
    "gameMode": "normal",
    "sameParty": false,
    "minMatches": 2,
    "limit": 2
  },
  "teammates": [
    {
      "steamId": "76561198249791904",
      "displayName": "LilStick",
      "avatarUrl": "https://avatars.steamstatic.com/cae1b5cb57c6cb1c45a031aa834b1043ed939c7a_full.jpg",
      "matches": 7,
      "wins": 2,
      "losses": 5,
      "winRate": 28.57
    },
    {
      "steamId": "76561199025088808",
      "displayName": "mai",
      "avatarUrl": "https://avatars.steamstatic.com/70c28851d6543f80bf9cd2ffc10396c49944cf63_full.jpg",
      "matches": 7,
      "wins": 2,
      "losses": 5,
      "winRate": 28.57
    }
  ],
  "opponents": [
    {
      "steamId": "76561198966168129",
      "displayName": "Herald",
      "avatarUrl": "https://avatars.steamstatic.com/27ac971ff132f96cefe965fbef89e79a4e35990d_full.jpg",
      "matches": 2,
      "wins": 0,
      "losses": 2,
      "winRate": 0
    }
  ],
  "coverage": {
    "requestedFrom": "2026-11-05T20:00:00.000Z",
    "notes": []
  },
  "meta": {
    "fetchedAt": "2026-11-17T13:10:40.895Z",
    "sourceUpdatedAt": null,
    "isStale": false,
    "isPartial": false
  }
}
```

### `GET /api/items` et `GET /api/items/{itemId}`

- Filtres de liste : `type` (`upgrade`, `ability`, `weapon`), `slot` (`weapon`, `vitality`, `spirit`), `tier` (1 à 5), `shopable` (`true`, `false`), `clientVersion`.
- `clientVersion` absent : version la plus récente du client (relue chaque heure). Un patch = une nouvelle version = un nouvel instantané ; les anciens restent disponibles (`?clientVersion=`) pour les items des vieilles parties.
- 782 items (250 objets, 437 capacités, 95 armes) ; `imageUrl` = icône de boutique pour les objets.

```json
{
  "clientVersion": 6861,
  "item": {
    "id": 1548066885,
    "className": "upgrade_clip_size",
    "name": "Extended Magazine",
    "type": "upgrade",
    "slot": "weapon",
    "tier": 1,
    "cost": 800,
    "isActive": false,
    "shopable": true,
    "disabled": false,
    "heroIds": [],
    "componentIds": [],
    "imageUrl": "https://assets-bucket.deadlock-api.com/assets-api-res/images/items/weapon/basic_magazine.webp"
  },
  "meta": {
    "fetchedAt": "2026-11-17T13:10:28.130Z",
    "sourceUpdatedAt": null,
    "isStale": false,
    "isPartial": false
  }
}
```

### Architecture du cache (un seul système : `api_cache`)

| Clé                                                      | Contenu                                             | TTL                                          |
| -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| `history:v2:<accountId>`                                 | historique normalisé                                | 3 min (copie périmée servie en cas de panne) |
| `match:v3:<matchId>`                                     | partie normalisée (sans les relevés intermédiaires) | 7 jours                                      |
| `catalog:client-version`                                 | version courante du client                          | 1 h                                          |
| `catalog:items:v<version>:en`                            | instantané immuable des items                       | 30 jours                                     |
| `catalog:items:latest:en`                                | repli si la version est inconnue                    | 24 h                                         |
| `relations:v1:<accountId>:<borne>:<mode>:<groupe>:<min>` | coéquipiers, adversaires, pseudos                   | 10 min (1 min si incomplet)                  |

`/rank-history` et `/activity` n'ont pas de cache propre : calcul de quelques millisecondes sur `history:v2`.

### P2 : spécification Items et Builds (non commencé)

Sources vérifiées chez Deadlock API : `/v1/analytics/item-stats` (taux de victoire et d'achat par item, filtrables par héros, mode, badge, période), `/v1/analytics/item-permutation-stats` (associations), `/v1/analytics/item-flow-stats` (ordre d'achat), `/v1/analytics/build-item-stats`, `/v1/analytics/hero-build-stats`, `/v1/builds` (builds publiés, recherche) et `/v1/assets/build-tags`, `/v1/patches` (notes de patch).
Plan : `GET /items/{itemId}/stats?period=&heroId=&rankTier=` (cache 30 min par jeu de filtres, dénominateurs publiés), `GET /heroes/{heroId}/builds` (builds publiés, cache 1 h), `GET /items/{itemId}/combos` ; mêmes conventions (`null` = inconnu, `meta`, `isPartial`).

## Profil joueur V2 : état de livraison (17/11/2026, réponse à `docs/design/player-profile-v2/02` et `05`)

| Demande                                                                                                                      | Statut                                    | Où                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| P0 `GET /players/{steamId}/overview`                                                                                         | **Livré (v1.9.0)**                        | Schéma `PlayerOverview`                                                             |
| P0 filtres de `GET /players/{steamId}/matches`                                                                               | **Livré (v1.9.0)**                        | `period`, `gameMode`, `matchMode`, `heroId`, `outcome` ; `MatchPage.appliedFilters` |
| P0 filtres et champs de `GET /players/{steamId}/heroes`                                                                      | **Livré (v1.9.0)**                        | `period`, `gameMode`, `matchMode` ; `PlayerHeroStat` étendu                         |
| P1 `/activity`, `/rank-history`, `PlayerRank` enrichi, tendances 20 vs 20, coéquipiers/adversaires, détail de partie enrichi | **Non fait** (proposé, à valider)         | Voir « P1 : propositions » plus bas                                                 |
| P2 catalogue Items/Builds                                                                                                    | **Non fait** (feuille de route seulement) | Voir « P2 : feuille de route »                                                      |

Etat Git : livré sur `main` du back (issue #79, SHA dans `git log`). Vérifié sur données réelles en local (FunKa, 107 parties sur 30 jours). En production après le prochain déploiement du back.

### Conventions communes aux trois routes

- Publiques, sans JWT. Erreurs habituelles : 400 `INVALID_INPUT` (enum, `heroId`, curseur), 404 `NOT_FOUND` (joueur inconnu), 429, 502, 503.
- `period` : `7d` et `30d` = fenêtre glissante **UTC** depuis l'instant de la requête (début inclus) ; `season` = depuis le début de la saison classée courante lu chez Deadlock API (`catalog.seasonStart()`, actuellement `2026-11-05T20:00:00Z`). Début de saison inconnu ou source en panne : **aucune borne appliquée**, `meta.isPartial: true` (et `coverage.notes: ["season_start_unknown"]` sur `/overview`).
- `gameMode` (`all`, `normal`, `street_brawl`) et `matchMode` (`all`, `ranked`, `unranked`) sont **deux axes indépendants** : `gameMode=normal` contient classées et non classées. Les autres valeurs (`sandbox`, `private_lobby`, `coop_bot`…) ne sont pas filtrables (400) mais apparaissent sous `all`.
- Partie au mode inconnu (`null`, copies anciennes) : retenue seulement sous `all` ; écartée d'un filtre précis.
- Seules les parties gagnées ou perdues sont comptées (abandons et pénalités exclus, comme en v1.8).
- Tout est calculé depuis l'historique en cache (`history:<accountId>`, 3 min) : changer de période ou de filtre ne relance **aucun** appel à Deadlock API (testé : 5 requêtes filtrées = 1 seul appel d'historique). Pas d'appel par partie.
- Inconnu = `null`, jamais 0 ; chaque ratio est publié avec la taille de son échantillon.

### `GET /api/players/{steamId}/overview?period=30d&gameMode=all&matchMode=all`

Défauts : `period=30d`, `gameMode=all`, `matchMode=all`. Identité et rang actuel restent dans `GET /players/{steamId}`.

Exemple réel (FunKa, `76561198009781660`, défauts, `topHeroes` tronqué à 1 entrée) :

```json
{
  "filters": {
    "period": "30d",
    "gameMode": "all",
    "matchMode": "all"
  },
  "summary": {
    "matches": 107,
    "wins": 60,
    "losses": 47,
    "winRate": 56.07,
    "kills": 1013,
    "deaths": 659,
    "assists": 1478,
    "kda": 3.78,
    "kdaSampleSize": 107,
    "avgNetWorthPerMinute": 1174.37,
    "netWorthPerMinuteSampleSize": 107,
    "avgDurationSeconds": 2294,
    "durationSampleSize": 107,
    "lastMatchAt": "2026-11-13T23:38:55.000Z"
  },
  "modes": [
    {
      "gameMode": "normal",
      "matchMode": "unranked",
      "matches": 95,
      "wins": 54,
      "losses": 41,
      "winRate": 56.84
    },
    {
      "gameMode": "normal",
      "matchMode": "ranked",
      "matches": 12,
      "wins": 6,
      "losses": 6,
      "winRate": 50
    }
  ],
  "topHeroes": [
    {
      "heroId": 81,
      "heroName": "Celeste",
      "heroImageUrl": "https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/unicorn_sm.webp",
      "matches": 33,
      "wins": 19,
      "losses": 14,
      "winRate": 57.58,
      "kda": 3.79,
      "kdaSampleSize": 33
    }
  ],
  "coverage": {
    "requestedFrom": "2026-10-18T12:06:18.000Z",
    "requestedTo": "2026-11-17T12:06:18.000Z",
    "observedFrom": "2026-10-18T17:15:00.000Z",
    "observedTo": "2026-11-13T23:38:55.000Z",
    "includedMatches": 107,
    "excludedUnknownMode": 0,
    "unknownModeMatches": 0,
    "isPartial": false,
    "notes": []
  },
  "meta": {
    "fetchedAt": "2026-11-16T15:37:33.817Z",
    "sourceUpdatedAt": null,
    "isStale": false,
    "isPartial": false
  }
}
```

- `summary.kills`, `deaths`, `assists`, `kda` : sur les seules parties où K, D **et** A sont connus (`kdaSampleSize`), `kda = (kills + assists) / max(deaths, 1)`, 2 décimales.
- `avgNetWorthPerMinute` : **moyenne des ratios par partie** `netWorth / (durationSeconds / 60)` (net worth connu, durée > 0), pas total / total.
- `avgDurationSeconds` : entier, parties de durée > 0.
- `modes` : combinaisons observées à modes connus, par volume décroissant. `somme(modes.matches) + coverage.unknownModeMatches = summary.matches`.
- `topHeroes` : 3 au plus, par volume puis `heroId`, avec nom et image du catalogue (repli `Héros #<id>`, `meta.isPartial`).
- `coverage.notes` : `season_start_unknown`, `unknown_mode_excluded`, `unknown_mode_included`, `history_stale`.
- Aucune partie : 200, compteurs à 0, ratios `null`, `modes: []`, `topHeroes: []`, `observedFrom/To: null`.

### `GET /api/players/{steamId}/matches` (filtres ajoutés)

- Nouveaux paramètres optionnels : `period`, `gameMode`, `matchMode`, `heroId` (entier > 0), `outcome` (`all`, `win`, `loss`). `limit` (1 à 50, défaut 20) et `cursor` inchangés.
- **Sans filtre : comportement v1.8 exact** (tout l'historique, mêmes curseurs). Pas de période par défaut : le front envoie `period=30d` s'il le souhaite.
- Avec filtres : sélection sur **tout** l'historique en cache, puis tri `playedAt` décroissant, `matchId` décroissant, puis pagination. 0 résultat : `items: []`, `nextCursor: null`.
- Le curseur est **lié aux filtres** : réutiliser `nextCursor` avec d'autres filtres (ou un curseur filtré sans filtre) donne 400 `INVALID_INPUT` (« curseur obtenu avec d'autres filtres, recommencer sans curseur »). Changer de filtre = repartir sans curseur. Les curseurs v1.8 restent valables sans filtre.
- Nouveau champ `appliedFilters` : `{ "period": "7d" | null, "gameMode": "all", "matchMode": "all", "heroId": null, "outcome": "all" }`.

### `GET /api/players/{steamId}/heroes` (filtres et champs ajoutés)

- Paramètres optionnels : `period`, `gameMode`, `matchMode` (sans filtre : tout l'historique, comme en v1.8).
- `PlayerHeroStat` gagne `losses`, `kdaSampleSize`, `avgNetWorthPerMinute`, `netWorthPerMinuteSampleSize` ; la réponse gagne `appliedFilters`. Les champs v1.8 gardent leurs valeurs.
- Note : `kda` y est désormais calculé sur le sous-ensemble complet (même règle que `/overview`). Identique à la v1.8 quand K, D et A sont connus, ce qui est toujours le cas avec la source actuelle.

### Décisions et limites

- Pas de cache des résultats calculés : l'agrégat d'un historique en cache prend quelques millisecondes ; cacher par combinaison de filtres n'apporterait rien.
- `GET /players/{steamId}` (profil v1.8) garde son ancien calcul des totaux K/D/A (chaque total sur ses valeurs connues), pour ne pas changer silencieusement son sens. Les nouvelles routes utilisent le sous-ensemble complet.
- `requestedTo` = instant de la requête : deux pages successives d'une période glissante sont calculées à quelques secondes d'écart (pas de doublon : le curseur est positionnel).
- La couverture ne prétend pas connaître « toutes les parties jamais jouées » : c'est l'historique que Deadlock API renvoie (complet en pratique, plusieurs milliers de parties pour les gros comptes).

### P1 : propositions (non faites, à valider)

- `GET /players/{id}/activity?weeks=12` : jours UTC, V/D par jour depuis l'historique en cache (même source, aucun appel en plus). Faisable vite.
- `GET /players/{id}/rank-history?period=` : points `{ at, badge, score }` sur les parties classées dont le badge est connu (`ranked_display_badge`, `score = tier*6 + subrank` comme pour les groupes), trous conservés, aucun MMR inventé.
- `PlayerRank` enrichi (calibration, dernière partie classée) via `/v1/players/{id}/rank`, déjà utilisé par le classement.
- Tendances 20 vs 20, coéquipiers/adversaires, détail de partie enrichi (items, dégâts) : à étudier sur la source avant tout contrat.

### P2 : feuille de route Items/Builds (non commencé)

Catalogue normalisé dans `api_cache` avec clé versionnée par version du jeu et langue (`english`), instantanés immuables par version et pointeur « dernière version », routes `/items`, `/items/{id}`, statistiques à TTL court par jeu de filtres, liens `itemId` des parties conservés avec leur version. Rien n'est implémenté.

### Coordination demandée au front

1. Recopier `docs/openapi.yaml` v1.9.0 dans `src/contracts/openapi.yaml` et remplacer les adaptateurs « mock de contrat proposé » par ces routes réelles.
2. Remettre le curseur à zéro à chaque changement de filtre de `/matches`.
3. Envoyer `period=30d` explicitement sur `/matches` et `/heroes` si l'écran l'attend (les défauts y restent « tout l'historique »).
4. Signaler dans le HANDOFF du front tout écart observé (forme, valeur, performance).

## Demandes au front (v1.7.0 et v1.8.0, 16/11/2026)

1. **Type de partie dans l'historique** (demande de LilStick) : `MatchSummary` (`GET /players/{steamId}/matches`) et `MatchDetail` (`GET /matches/{matchId}`) ont deux nouveaux champs :
   - `matchMode` : `unranked` (partie normale), `ranked` (classée), `private_lobby`, `coop_bot`, `hero_labs`, `tutorial`, `new_player_placement`, `server_test`, ou `null` ;
   - `gameMode` : `normal` (6 contre 6), `street_brawl`, `sandbox`, `1v1_test`, `explore_nyc`, ou `null`.

   Merci d'afficher une petite pastille par partie, par exemple « Classée », « Normale », « Street Brawl », « Lobby privé », « Contre bots », « Hero Labs » (`null` : rien ou « n/d »). Ordre de grandeur réel (FunKa) : 487 normales, 49 classées, 3 Street Brawl. Exemple : `{ "matchId": "136927164", ..., "matchMode": "unranked", "gameMode": "normal" }`.

2. **Rang dans le classement (v1.8.0)** : `LeaderboardEntry.badge` est rempli pour **95 entrées sur 100** (Europe), n°1 à n°3 compris (Eternus 5, 5, 3). Nouveau champ obligatoire **`inferred: boolean`** : `true` quand le pseudo correspond à plusieurs comptes Steam et que le back a retenu celui au rang le plus élevé (seul plausible en haut du classement). Dans ce cas, `steamId` est aussi renseigné (profil cliquable). Suggestion d'affichage : rang normal, avec une petite mention discrète (« compte déduit », par exemple au survol). Les 5 entrées restantes n'ont aucun compte dans la source (4) ou aucun candidat ayant joué en classé (1) : garder « Rang non communiqué ». Exemple : `{ "rank": 1, "displayName": "MikaelS", "steamId": "7656119...", "inferred": true, "badge": { "tier": 11, "subrank": 5, "name": "Eternus 5", "imageUrl": "..." }, "topHeroes": [...] }`.
3. **Nettoyer `docs/HANDOFF.md` du front**, plusieurs sections sont périmées :
   - « Décision à appliquer côté back : données de jeu en anglais » : fait (commit back `dfd5102`) ;
   - tableau « Ce que le front attend encore du back » : compare livré (`db4f09e`), anglais fait, routes P1 branchées ;
   - « Le front a recopié le contrat OpenAPI v1.3.0 » : contrat actuel **v1.8.0** ;
   - « Demande au back, prioritaire : héros manquants » : fait (issue #71, 44 héros, Violet et Baba inclus) ;
   - « Mise en route » : ajouter les URL de production.
4. Recopier `docs/openapi.yaml` v1.8.0 dans `src/contracts/openapi.yaml`.

## Fait : demande urgente au front (16/11/2026) : `VITE_API_BASE_URL` ignorée au build Coolify

**Symptôme en production** : `https://thebaroness.4esport.fr` ne parle pas au back. Le JavaScript déployé contient ``c=`/api` `` : le front appelle `https://thebaroness.4esport.fr/api/...`, nginx répond `index.html` (200 `text/html`) et le JSON échoue. Le back est sain : `https://api.thebaroness.4esport.fr/api/health` répond `{"status":"ok"}` et autorise l'origine `https://thebaroness.4esport.fr` en CORS.

**Cause** : dans Coolify v3.12, le secret `VITE_API_BASE_URL=https://api.thebaroness.4esport.fr/api` est bien déclaré « Need during buildtime », mais le `Dockerfile` du front redéclare l'argument **avec une valeur par défaut**, qui écrase celle fournie par Coolify :

```dockerfile
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
```

Un autre projet déployé sur la même instance Coolify (même mécanisme, `ARG` **sans** valeur par défaut) fonctionne.

**Correctif demandé** (étape 1 du `Dockerfile`, à la place des deux lignes ci-dessus) :

```dockerfile
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL:-/api}
```

`:-/api` garde le comportement actuel pour un build local sans argument (sans lui, la valeur serait vide et les appels partiraient vers `/auth/me` au lieu de `/api/auth/me`). Vérification locale : `docker build --build-arg VITE_API_BASE_URL=https://api.thebaroness.4esport.fr/api .` puis chercher cette URL dans `dist/assets/client-*.js`.

Après le push, LilStick lance un **Force Redeploy** du front dans Coolify ; le back vérifie ensuite le bundle en ligne.

Facultatif, non bloquant : en-têtes de sécurité dans `nginx.conf` (`Content-Security-Policy` avec `connect-src 'self' https://api.thebaroness.4esport.fr`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`).

## Demande au front (16/11/2026) : ajout de joueurs sans taper de SteamID64

Retour de l'utilisateur : pour créer un groupe (et suivre un joueur), il faut saisir un SteamID64 de 17 chiffres, que personne ne connaît par cœur.

1. **Back, déjà livré (v1.5.0, issue #55)** : `POST /api/tracked-players` (`steamId`) et `POST`/`PATCH /api/groups` (`steamIds[]`) acceptent désormais aussi :
   - le code ami Steam ou Deadlock (account ID 32 bits, par exemple `997050782`) ;
   - le format `[U:1:997050782]` ;
   - l'URL `https://steamcommunity.com/profiles/76561198957316510` (avec ou sans `www`, schéma, slash final ou query).

   Le back normalise en SteamID64 avant validation et stockage ; les réponses ne renvoient que des SteamID64. Les doublons sont détectés après normalisation (code ami + SteamID64 du même joueur → 400 dans un groupe, 409 en suivi). Les URL personnalisées `/id/<pseudo>` restent refusées (400) : il faudrait la Web API Steam avec une clé.

2. **Demande au front** :
   - Dans le formulaire de groupe (et l'ajout d'un joueur suivi), proposer l'ajout d'un membre **par recherche de pseudo** en réutilisant `GET /api/players/search?q=` (renvoie `steamId`, `displayName`, `avatarUrl`), avec puce avatar + pseudo pour chaque membre choisi ;
   - Garder un champ de saisie libre en repli, en relâchant la validation côté front : ne plus imposer `^\d{17}$`, laisser le back valider et afficher le message de l'erreur 400 `INVALID_INPUT` ;
   - Libellé d'aide suggéré : « Pseudo, code ami, SteamID64 ou lien de profil Steam ».
   - Recopier `docs/openapi.yaml` v1.5.0 dans `src/contracts/openapi.yaml` (nouveau schéma de saisie : `GroupInput.steamIds.items` et `TrackedPlayerCreate.steamId`).

## Demande au front (16/11/2026) : bouton « Actualiser »

1. **Back, déjà livré (v1.6.0, issue #57)** :
   - `POST /api/players/:steamId/refresh` (public, sans corps) : relit profil Steam et historique auprès de Deadlock API, renvoie **exactement la même forme** que `GET /api/players/:steamId`.
   - `POST /api/groups/:id/refresh?period=7d|30d|season` (JWT, sans corps) : relit tous les membres, renvoie **la même forme** que `GET /api/groups/:id/compare` ; mêmes erreurs (400, 401, 404, 503).
   - Délai minimum de **60 s par joueur**, partagé entre tous les utilisateurs : pendant ce délai la copie actuelle est renvoyée (200) sans appel au fournisseur. Fournisseur en panne : copie précédente avec `meta.isStale: true`.
2. **Demande au front** :
   - Bouton « Actualiser » sur la page profil et sur la comparaison de groupe, qui appelle la route `refresh` et remplace les données affichées par la réponse (puis invalide le cache de requêtes de `/matches` et `/heroes` du joueur pour les relire) ;
   - Afficher la date de la donnée : `meta.fetchedAt` (« mis à jour il y a 2 min ») et un indicateur si `meta.isStale` ;
   - Désactiver le bouton pendant la requête et environ 60 s après (le back renverrait de toute façon la même copie).
   - Facultatif : rafraîchissement automatique (`refetchInterval` de 2 à 3 min, et au retour sur l'onglet) sur ces deux pages, via les routes `GET` habituelles.

## Worker de préchauffage (16/11/2026, issue #58)

- Toutes les 5 min (`REFRESH_INTERVAL_MS`, minimum 60 000), le back actualise le cache (profil Steam et historique) de **tous les joueurs suivis et membres de groupes**, tous comptes confondus, 2 à la fois. Une copie encore fraîche ne coûte aucun appel ; le cycle s'arrête si Deadlock API est limitée ou en panne.
- Effet pour le front : profils et comparaisons de ces joueurs s'ouvrent sans attendre Deadlock API, avec des données de moins de 5 min environ. Aucune route ni forme modifiée.
- Variables : `REFRESH_WORKER_ENABLED=true|false` (actif par défaut), `REFRESH_INTERVAL_MS=300000`. Voir `.env.example`.

## Déploiement Coolify (16/11/2026, issue #61)

- **Back en production : `https://api.thebaroness.4esport.fr`** (Swagger : `/api/docs`). Vérifié : toutes les routes, redirection Steam, CORS pour `https://thebaroness.4esport.fr`, HTTPS Let's Encrypt.
- **Front à déployer sur `https://thebaroness.4esport.fr`**, build avec `VITE_API_BASE_URL=https://api.thebaroness.4esport.fr/api`.

- Un conteneur par service : `mongodb`, `api`, `worker` (même image, `node dist/worker.js`) côté back via `compose.prod.yaml` ; le front en application Dockerfile séparée (son `Dockerfile` nginx actuel convient tel quel).
- Deux domaines : `https://<domaine>` (front) et `https://api.<domaine>` (back). Le front se build avec `VITE_API_BASE_URL=https://api.<domaine>/api` ; le back autorise l'origine du front (`CORS_ORIGIN`). Guide complet : `docs/DEPLOY.md`.
- Rien à changer dans le code du front. A noter : `nginx.conf` n'a pas de `location /api`, ce qui est normal avec deux domaines.
- En local, `docker compose up --build -d` lance désormais aussi le conteneur `worker`.

## Etat des routes

| Route                                                                                                                                         | Etat                      | Note                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| health, Steam (`/auth/steam`, callback, `/auth/me`), `players/search`, `players/:steamId`, `players/:steamId/matches`, CRUD `tracked-players` | TESTEE                    | Branché par le front                                                                                                     |
| `GET /api/heroes`, `GET /api/heroes/:heroId`, `GET /api/ranks`, `GET /api/map`                                                                | TESTEE                    | Vérifié contre la vraie API                                                                                              |
| `rank` détaillé dans le profil, `heroImageUrl` dans les parties                                                                               | TESTEE                    | Exemple réel : `{ "badgeId": 113, "name": "Eternus 3", "tier": 11, "subrank": 3, ... }`                                  |
| `heroes/:heroId/stats`, `leaderboard`, `matches/:matchId`, `players/:steamId/heroes`                                                          | TESTEE (commit `4cd9b73`) | Vérifié contre la vraie API                                                                                              |
| CRUD `/api/groups`                                                                                                                            | TESTEE                    | Désormais documenté dans l'OpenAPI (v1.4.0)                                                                              |
| `GET /api/groups/:id/compare?period=7d\|30d\|season`                                                                                          | TESTEE (commit `db4f09e`) | Vérifié contre la vraie API, voir ci-dessous                                                                             |
| Données de jeu en anglais                                                                                                                     | FAIT (commit `dfd5102`)   | Plus de `language=french` ; rangs `Obscurus` à `Eternus` ; stats `Health`, `Stamina`… comme `scripts/build-fixtures.mjs` |

## Comparaison de groupe : ce que le back renvoie

- Sources : profil et historique de chaque membre (cache partagé avec les profils), aucune collection supplémentaire.
- `period` : `7d` et `30d` glissants ; `season` = depuis le début de la saison classée courante (saison 2, 04/11/2026), toutes les parties si elle est inconnue.
- `rank` : dernier badge classé connu, même hors période ; `null` si le joueur n'a aucune partie classée.
- `rankHistory` : un point par partie classée de la période, du plus ancien au plus récent, `score = tier * 6 + subrank` (1 à 72). Un joueur très actif peut avoir plusieurs centaines de points sur la saison : prévoir un échantillonnage côté graphique si besoin.
- `bestMatch` : KDA `(K + A) / max(D, 1)` maximal, la plus récente à égalité ; `null` sans partie complète.
- Membre indisponible : omis, `meta.isPartial = true` (et `meta.isStale = true` si une copie en cache a été servie). Tous indisponibles : 503 `SERVICE_UNAVAILABLE`.
- Ordre des contrôles : id malformé 400, groupe absent ou d'un autre compte 404, `period` invalide 400.

Exemple réel (groupe de 2 joueurs, 7 jours) : `Eternus 3`, 59 parties, 69,49 % de victoires, KDA 4,35, série de 13, meilleure partie Billy KDA 34, 35 points d'historique de rang.

## Décisions et écarts (tous validés par le front, HANDOFF front `d90fce9`)

| Sujet                      | Décision                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Echelle du score de rang   | `tier * 6 + subrank`, maximum 72                                                                                                                                                        |
| Formule du KDA             | Partout `(K + A) / max(D, 1)`, 2 décimales, `null` si une valeur manque                                                                                                                 |
| Classement                 | `badge: null` (la source ne fournit pas le rang par joueur) ; `steamId` seulement si `possible_account_ids` est univoque ; 100 premiers ; ex aequo possibles ; `topHeroes` souvent vide |
| Détail de partie           | Team 0 = `amber`, team 1 = `sapphire` ; `displayName` = pseudo Steam, sinon SteamID, sinon `Joueur inconnu` ; `playedAt` et `winningSide` nullables                                     |
| Stats méta d'un héros      | 30 derniers jours, `winRate` d'un palier `null` sous 200 parties, `pickRate` = parties du héros / parties totales                                                                       |
| Validation                 | 400 pour `period`, `region`, `matchId`, `heroId`, `steamId` invalides                                                                                                                   |
| `region` du classement     | `Europe` par défaut                                                                                                                                                                     |
| Ordre de `GET /api/groups` | `updatedAt` décroissant                                                                                                                                                                 |
| Données de jeu             | Anglais (héros, capacités, lore, rôles, rangs, libellés de stats)                                                                                                                       |

## Mise en route front + back

```bash
# back
cp .env.example .env    # JWT_SECRET >= 32 caractères ; le reste est déjà bon pour le dev local
docker compose up --build -d
curl http://localhost:3001/api/health   # {"status":"ok"}
# front
npm run dev             # proxy Vite /api vers http://localhost:3001
```

Les routes catalogue et joueurs interrogent la vraie API Deadlock : prévoir une connexion internet. En cas de limitation par la source, les réponses passent en `isStale` ou `isPartial`, ou en 503 avec `Retry-After`.

## Journal des changements de contrat (du plus récent au plus ancien)

- 17/11/2026 : **v1.10.0** (P1) : `/players/{steamId}/rank-history`, `/activity`, `/relationships`, `/items`, `/items/{itemId}` ; `MatchPlayer` (`mvpRank`, `killParticipation`, `stats`, `purchases`, `finalItemIds`, `abilityUpgrades`) et `teams[].averageBadge`, `averageRankName`. Correction : parties anciennes (`outcome` 0) incluses dans l'historique. Additif pour les formes.

- 17/11/2026 : **v1.9.0** (profil V2, P0) : `GET /players/{steamId}/overview` ; filtres `period`, `gameMode`, `matchMode`, `heroId`, `outcome` sur `/matches` (curseur lié aux filtres, `appliedFilters`) ; filtres et champs `losses`, `kdaSampleSize`, `avgNetWorthPerMinute`, `netWorthPerMinuteSampleSize` sur `/heroes`. Additif.

- 16/11/2026 : classement, repli sur l'historique quand la dernière partie classée n'a pas de rang (95/100). Forme inchangée (v1.8.0).

- 16/11/2026 : **v1.8.0** : `LeaderboardEntry.inferred` (nouveau, obligatoire) ; `steamId` et `badge` résolus aussi pour les pseudos homonymes (94/100 rangs en Europe).

- 16/11/2026 : **v1.7.0** : `matchMode` et `gameMode` dans `MatchSummary` et `MatchDetail` ; `LeaderboardEntry.badge` rempli pour les comptes univoques. Ajouts rétrocompatibles.

- 16/11/2026 : héros récents inclus (issue #71) : `in_development` n'exclut plus un héros publié ; Violet (86) et Baba (88) apparaissent, 44 héros. Cache du catalogue invalidé au déploiement. Forme inchangée.

- 16/11/2026 : déploiement (issue #61) : conteneur `worker` séparé (`dist/worker.js`), `compose.prod.yaml` pour Coolify, `docs/DEPLOY.md`. Contrat HTTP inchangé.

- 16/11/2026 : worker de préchauffage (issue #58), nouvelles variables `REFRESH_WORKER_ENABLED` et `REFRESH_INTERVAL_MS`. Contrat HTTP inchangé (v1.6.0).

- 16/11/2026 : **v1.6.0** (issue #57) : `POST /players/{steamId}/refresh` et `POST /groups/{id}/refresh` (refresh forcé, délai minimum de 60 s par joueur). Rétrocompatible.

- 16/11/2026 : **v1.5.0** (issue #55) : saisie de joueur élargie (code ami, `[U:1:n]`, URL de profil) dans les corps de `tracked-players` et `groups`, normalisée en SteamID64. Réponses inchangées. Rétrocompatible.

- 16/11/2026 : **v1.4.1** (commit `dfd5102`) : données de jeu en anglais (exemples `Eternus 3`). Aucune forme modifiée.
- 16/11/2026 : **v1.4.0** (commit `db4f09e`) : `GET /groups/:id/compare` ; CRUD `/groups` documenté (schémas `Group`, `GroupInput`, `GroupCompare`).
- 16/11/2026 : **v1.3.0** (commit `4cd9b73`) : `/heroes/:heroId/stats`, `/leaderboard`, `/matches/:matchId`, `/players/:steamId/heroes` ; `LeaderboardEntry.badge` nullable ; `MatchDetail.playedAt` et `winningSide` nullables.
- 16/11/2026 : **v1.2.0** (commit `2800e54`) : `/heroes`, `/heroes/:heroId`, `/ranks`, `/map` ; `PlayerRank` complet ; `MatchSummary.heroImageUrl`.
- 16/11/2026 : CRUD `/api/groups`.
- 16/11/2026 : v1.1.0 : Steam OpenID, `PublicUser`, `player.region`, CORS.
- 16/11/2026 : v1.0.0 : routes P0 du cahier.

## Questions ouvertes

- Images Valve (portraits, rangs, carte) : validation de l'usage par l'encadrant toujours à faire pour la remise (cahier, section 22). Rien à changer côté back.
- Demandes ci-dessus : ajout de membres par recherche de pseudo ; bouton « Actualiser » et date de la donnée.
