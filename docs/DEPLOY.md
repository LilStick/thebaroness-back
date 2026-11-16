# Déploiement sur Coolify

Un conteneur par service :

| Service   | Source                                     | Rôle                                                      | Exposé                        |
| --------- | ------------------------------------------ | --------------------------------------------------------- | ----------------------------- |
| `mongodb` | `mongo:8.0`                                | Base (volume `mongo-data`)                                | Non                           |
| `api`     | ce dépôt (`Dockerfile`)                    | API HTTP, port 3001                                       | Oui : `https://api.<domaine>` |
| `worker`  | même image, commande `node dist/worker.js` | Préchauffage du cache toutes les 5 min, sans serveur HTTP | Non                           |
| `front`   | dépôt front (`Dockerfile` nginx)           | Site, port 8080                                           | Oui : `https://<domaine>`     |

Topologie retenue : **deux domaines** (front et `api.`), CORS activé côté back. Aucun changement de code dans le front : l'URL de l'API est fixée au build par `VITE_API_BASE_URL`.

## 1. Back : ressource « Docker Compose » (Coolify v3.12)

Production actuelle : `https://api.thebaroness.4esport.fr` (front prévu sur `https://thebaroness.4esport.fr`).

1. New Resource > Docker Compose > dépôt `lilstick/thebaroness-back` (public), branche `main`, Build Pack **Compose**.
2. Configuration > Docker Compose File Location : `/compose.prod.yaml`, puis **Reload Docker Compose File**.
3. Bloc **API** : URL (FQDN) `https://api.<domaine>`, Port `3001`. Blocs MONGODB et WORKER : vides. Ces champs ne sont modifiables que ressource arrêtée : Stop, saisir, Save, Deploy. **Sans FQDN, Traefik répond `404 page not found` avec son certificat par défaut.**
4. **Secrets** (« Need during buildtime » désactivé partout) :

| Secret                              | Obligatoire | Exemple / défaut                                            |
| ----------------------------------- | ----------- | ----------------------------------------------------------- |
| `JWT_SECRET`                        | oui         | `openssl rand -hex 32`                                      |
| `API_PUBLIC_URL`                    | oui         | `https://api.<domaine>` (sans `/api` ni slash final)        |
| `FRONT_URL`                         | oui         | `https://<domaine>`                                         |
| `CORS_ORIGIN`                       | oui         | `https://<domaine>` (plusieurs : séparées par des virgules) |
| `TRUST_PROXY`                       | non         | `1` (Traefik) ; `2` si Cloudflare proxifie aussi le domaine |
| `DEADLOCK_API_KEY`                  | non         | ne pas créer si vide                                        |
| `REFRESH_INTERVAL_MS`               | non         | `300000` (minimum `60000`)                                  |
| `JWT_EXPIRES_IN`                    | non         | `15m`                                                       |
| `AUTH_RATE_LIMIT`, `API_RATE_LIMIT` | non         | `60`, `300`                                                 |
| `LOG_LEVEL`                         | non         | `info`                                                      |

**Ne pas créer** `MONGODB_URI`, `PORT`, `NODE_ENV` ni `REFRESH_WORKER_ENABLED` : Coolify v3 injecte les Secrets (et `NODE_ENV`, `PORT`) dans l'`environment` de chaque service, et une clé déjà présente dans le compose fait échouer le `docker compose pull` (`environment array items[x,y] must be unique`). Pour la même raison, le compose n'utilise pas `${VAR:?}` (le pull se fait sans les Secrets).

5. Deploy. Vérifications : `https://api.<domaine>/api/health` renvoie `{"status":"ok"}` avec un certificat Let's Encrypt ; les trois services sont RUNNING ; dans les logs du worker, une ligne `Cycle de préchauffage terminé` toutes les 5 min.

MongoDB n'est jamais exposé. Sauvegarde : `docker exec <conteneur mongodb> mongodump --archive > backup.archive`.

## 2. Front : application « Dockerfile »

1. New Resource > Application > dépôt front, Build Pack : **Dockerfile**.
2. Port exposé : `8080`. Domaine : `https://<domaine>`.
3. Build variable (cocher « Build Variable ») : `VITE_API_BASE_URL=https://api.<domaine>/api`. Elle est figée dans le JavaScript au build : la changer impose un redéploiement.

## 3. Connexion Steam

Rien à déclarer chez Steam : le realm OpenID est `API_PUBLIC_URL`. Parcours : front > `https://api.<domaine>/api/auth/steam` > Steam > `https://api.<domaine>/api/auth/steam/callback` > `FRONT_URL/auth/callback#token=...`. Si la connexion échoue, vérifier d'abord `API_PUBLIC_URL` et `FRONT_URL` (https, sans slash final).

## Dev local

`docker compose up --build -d` lance les mêmes trois conteneurs (`compose.yaml`), avec Mongo accessible sur `127.0.0.1:27017`.
