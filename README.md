# thebaroness-back

[![CI](https://github.com/LilStick/thebaroness-back/actions/workflows/ci.yml/badge.svg)](https://github.com/LilStick/thebaroness-back/actions/workflows/ci.yml)

API du projet **thebaroness**, un tracker de statistiques Deadlock (EFREI M1 Full Stack JS).
Node.js 24 · Express 5 · TypeScript · MongoDB/Mongoose · Zod · JWT · Steam OpenID · Jest/Supertest · Docker.

Le frontend React vit dans un dépôt séparé : [`luminescencedev/thebaroness`](https://github.com/luminescencedev/thebaroness).

- Contrat HTTP : [`docs/openapi.yaml`](docs/openapi.yaml), et Swagger UI sur `http://localhost:3001/api/docs`
- Connexion Steam côté front : [`docs/FRONT_STEAM_AUTH.md`](docs/FRONT_STEAM_AUTH.md)

---

## Démarrage rapide (Docker)

Déploiement en production (Coolify, un conteneur par service) : voir [`docs/DEPLOY.md`](docs/DEPLOY.md).

Prérequis : Docker avec Compose v2.

```bash
git clone https://github.com/LilStick/thebaroness-back.git
cd thebaroness-back
cp .env.example .env
# Remplacer JWT_SECRET dans .env, par exemple par la sortie de : openssl rand -hex 32
docker compose up --build -d
curl http://localhost:3001/api/health        # {"status":"ok"}
```

| Commande                       | Effet                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `docker compose up --build -d` | Construit et démarre MongoDB, l'API et le worker de préchauffage (ils attendent que Mongo soit _healthy_) |
| `docker compose logs -f api`   | Journal JSON de l'API                                                                                     |
| `docker compose down`          | Arrête les conteneurs, **les données sont conservées** (volume `mongo-data`)                              |
| `docker compose down -v`       | ⚠️ Arrête **et supprime définitivement la base** (volume `mongo-data`)                                    |

MongoDB n'est joignable que par l'API (réseau interne `mongodb:27017`) et, pour la maintenance, sur `127.0.0.1:27017`.

## Développement local (sans Docker pour l'API)

Prérequis : Node.js 24 (`.nvmrc`) et un MongoDB local. Le plus simple : `docker compose up -d mongodb`.

```bash
npm install
cp .env.example .env      # puis renseigner JWT_SECRET
npm run dev               # http://localhost:3001, rechargement automatique
```

Avec le front : `npm run dev` dans les deux dépôts. Le proxy Vite du front relaie `/api` vers `http://localhost:3001`.

### Scripts

| Script                  | Rôle                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `npm run dev`           | Serveur en mode watch (tsx)                                       |
| `npm run build`         | Compilation TypeScript vers `dist/`                               |
| `npm start`             | Lance `dist/index.js`                                             |
| `npm run lint`          | ESLint                                                            |
| `npm run typecheck`     | Vérification des types (code, tests, scripts)                     |
| `npm test`              | Jest + Supertest (MongoDB en mémoire, aucun appel réseau externe) |
| `npm run test:coverage` | Tests avec couverture (seuils : 95 % lignes, 85 % branches)       |
| `npm run openapi`       | Régénère `docs/openapi.yaml` depuis `src/docs/openapi.ts`         |
| `npm run openapi:check` | Valide le contrat OpenAPI 3.1 et sa synchronisation               |

### Variables d'environnement

Toutes sont validées au démarrage par Zod : une configuration invalide empêche le serveur de démarrer, avec un message lisible qui n'affiche aucune valeur. Valeurs d'exemple : [`.env.example`](.env.example).

| Variable                | Défaut                         | Rôle                                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `NODE_ENV`              | `development`                  | `development`, `test` ou `production`                              |
| `PORT`                  | `3001`                         | Port HTTP                                                          |
| `MONGODB_URI`           | **requis**                     | URI MongoDB (Compose : `mongodb://mongodb:27017/thebaroness`)      |
| `JWT_SECRET`            | **requis**                     | Clé HS256, 32 caractères minimum                                   |
| `JWT_EXPIRES_IN`        | `15m`                          | Durée du jeton (`1h` conseillé en dev : pas de refresh)            |
| `API_PUBLIC_URL`        | `http://localhost:3001`        | URL publique de l'API : realm et `return_to` Steam OpenID          |
| `FRONT_URL`             | `http://localhost:5173`        | Redirection finale vers `<FRONT_URL>/auth/callback`                |
| `CORS_ORIGIN`           | `http://localhost:5173`        | Origines autorisées, séparées par des virgules                     |
| `AUTH_RATE_LIMIT`       | `60`                           | Requêtes `/api/auth/*` par IP et par 15 min                        |
| `API_RATE_LIMIT`        | `300`                          | Requêtes `/api/*` par IP et par minute                             |
| `TRUST_PROXY`           | `0`                            | Nombre de proxys inverses devant l'API (1 derrière nginx)          |
| `DEADLOCK_API_BASE_URL` | `https://api.deadlock-api.com` | Fournisseur de statistiques                                        |
| `DEADLOCK_API_KEY`      | _(vide)_                       | Clé facultative (quotas plus élevés), jamais exposée au navigateur |
| `LOG_LEVEL`             | `info`                         | Niveau de journalisation pino                                      |

---

## API

Base `/api`, JSON UTF-8. Toutes les erreurs ont la forme `{ "error": { "code", "message" } }`. Une valeur inconnue vaut `null`, jamais `0`. Le détail complet est dans [`docs/openapi.yaml`](docs/openapi.yaml).

| Méthode  | Route                                                 | Accès  | Statut                               |
| -------- | ----------------------------------------------------- | ------ | ------------------------------------ |
| `GET`    | `/api/health`                                         | Public | **TESTÉE**                           |
| `GET`    | `/api/auth/steam`                                     | Public | **TESTÉE**                           |
| `GET`    | `/api/auth/steam/callback`                            | Steam  | **TESTÉE**                           |
| `GET`    | `/api/auth/me`                                        | Bearer | **TESTÉE**                           |
| `GET`    | `/api/players/search?q=`                              | Public | **TESTÉE**                           |
| `GET`    | `/api/players/:steamId`                               | Public | **TESTÉE**                           |
| `GET`    | `/api/players/:steamId/matches`                       | Public | **TESTÉE**                           |
| `GET`    | `/api/tracked-players`                                | Bearer | **TESTÉE**                           |
| `POST`   | `/api/tracked-players`                                | Bearer | **TESTÉE**                           |
| `GET`    | `/api/tracked-players/:id`                            | Bearer | **TESTÉE**                           |
| `PATCH`  | `/api/tracked-players/:id`                            | Bearer | **TESTÉE**                           |
| `DELETE` | `/api/tracked-players/:id`                            | Bearer | **TESTÉE**                           |
| `GET`    | `/api/openapi.json`, `/api/docs`                      | Public | **TESTÉE**                           |
| `GET`    | `/api/heroes`, `/api/matches/:id`, `/api/leaderboard` | Public | NON COMMENCÉE (P1, issues #19 à #23) |

« TESTÉE » signifie couverte par la suite Jest/Supertest (mocks déterministes). Les routes joueurs ont aussi été vérifiées à la main contre la vraie API Deadlock le 16/11/2026.

| Code HTTP | `error.code`          | Cas                                                                                  |
| --------- | --------------------- | ------------------------------------------------------------------------------------ |
| 400       | `INVALID_INPUT`       | Champ, identifiant ou JSON invalide ; PATCH vide ; champ interdit (`ownerId`, `id`…) |
| 401       | `UNAUTHORIZED`        | Jeton absent, invalide ou expiré                                                     |
| 404       | `NOT_FOUND`           | Ressource absente **ou appartenant à un autre compte**                               |
| 409       | `ALREADY_TRACKED`     | Joueur déjà suivi par ce compte                                                      |
| 413       | `INVALID_INPUT`       | Corps JSON supérieur à 16 kB                                                         |
| 429       | `RATE_LIMITED`        | Limite de débit atteinte (`Retry-After`)                                             |
| 502       | `UPSTREAM_ERROR`      | Réponse inexploitable de Deadlock API                                                |
| 503       | `SERVICE_UNAVAILABLE` | Deadlock API indisponible et aucune copie en cache (`Retry-After`)                   |
| 500       | `INTERNAL_ERROR`      | Erreur imprévue (détails uniquement dans les logs serveur)                           |

---

## Architecture

```
Navigateur (React, :5173) ──/api──► Express (:3001) ──┬──► MongoDB : users, tracked_players, api_cache
                                                      ├──► Deadlock API : profils, historiques, héros (DeadlockClient)
                                                      └──► Steam OpenID : vérification de connexion
```

```
src/
  app.ts                  application Express importable, sans ouverture de port (tests)
  index.ts                démarrage : config, Mongo, serveur, arrêt propre
  config/env.ts           validation Zod de l'environnement
  database/               connexion Mongo, cache api_cache
  integrations/deadlock/  DeadlockClient (résilience), schémas Zod des réponses, mappers
  middleware/             auth Bearer, erreurs, rate limit, journal d'accès
  modules/
    auth/                 Steam OpenID, JWT, state signé, modèle User
    tracked-players/      CRUD privé (modèle, schémas, service, routes)
    players/              recherche, profil, historique (cache, agrégats, pagination)
    docs/  health/
  docs/openapi.ts         contrat OpenAPI 3.1 (source de vérité)
  shared/                 erreurs, validation, schémas communs, logger
tests/                    Jest + Supertest, Mongo en mémoire, fetch mocké
scripts/                  export et contrôle du contrat OpenAPI
```

### Modèle MongoDB

| Collection        | Champs                                                                                | Index                                                        |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `users`           | `steamId`, `displayName`, `avatarUrl`, `lastLoginAt`, timestamps                      | `{ steamId }` unique                                         |
| `tracked_players` | `ownerId` (→ users), `steamId`, `alias`, `note`, `tags[]`, timestamps                 | `{ ownerId, steamId }` unique ; `{ ownerId, updatedAt: -1 }` |
| `api_cache`       | `key`, `payload` (données normalisées), `fetchedAt`, `expiresAt`, `purgeAt`, `source` | `{ key }` unique ; TTL sur `purgeAt`                         |

Chaque opération sur `tracked_players` filtre sur `ownerId` **dans la requête Mongo elle-même**. L'objet d'un autre compte est donc indiscernable d'un objet inexistant (404).

### Intégration Deadlock API

- **Un point d'accès unique, `DeadlockClient`** : timeout de 6 s, déduplication des requêtes identiques en cours, 8 requêtes simultanées au plus. Après un 429, 503 ou 504 accompagné de `Retry-After`, il échoue immédiatement pendant le délai indiqué. Les réponses sont validées par Zod, et la clé API éventuelle n'est jamais exposée.
- **Cache Mongo** : recherche 5 min, profil 15 min, historique 3 min, catalogue des héros 24 h. Si le fournisseur est en panne, on sert la dernière copie avec `meta.isStale = true` ; sans copie, on répond 503.
- **Historique** : la source le renvoie en entier. Il est mis en cache une seule fois et partagé entre le profil et la liste des parties, puis paginé côté back avec un curseur opaque stable (`start_time:match_id`).
- **Statistiques** : calculées sur les **parties disponibles** gagnées ou perdues (`player_match_outcome` 1 ou 2), arrondies à 2 décimales ; `kda = (K + A) / max(D, 1)`.

### Sécurité

- **Connexion Steam OpenID 2.0.** L'assertion est vérifiée localement (`op_endpoint`, `return_to`, `claimed_id`, champs signés, nonce), puis confirmée auprès de Steam. Un `state` signé HMAC, valable 10 min, protège le parcours. Le JWT HS256 n'est transmis qu'en fragment d'URL.
- **Jeton Bearer.** Algorithme, expiration, type et `sub` sont vérifiés. `ownerId` provient exclusivement du JWT.
- **Validation Zod stricte.** Les champs inconnus ou interdits donnent un 400. La validation serveur fait autorité.
- **En-têtes et limites.** helmet (CSP `default-src 'none'`), CORS limité aux origines déclarées, limites de débit globale et `/auth`, corps JSON limité à 16 kB.
- **Journalisation.** Logs JSON structurés, sans query string, sans en-têtes, sans jeton ; un `X-Request-Id` permet de corréler une erreur.
- **Image Docker.** Elle tourne sans root et ne contient aucun secret.

---

## Journal des arbitrages

| Décision                                                        | Raison                                                                                                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connexion Steam uniquement** (pas d'email ni de mot de passe) | Validé par l'encadrant ; contrat `thebaroness/docs/back-steam-contract.md`. Écart au cahier des charges (§4, §13), qui prime sur lui. bcrypt n'est plus utilisé, puisqu'aucun mot de passe n'est stocké. |
| Express 5 + TypeScript en CommonJS                              | Express est imposé par le livret. CommonJS assure la compatibilité avec Jest (ts-jest).                                                                                                                  |
| Deux dépôts (front / back)                                      | Cahier des charges §10 ; contrat partagé via `docs/openapi.yaml`.                                                                                                                                        |
| Contrat OpenAPI écrit en TypeScript                             | Compilé avec l'app (présent dans l'image), et un test vérifie que chaque route documentée existe.                                                                                                        |
| JWT en mémoire côté front, sans refresh                         | Cahier §13.8. Avec Steam, une reconnexion se fait en un clic.                                                                                                                                            |
| Cache Mongo plutôt qu'en mémoire                                | Il survit aux redémarrages et permet le repli « périmé » (§11.3).                                                                                                                                        |
| Pagination de l'historique côté back                            | Deadlock API ne pagine pas ; le curseur reste stable si de nouvelles parties arrivent.                                                                                                                   |
| `rank` toujours à `null`                                        | Le rang est en P1 (#19).                                                                                                                                                                                 |
| Parties non scorées exclues                                     | `player_match_outcome` différent de 1 ou 2 (abandon, pénalité…) n'est ni une victoire ni une défaite.                                                                                                    |
| Limite connue : `state` OpenID non lié au navigateur            | Il n'y a pas de cookie, donc pas de protection complète contre le _login CSRF_. Impact faible ; correction possible : cookie `httpOnly` `SameSite=Lax`.                                                  |

---

## Recette (cahier des charges §17)

État au 16/11/2026. « Non testé » signifie que le point n'a pas été vérifié, pas qu'il échoue.

| #   | Critère                                                        | Résultat                                                                                                                |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Front et back démarrent indépendamment et communiquent en HTTP | **Non testé** : le back démarre seul (Docker) ; intégration avec le front à faire                                       |
| 2   | MongoDB connecté, données persistantes après redémarrage       | **OK** : suivi créé, puis `docker compose down` / `up`, suivi toujours présent ; test T-14                              |
| 3   | `GET /api/health` conforme                                     | **OK** : T-01 et healthcheck Docker                                                                                     |
| 4   | Authentification : codes, format, JWT signé (bcrypt)           | **OK, adapté** : Steam OpenID + JWT HS256 testés ; bcrypt sans objet (aucun mot de passe, choix validé par l'encadrant) |
| 5   | Les cinq opérations CRUD accessibles depuis l'interface        | **Back OK** (T-07 à T-13) ; **interface non testée**                                                                    |
| 6   | Propriétaire jamais choisi par le navigateur                   | **OK** : `ownerId` issu du JWT ; `ownerId`/`id` refusés en 400 (T-10)                                                   |
| 7   | Objet d'A inaccessible à B en GET/PATCH/DELETE (404)           | **OK** : T-09, objet vérifié intact                                                                                     |
| 8   | Erreurs 400/401/404/409 et enveloppes contrôlées               | **OK** : tests dédiés pour chaque code                                                                                  |
| 9   | Recherche et fiche joueur via une vraie intégration Deadlock   | **OK** : vérifié à la main contre api.deadlock-api.com ; tests sur mocks (T-15, T-16)                                   |
| 10  | OpenAPI décrit les routes réellement implémentées              | **OK** : test NF-12 (chaque opération documentée existe), `openapi:check` en CI                                         |
| 11  | Jest/Supertest, ESLint et build fonctionnent                   | **OK** : CI GitHub Actions verte (179 tests, couverture 98,7 % des lignes)                                              |
| 12  | Démonstration en 4 minutes sans intervention dans la base      | **Non testé**                                                                                                           |
| 13  | Aucun secret, `.env` ni `node_modules` dans Git                | **OK** : seul `.env.example` (valeurs fictives) est versionné                                                           |
| 14  | SHAs front et back identifiables                               | **À faire** à la livraison : tag `v1.0.0` sur chaque dépôt, puis noter les SHA ci-dessous                               |

**Livraison** : back `<SHA à renseigner>` · front compatible `<SHA à renseigner>` · contrat OpenAPI `1.1.0`.

## Licence

Projet pédagogique, tous droits réservés.
