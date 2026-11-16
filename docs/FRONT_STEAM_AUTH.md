# Connexion Steam : guide d'intégration front

> Pour : Arthur (thebaroness-front)
> Concerne : remplacement complet de l'inscription / connexion email + mot de passe par **Steam OpenID**.
> Côté back : issue [#30](https://github.com/LilStick/thebaroness-back/issues/30).

## TL;DR

- `POST /api/auth/register` et `POST /api/auth/login` **n'existent plus**. Supprime les pages `/register` et `/login` (formulaires) et remplace-les par un unique bouton **« Se connecter avec Steam »**.
- Ce bouton fait une **navigation pleine page** (pas un `fetch`) vers `/api/auth/steam?returnTo=<chemin>`.
- Après Steam, le navigateur revient sur **`/auth/callback`** (une nouvelle route React à créer) avec le JWT dans le **fragment** d'URL : `#token=…&returnTo=…` (ou `#error=…`).
- Tu stockes le token **en mémoire** comme aujourd'hui (rien ne change dans `session.ts`, `client.ts`, l'en-tête `Authorization: Bearer`).
- Pour récupérer l'utilisateur : `GET /api/auth/me` → `{ user: { id, steamId } }`.
- Le type `User` change : `{ id, email }` → **`{ id, steamId }`**.

Toutes les autres routes (`/players/*`, `/tracked-players/*`, `/health`) sont **inchangées**.

---

## 1. Le flux complet

```
 Front (5173)               Back (3001)                         Steam
 ────────────               ───────────                         ─────
 clic « Se connecter avec Steam »
 window.location.assign('/api/auth/steam?returnTo=/tracked')
        ───────────────────────►  GET /api/auth/steam
                                  302 ──────────────────────────► page de login Steam
                                                                  (l'utilisateur se connecte)
                                  GET /api/auth/steam/callback ◄── 302
                                  ├ vérifie la réponse (signature, return_to, nonce…)
                                  ├ re-vérifie auprès de Steam (check_authentication)
                                  ├ crée le compte au 1er login (par steamId)
                                  └ 302 vers FRONTEND_URL/auth/callback#token=…&returnTo=/tracked
 /auth/callback ◄──────────────────
 ├ lit le fragment, stocke le token en mémoire
 ├ efface le fragment de l'URL (history.replaceState)
 ├ GET /api/auth/me  (Bearer) → { user: { id, steamId } }
 └ navigate(returnTo)
```

Pourquoi un fragment (`#`) : il n'est **jamais envoyé** à un serveur, n'apparaît pas dans les logs nginx ni dans l'en-tête `Referer`. Le back ajoute en plus `Cache-Control: no-store` et `Referrer-Policy: no-referrer` sur la redirection.

---

## 2. Contrat HTTP

### `GET /api/auth/steam?returnTo=<chemin>` — public

| Paramètre  | Requis | Règle                                                                                                                                                                      |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `returnTo` | non    | Chemin **relatif** du front où revenir après connexion (`/tracked`, `/players/7656…?tab=matches`). Tout le reste (`//evil.com`, `https://…`, absent) est remplacé par `/`. |

