# Enquête : chute simultanée des rangs (19/11/2026)

## Signalement

Le front a relevé (18/11, back local v1.14.0) que la courbe `rankHistory` de 6 joueurs Eternus chutait au même moment vers Phantom avant de remonter. La cause n'était pas confirmée.

## Méthode

Je suis parti des données brutes de la source, `/v1/players/{id}/match-history`, sur :

- 13 joueurs Eternus du top 12 Europe (plus MikaelS) ;
- 21 joueurs de deux parties classées (une de niveau Arcanist, une de niveau Eternus).

Soit 34 joueurs au total.

Champs examinés :

- `ranked_display_badge` ;
- `ranked_delta` ;
- `ranked_calibration_match` ;
- `ranked_used_demotion_protection` ;
- `player_match_outcome` ;
- `match_mode` et `game_mode`.

J'ai ensuite croisé ces données avec `/v1/assets/ranked-seasons`.

## Constats

1. **Le changement est simultané.** Chez tous les joueurs, la dernière partie classée à l'ancien barème date du 05/11/2026 à 19:18 UTC, et la première chute du 05/11 à 20:26 UTC. Chaque joueur bascule à sa première partie classée après cette frontière.
2. **Il ne dépend pas du résultat.** Les chutes surviennent aussi sur des victoires : `ranked_delta` est positif (+350) alors que le badge baisse.
3. **L'échelle est recompressée vers le centre, sur 34 joueurs.**
   - Eternus 1 à 6 (111 à 116) devient Phantom 1 à 4 ou Oracle 6 (96 à 104) : −4 à −11 sous-rangs.
   - Arcanist 4 à 6 (24 à 26) devient Ritualist 6 ou Emissary 1 à 3 (36 à 43) : +7 à +10 sous-rangs.
4. **Le barème change en même temps.** L'amplitude de `ranked_delta` passe de 300 à 350.
5. **Ce n'est pas une calibration.** `ranked_calibration_match` vaut 0 sur toutes ces parties.
6. **La source décrit ce changement.** `/v1/assets/ranked-seasons` contient :
   - Beta Season 1 : du 30/07/2026 17:00 au **05/11/2026 20:00 UTC**, `base_win_loss_point_grant` 300 ;
   - Beta Season 2 : du **05/11/2026 20:00 UTC** au 11/03/2027 22:00, `base_win_loss_point_grant` 350, autres seuils de rang.

## Conclusion

Il s'agit d'un **changement de saison classée**, avec recompression des badges par la source. Ce n'est ni un bug du back (conversion `tier*6+subrank` correcte), ni une calibration, ni une remise à zéro.

Les badges de deux saisons ne sont pas comparables. Relier par une même courbe des points de part et d'autre de la frontière, ou soustraire leurs scores, produit une fausse progression.

## Correctif (v1.15.0)

- **Saisons de la source.** Les saisons viennent de `/v1/assets/ranked-seasons` (`catalog.rankedSeasons()`, cache 24 h). Aucune date n'est codée en dur.
- **Points annotés.**
  - `/players/{id}/rank-history` : `points[].season`, `seasons[]`, et les notes `spans_multiple_seasons` et `season_boundaries_unknown`.
  - `/groups/{id}/compare` : `rankHistory[].season`, `methodology.seasons`, `methodology.seasonBoundariesKnown`.
- **`rankDelta`.** Il porte sur les points de la même saison que le dernier point (`methodology.rankDeltaScope = latest_season_in_period`). Le highlight `biggest_climb` en découle.
- **Saisons indisponibles.** `season` vaut null, le calcul est l'ancien, et c'est signalé.
- **Aucun marqueur `rankReset`.** Le changement est décrit par les frontières de saison que publie la source, pas par une détection heuristique.

`period=season` n'était pas touché : il commence au début de la saison en cours. Seuls `7d` et `30d` chevauchaient la frontière.

Front : couper la courbe à chaque changement de `season`, au lieu de relier les points.
