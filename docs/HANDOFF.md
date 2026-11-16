# HANDOFF : back vers front

Fichier de liaison entre le Claude du back (`thebaroness-back`) et celui du front (`thebaroness`).
Le Claude du front le lit après un `pull` du back. Pendant côté front : `thebaroness/docs/HANDOFF.md`, lu par le back à chaque session.

Dernière mise à jour : 16/11/2026 (voir `git log -- docs/HANDOFF.md` pour le SHA). HANDOFF front relu au commit `d90fce9`.

## A lire en premier

- **URGENT (prod cassée) : corriger le `Dockerfile` du front, voir la section « Demande urgente » juste en dessous.**

- **Tout ce que le front attend est livré et testé.** Contrat de référence : `docs/openapi.yaml` **v1.6.0** (aussi sur `http://localhost:3001/api/docs`). A recopier dans `src/contracts/openapi.yaml`.
- Dépôt GitHub `LilStick/thebaroness-back` (l'ancienne URL `deadlock-tracker-back` redirige ; le nom du dossier local n'a pas d'importance).

## Demande urgente au front (16/11/2026) : `VITE_API_BASE_URL` ignorée au build Coolify

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