Réponse : **302** vers Steam. À appeler par **navigation** (`window.location.assign`), jamais en `fetch` (Steam ne supporte pas CORS, et il faut que l'utilisateur voie la page Steam).

### `GET /api/auth/steam/callback` — appelé par Steam, pas par toi

Réponse : **302** vers `${FRONTEND_URL}/auth/callback#…` avec dans le fragment :

| Cas                                             | Fragment                                    |
| ----------------------------------------------- | ------------------------------------------- |
| Succès                                          | `token=<JWT>&returnTo=<chemin>`             |
| L'utilisateur a annulé sur Steam                | `error=STEAM_CANCELLED&returnTo=<chemin>`   |
| Réponse Steam invalide / falsifiée              | `error=STEAM_AUTH_FAILED&returnTo=<chemin>` |
| Steam injoignable (timeout, 5xx)                | `error=STEAM_UNAVAILABLE&returnTo=<chemin>` |
| Lien de connexion expiré (> 10 min) ou trafiqué | `error=INVALID_STATE`                       |

Les paramètres sont encodés comme une query string : lis-les avec `new URLSearchParams(location.hash.slice(1))`.

### `GET /api/auth/me` — `Authorization: Bearer <JWT>`

```json
200 { "user": { "id": "665f1c2e9b1e8a0012345678", "steamId": "76561198957316510" } }
401 { "error": { "code": "UNAUTHORIZED", "message": "Session absente ou expirée." } }
```

### Le JWT

- Inchangé dans son usage : `Authorization: Bearer <token>` sur `/api/tracked-players/*` et `/api/auth/me`.
- Durée de vie : `JWT_EXPIRES_IN` (15 min par défaut). À l'expiration → 401 → `sessionStore.clear()` (déjà en place dans `client.ts`) → renvoyer vers le bouton Steam. Si l'utilisateur est encore connecté à Steam, la reconnexion se fait **en un clic, sans saisie**.
- Toujours **en mémoire uniquement** (pas de `localStorage`) : un rechargement complet impose une reconnexion (en un clic).

---

## 3. Modifications à faire dans le front

### 3.1 Types — `src/api/types.ts`

```ts
// AVANT
export interface User {
  id: string;
  email: string;
}
export interface Credentials {
  email: string;
  password: string;
}
export interface AuthResponse {
  user: User;
  token: string;
}

// APRÈS
export interface User {
  id: string;
  /** SteamID64 (17 chiffres), toujours en string. */
  steamId: string;
}
export interface MeResponse {
  user: User;
}

export type SteamLoginError =
  'STEAM_CANCELLED' | 'STEAM_AUTH_FAILED' | 'STEAM_UNAVAILABLE' | 'INVALID_STATE';
```

Supprimer `Credentials` et `AuthResponse` (plus aucune route ne les utilise).

### 3.2 API — `src/api/auth.ts`

```ts
import { config } from '@/config';
import { request } from './client';
import type { MeResponse } from './types';

/** Démarre la connexion Steam (navigation pleine page, pas de fetch). */
export function startSteamLogin(returnTo = window.location.pathname + window.location.search) {
  const base = config.apiBaseUrl.replace(/\/$/, ''); // '/api' par défaut
  window.location.assign(`${base}/auth/steam?returnTo=${encodeURIComponent(returnTo)}`);
}

/** Utilisateur courant (nécessite le token en session). */
export const getMe = () => request<MeResponse>('GET', '/auth/me', { auth: true });
```

> Adapte les noms (`request`, `config.apiBaseUrl`, option `auth`) à ce qui existe déjà dans ton `client.ts` / `config.ts`.

Supprimer `register()` et `login()`.

### 3.3 Nouvelle route — `/auth/callback`

À ajouter dans `router.tsx` (route publique) :

```tsx
// src/pages/AuthCallbackPage.tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMe } from '@/api/auth';
import { sessionStore } from '@/api/session';

const MESSAGES: Record<string, string> = {
  STEAM_CANCELLED: 'Connexion annulée.',
  STEAM_AUTH_FAILED: "Steam n'a pas pu confirmer ton identité. Réessaie.",
  STEAM_UNAVAILABLE: 'Steam est momentanément indisponible. Réessaie dans un instant.',
  INVALID_STATE: 'Le lien de connexion a expiré. Recommence la connexion.',
};

/** Accepte uniquement un chemin interne (défense en profondeur, le back filtre déjà). */
const safePath = (value: string | null) =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : '/';

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false); // StrictMode exécute les effets deux fois en dev

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const params = new URLSearchParams(window.location.hash.slice(1));
    // Retire immédiatement le token de la barre d'adresse et de l'historique.
    window.history.replaceState(null, '', window.location.pathname);

    const token = params.get('token');
    const returnTo = safePath(params.get('returnTo'));

    if (!token) {
      setError(MESSAGES[params.get('error') ?? ''] ?? 'Connexion impossible.');
      return;
    }

    sessionStore.setToken(token); // adapte au nom réel dans session.ts
    getMe()
      .then(({ user }) => {
        sessionStore.setUser(user); // idem
        navigate(returnTo, { replace: true });
      })
      .catch(() => {
        sessionStore.clear();
        setError('Connexion impossible. Réessaie.');
      });
  }, [navigate]);

  if (error) return <LoginErrorState message={error} />; // bouton « Réessayer avec Steam »
  return <FullPageSpinner label="Connexion en cours…" />;
}
```

### 3.4 Pages de connexion / inscription

- `/register` : supprimer (ou rediriger vers `/login`).
- `/login` : remplacer le formulaire par un bouton **« Se connecter avec Steam »** qui appelle `startSteamLogin(returnTo)`.
  - `returnTo` = la page que `RequireAuth` voulait afficher (souvent passée en `location.state.from`), sinon `/`.
  - Branding : Valve fournit des boutons officiels « Sign in through Steam » (https://steamcommunity.com/dev) ; un bouton maison avec le logo Steam marche aussi.
- `RequireAuth` : quand il n'y a pas de session, rediriger vers `/login` avec `state: { from: location.pathname + location.search }` (inchangé si c'est déjà le cas).

### 3.5 Affichage de l'utilisateur connecté

Plus d'email à afficher. Pour un pseudo et un avatar, réutilise la route publique existante :

```ts
GET /api/players/{user.steamId}   →   player.displayName, player.avatarUrl
```

(Même hook TanStack Query que la page profil, donc mis en cache.)

### 3.6 MSW (mode mock)

Remplacer les handlers `POST /auth/register` et `POST /auth/login` par :

```ts
// Démarrage : simule directement le retour de Steam (pas de vraie page Steam en mock).
http.get('/api/auth/steam', ({ request }) => {
  const returnTo = new URL(request.url).searchParams.get('returnTo') ?? '/';
  const fragment = new URLSearchParams({ token: 'mock.user-1.signature', returnTo });
  return new Response(null, {
    status: 302,
    headers: { Location: `/auth/callback#${fragment}` },
  });
}),

