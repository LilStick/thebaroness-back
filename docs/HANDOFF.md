# HANDOFF : back vers front

Fichier de liaison entre le Claude du back (`thebaroness-back`) et celui du front (`thebaroness`).
Le Claude du front le lit après un `pull` du back. Pendant côté front : `thebaroness/docs/HANDOFF.md`, lu par le back à chaque session.

Dernière mise à jour : 16/11/2026 (voir `git log -- docs/HANDOFF.md` pour le SHA). HANDOFF front relu au commit `d90fce9`.

## A lire en premier

- **Tout ce que le front attend est livré et testé.** Contrat de référence : `docs/openapi.yaml` **v1.4.1** (aussi sur `http://localhost:3001/api/docs`). A recopier dans `src/contracts/openapi.yaml`.
- Dépôt GitHub `LilStick/thebaroness-back` (l'ancienne URL `deadlock-tracker-back` redirige ; le nom du dossier local n'a pas d'importance).

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

- 16/11/2026 : **v1.4.1** (commit `dfd5102`) : données de jeu en anglais (exemples `Eternus 3`). Aucune forme modifiée.
- 16/11/2026 : **v1.4.0** (commit `db4f09e`) : `GET /groups/:id/compare` ; CRUD `/groups` documenté (schémas `Group`, `GroupInput`, `GroupCompare`).
- 16/11/2026 : **v1.3.0** (commit `4cd9b73`) : `/heroes/:heroId/stats`, `/leaderboard`, `/matches/:matchId`, `/players/:steamId/heroes` ; `LeaderboardEntry.badge` nullable ; `MatchDetail.playedAt` et `winningSide` nullables.
- 16/11/2026 : **v1.2.0** (commit `2800e54`) : `/heroes`, `/heroes/:heroId`, `/ranks`, `/map` ; `PlayerRank` complet ; `MatchSummary.heroImageUrl`.
- 16/11/2026 : CRUD `/api/groups`.
- 16/11/2026 : v1.1.0 : Steam OpenID, `PublicUser`, `player.region`, CORS.
- 16/11/2026 : v1.0.0 : routes P0 du cahier.

## Questions ouvertes

- Images Valve (portraits, rangs, carte) : validation de l'usage par l'encadrant toujours à faire pour la remise (cahier, section 22). Rien à changer côté back.
- Aucune autre question du back.
