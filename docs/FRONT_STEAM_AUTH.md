# Connexion Steam : état côté back

> Pour : Arthur (thebaroness-front).
> Référence : `thebaroness/docs/back-steam-contract.md`. Le back l'implémente **à l'identique** (issue #34).

## Routes

| Route                          | Réponse                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/steam`          | 302 vers `https://steamcommunity.com/openid/login` (navigation complète, aucun paramètre attendu)               |
| `GET /api/auth/steam/callback` | Appelée par Steam. 302 vers `<FRONT_URL>/auth/callback#token=<JWT>` ou `<FRONT_URL>/auth/callback?error=<code>` |
| `GET /api/auth/me` (Bearer)    | 200 `{ "id", "steamId", "displayName", "avatarUrl" }` (objet direct, sans enveloppe) ; 401 `UNAUTHORIZED` sinon |

Exemple de `GET /api/auth/me` :

```json
{
  "id": "665f1c2e9b1e8a0012345678",
  "steamId": "76561198957316510",
  "displayName": "Corvid",
  "avatarUrl": "https://avatars.steamstatic.com/…_full.jpg"
}
```

- `displayName` / `avatarUrl` : profil Steam lu via Deadlock API **à chaque connexion**. S'il est indisponible : `displayName = steamId` et `avatarUrl = null` à la création ; à une reconnexion, on conserve les valeurs connues.
- Le fragment de succès ne contient **que** `token`. Le chemin de retour reste géré par le front (`sessionStorage`).

### Valeurs possibles de `?error=`

Le front n'en lit que la présence ; les valeurs servent au diagnostic.

| Code                | Cause                                                                             |
| ------------------- | --------------------------------------------------------------------------------- |
| `STEAM_CANCELLED`   | L'utilisateur a annulé sur Steam                                                  |
| `STEAM_AUTH_FAILED` | Assertion invalide ou refusée par Steam (`is_valid:false`)                        |
| `STEAM_UNAVAILABLE` | Steam injoignable lors de la vérification                                         |
| `INVALID_STATE`     | Lien de connexion expiré (plus de 10 min) ou modifié : relancer `/api/auth/steam` |

## Retirés

`POST /api/auth/register`, `POST /api/auth/login`, `passwordHash`, bcrypt, `EMAIL_ALREADY_USED`.

## Autres points du contrat

- **CORS** : branché sur `CORS_ORIGIN` (liste séparée par des virgules), méthodes `GET, POST, PATCH, DELETE`, en-têtes `Authorization, Content-Type`, `Retry-After` exposé, sans `credentials`. Inutile en dev avec le proxy Vite.
- **Durée du jeton** : `.env.example` met `JWT_EXPIRES_IN=1h` pour le développement (pas de refresh).
- **Suivis** : inchangés (Bearer, `ownerId` = `sub` du JWT).
- **`player.region`** : sera fourni dans `GET /api/players/:steamId` (code pays Steam, `null` si inconnu).

## Lancer en local

`.env` du back :

```dotenv
PORT=3001
API_PUBLIC_URL=http://localhost:3001   # Steam renvoie le navigateur ici
FRONT_URL=http://localhost:5173        # puis le back redirige vers <FRONT_URL>/auth/callback
CORS_ORIGIN=http://localhost:5173
JWT_EXPIRES_IN=1h
```

Front : `npm run dev` (proxy Vite `/api` vers `http://localhost:3001`). Steam renvoie le navigateur directement sur `localhost:3001`, qui redirige aussitôt vers `localhost:5173/auth/callback`. Ce sont des navigations, pas des `fetch` : aucune question de CORS.

## Sécurité (pour l'oral)

- Assertion vérifiée localement (`mode`, `ns`, `op_endpoint` = Steam, `return_to` identique à celui émis, `claimed_id` au format `https://steamcommunity.com/openid/id/<17 chiffres>`, `identity` = `claimed_id`, champs critiques signés, nonce de moins de 5 min), **puis** confirmée par Steam (`check_authentication`). Le `claimed_id` seul n'est jamais cru.
- `realm` = `API_PUBLIC_URL` ; `return_to` contient un `state` signé HMAC-SHA256 valable 10 min, vérifié avant tout appel à Steam.
- Limite connue : le `state` n'est pas lié au navigateur (pas de cookie), donc pas de protection complète contre le _login CSRF_. Amélioration possible : cookie `httpOnly` `SameSite=Lax`.
- Redirection finale avec `Cache-Control: no-store` et `Referrer-Policy: no-referrer`. Ni le jeton ni l'URL finale ne sont journalisés.
- Rate limit sur `/api/auth/*` → 429 `RATE_LIMITED`.