http.get('/api/auth/me', ({ request }) => {
  if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
    return HttpResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Session absente ou expirée.' } },
      { status: 401 },
    );
  }
  return HttpResponse.json({ user: { id: '665f1c2e9b1e8a0012345678', steamId: '76561198000000000' } });
}),
```

> ⚠️ Le service worker MSW n'intercepte pas toujours une **navigation** pleine page (`window.location.assign`). Si la redirection mock ne se déclenche pas, en mode mock fais directement `navigate('/auth/callback#token=mock…&returnTo=…')` dans `startSteamLogin` (`if (import.meta.env.VITE_API_MODE === 'mock')`).

Ajoute aussi un scénario par code d'erreur (`#error=STEAM_CANCELLED`, etc.) pour tester l'écran d'erreur.

Fixtures : `users.json` → `{ "id": "…", "steamId": "7656119…" }` (plus d'email ni de mot de passe).

### 3.7 Tests

- Supprimer les tests de formulaires register/login.
- `AuthCallbackPage` : fragment avec token → appelle `/auth/me`, stocke la session, navigue vers `returnTo` ; fragment `error=…` → message ; `returnTo=//evil.test` → navigue vers `/`.
- Playwright : le vrai Steam n'est pas automatisable. Pour l'E2E, ouvrir directement `/auth/callback#token=<jwt de test>&returnTo=/tracked`, ou utiliser le mode mock.

---

## 4. Configuration et environnements

### En local (dev)

Rien à changer côté front : le proxy Vite `/api → http://localhost:3001` suffit pour **démarrer** la connexion.

Côté back (`.env`) :

```dotenv
API_PUBLIC_URL=http://localhost:3001   # adresse où Steam renvoie le navigateur
FRONTEND_URL=http://localhost:5173     # où le back renvoie après Steam
```

Steam renvoie le navigateur **directement sur le back** (`localhost:3001/api/auth/steam/callback`), qui redirige aussitôt vers `localhost:5173/auth/callback`. Ce sont des navigations, pas des `fetch` : **pas de CORS en jeu**.

> Variante si tu préfères que tout passe par 5173 : `API_PUBLIC_URL=http://localhost:5173` côté back (le proxy Vite relaie `/api/auth/steam/callback`). Les deux marchent.

### En production

- `FRONTEND_URL` = URL publique du front (ex. `https://thebaroness.example`).
- `API_PUBLIC_URL` = URL publique de l'API telle que **le navigateur** la voit. Si nginx sert le front et proxifie `/api` vers le back sur le même domaine : `API_PUBLIC_URL=https://thebaroness.example`.
- ⚠️ `nginx.conf` du front ne proxifie pas `/api` aujourd'hui : soit on ajoute un `location /api/ { proxy_pass http://api:3001; }`, soit l'API a son propre domaine (et alors `VITE_API_BASE_URL` absolu + CORS côté back). À trancher ensemble au moment du déploiement.

---

## 5. Sécurité : ce que le back garantit (pour l'oral)

- **Vérification complète de l'assertion OpenID 2.0** : `mode`, `ns`, `op_endpoint` = Steam, `return_to` identique à celui qu'on a émis, `claimed_id` au format `https://steamcommunity.com/openid/id/<17 chiffres>`, champs critiques présents dans `openid.signed`, nonce de moins de 5 minutes, puis **contre-vérification serveur → Steam** (`check_authentication`). Un utilisateur ne peut pas forger un SteamID en modifiant l'URL.
- **Intégrité du parcours** : chaque connexion porte un `state` signé HMAC-SHA256 valable 10 minutes ; un callback sans state valide (forgé, modifié, expiré) est rejeté (`INVALID_STATE`) **sans même contacter Steam**, et le `returnTo` qu'il transporte ne peut pas être altéré.
- **Limite connue** : le `state` n'est pas lié au navigateur (pas de cookie), donc pas de protection complète contre le _login CSRF_ (forcer quelqu'un à se connecter sur le compte d'un autre). Impact faible ici (aucune donnée sensible saisie par l'utilisateur) ; amélioration possible : cookie `httpOnly` `SameSite=Lax` posé au démarrage et comparé au callback.
- **Anti open-redirect** : `returnTo` n'accepte qu'un chemin relatif.
- **Rate limit** sur `/api/auth/*` → 429 `RATE_LIMITED`.
- Aucun mot de passe stocké : le compte = `{ steamId, lastLoginAt }`, créé au premier login.

## 6. Checklist

- [ ] Types `User` / `MeResponse` / `SteamLoginError`
- [ ] `startSteamLogin()` + `getMe()` ; suppression de `register()` / `login()`
- [ ] Route publique `/auth/callback` + `AuthCallbackPage`
- [ ] `/login` = bouton Steam ; `/register` supprimé
- [ ] Affichage pseudo/avatar via `GET /api/players/:steamId`
- [ ] Handlers MSW + fixtures + scénarios d'erreur
- [ ] Tests unitaires du callback ; E2E via `/auth/callback#token=…`
- [ ] Mettre à jour `docs/decisions.md` (écart au cahier des charges : Steam remplace email/mot de passe)

Questions → ping LilStick, ou commente l'issue #30 du back.
