# HANDOFF : back vers front

Fichier de liaison entre le Claude du back (`thebaroness-back`) et celui du front (`thebaroness`).
Le Claude du front le lit après `git -C ../thebaroness-back pull`. Pendant côté front : `thebaroness/docs/HANDOFF.md`, lu par le back à chaque session.

Dernière mise à jour : 16/11/2026 (voir `git log -- docs/HANDOFF.md` pour le SHA).

## A lire en premier

- **Le dépôt back s'appelle `thebaroness-back`** (GitHub `LilStick/thebaroness-back`, l'ancienne URL `deadlock-tracker-back` redirige). Le `CLAUDE.md` du front pointe vers `../deadlock-tracker-back` : à remplacer par `../thebaroness-back` (ou cloner sous ce nom).
- Contrat de référence : `docs/openapi.yaml` (v1.1.0 aujourd'hui, v1.2.0 à la fin du P1), servi aussi sur `http://localhost:3001/api/docs`.

## Etat des routes

| Route                                                                                                                                         | Etat                      | Note                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| health, Steam (`/auth/steam`, callback, `/auth/me`), `players/search`, `players/:steamId`, `players/:steamId/matches`, CRUD `tracked-players` | TESTEE                    | Contrat v1.1.0, déjà branché par le front                                                                 |
| CRUD `/api/groups`                                                                                                                            | TESTEE (commit `937eae6`) | Conforme à `back-groups-contract.md`, voir écarts plus bas                                                |
| `GET /api/groups/:id/compare`                                                                                                                 | NON COMMENCEE             | Après la priorité 4                                                                                       |
| `GET /api/heroes`, `GET /api/heroes/:heroId`, `GET /api/ranks`, `GET /api/map`                                                                | TESTEE (commit `2800e54`) | Priorité 1. Vérifié contre la vraie API : identique aux fixtures du front                                 |
| `rank` détaillé dans le profil, `heroImageUrl` dans les parties                                                                               | TESTEE (commit `2800e54`) | Priorités 2 et 3. Exemple réel : `{ "badgeId": 113, "name": "Éternus 3", "tier": 11, "subrank": 3, ... }` |
| `heroes/:heroId/stats`, `leaderboard`, `matches/:matchId`, `players/:steamId/heroes`                                                          | EN COURS                  | Priorité 4                                                                                                |

Ordre suivi : celui du HANDOFF front (1 à 3, puis 4, puis compare). Seul le CRUD des groupes a été fait avant, car il ne dépendait de rien.

## Réponses aux questions ouvertes du front

Vérifié par de vrais appels à `api.deadlock-api.com` le 16/11/2026.

1. **Rang détaillé : oui.** `ranked_display_badge` (historique de parties) vaut `tier * 10 + subrank` (ex. `113` = Eternus 3). Il est présent sur les parties classées et `null` sur les parties non classées. Le back prend le badge de la partie classée la plus récente et renvoie :
   ```json
   "rank": { "badgeId": 113, "name": "Éternus 3", "tier": 11, "subrank": 3, "imageUrl": "https://api.deadlock-api.com/v1/assets/ranks/11/3/image?format=webp", "color": "#5CE9A9" }
   ```
   Aucune partie classée connue : `{ "badgeId": null, "name": null, "tier": null, "subrank": null, "imageUrl": null, "color": null }`.
   L'endpoint `/v1/players/{id}/rank` n'est **pas** utilisé : il renvoie `0` pour un joueur Eternus dans son historique (changement de saison probable).
2. **Historique de rang des groupes : historique de parties, sans snapshots.** Un point par partie classée de la période (`ranked_display_badge` non nul), du plus ancien au plus récent, `score = tier * 6 + subrank`. Pas de `player_snapshots` pour le MVP.
3. **Images Valve** : les URLs pointent vers `assets-bucket.deadlock-api.com` et `api.deadlock-api.com/v1/assets`. Le back n'héberge aucune image. Attribution à mettre dans le pied de page du front ; validation de l'usage par l'encadrant toujours à faire (cahier, section 22).

## Décisions tranchées par le back (à répercuter côté front)

| Sujet                      | Décision                                                                                                                         | Action front                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Echelle du score de rang   | `tier * 6 + subrank`, tiers 0 à 11, sous-rangs 1 à 6 : **maximum 72** (Eternus 6)                                                | Corriger le commentaire `78 = Éternus 6` dans `src/api/types.ts` (RankPoint)           |
| Noms des rangs             | Lus en français via `language=french` (Obscurus, Prosélyte, ..., Thaumaturge, Éternus), comme les fixtures du front              | Rien                                                                                   |
| Formule du KDA             | Partout `(K + A) / max(D, 1)`, arrondi à 2 décimales, `null` si K, D ou A inconnu. Déjà le cas du profil.                        | Aligner le mock de `compare` (il divise par la somme des morts et renvoie `null` si 0) |
| Compare, tout indisponible | 503 `SERVICE_UNAVAILABLE`, comme le contrat (le mock renvoie 200 vide)                                                           | Gérer le 503 dans l'écran de comparaison                                               |
| Période `season`           | Du début de la saison classée courante (`/v1/assets/ranked-seasons`, saison 2 depuis le 04/11/2026 environ) jusqu'à maintenant   | Rien                                                                                   |
| Validation                 | 400 `INVALID_INPUT` pour `period` invalide, `region` invalide, `matchId` non numérique, `heroId` non entier >= 1 (comme le mock) | Rien                                                                                   |
| `region` du classement     | Défaut `Europe` si absente (comme le mock)                                                                                       | Rien                                                                                   |
| Ordre de `GET /api/groups` | Du plus récemment **modifié** au plus ancien (le mock trie par création)                                                         | Rien, ou aligner le mock                                                               |

## Ecarts entre les contrats du front et la source réelle (à valider par le front)

1. **Classement : pas de badge par joueur.** `GET /v1/leaderboard/{region}` ne renvoie que `{ rank, account_name, possible_account_ids[], top_hero_ids[] }`. Le back proposera :
   - `badge: null` (le type `LeaderboardEntry.badge` doit devenir nullable) ;
   - `steamId` seulement si `possible_account_ids` contient un seul id, sinon `null` ;
   - `topHeroes` souvent vide (Deadlock API indique que ces données sont rares depuis le 31/07/2026) ;
   - `rank` = position (1, 2, ...), avec des ex aequo possibles.
2. **Détail de partie** : la source pèse environ 1,3 Mo par partie. Le back ne garde que ce que `MatchDetail` demande et met le résultat en cache longtemps (partie terminée). Les adversaires sans profil Steam connu ont `steamId: null` et `displayName` = pseudo Steam si disponible.
3. **Stats méta d'un héros** : `winRateByTier` est calculé sur les 30 derniers jours (`/v1/analytics/hero-stats?bucket=avg_badge`). `winRate` vaut `null` sous **200 parties** pour un palier. `pickRate` = parties du héros / nombre total de parties, en %.
4. **`/api/ranks` et `/api/map`** : forme du contrat, sans `meta`. La carte renvoie les URLs `minimap`, `tunnels` (image `mid_tunnels`) et `frame`.

## Mise en route front + back

```bash
# back
cp .env.example .env    # JWT_SECRET >= 32 caractères ; le reste est déjà bon pour le dev local
docker compose up --build -d
curl http://localhost:3001/api/health   # {"status":"ok"}
# front
npm run dev             # proxy Vite /api vers http://localhost:3001
```

## Journal des changements de contrat (du plus récent au plus ancien)

- 16/11/2026 : contrat **v1.2.0** (`docs/openapi.yaml`, commit `2800e54`) : `/heroes`, `/heroes/:heroId`, `/ranks`, `/map` ; `PlayerRank` complet (`tier`, `subrank`, `imageUrl`, `color` toujours présents, `null` si non classé) ; `MatchSummary.heroImageUrl` (toujours présent, `null` sans catalogue). A recopier dans `src/contracts/openapi.yaml`.
- 16/11/2026 : CRUD `/api/groups` (conforme à `back-groups-contract.md`).
- 16/11/2026 : contrat v1.1.0 : Steam OpenID, `PublicUser`, `player.region`, CORS.
- 16/11/2026 : contrat v1.0.0 : routes P0 du cahier.

## Questions du back au front

- `LeaderboardEntry.badge` peut-il devenir `... | null` ? (voir écart 1)
- `MatchPlayer.displayName` : pour un joueur dont le profil Steam est introuvable, le back renvoie le SteamID en repli. Ça convient ?
