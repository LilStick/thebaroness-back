import type { OpenAPIV3_1 as O } from 'openapi-types';

/**
 * Contrat HTTP v1 de l'API thebaroness : source de vérité (§10, §19.9).
 * Servi sur /api/openapi.json et /api/docs ; exporté dans docs/openapi.yaml (`npm run openapi`).
 * Versionnement : majeure = changement incompatible, mineure = ajout, patch = correction.
 */
export const OPENAPI_VERSION = '1.2.0';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string) => ({ $ref: `#/components/responses/${name}` });
const nullable = (type: 'string' | 'number' | 'integer', extra: object = {}) => ({
  type: [type, 'null'] as ['string', 'null'],
  ...extra,
});
const json = (schema: object, example?: unknown) => ({
  'application/json': { schema, ...(example === undefined ? {} : { example }) },
});

const steamIdParam: O.ParameterObject = {
  name: 'steamId',
  in: 'path',
  required: true,
  description: 'SteamID64 (17 chiffres), toujours transmis en chaîne.',
  schema: { type: 'string', pattern: '^\\d{17}$' },
  example: '76561198957316510',
};
const trackedIdParam: O.ParameterObject = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
  example: '507f1f77bcf86cd799439012',
};

const trackedExample = {
  id: '507f1f77bcf86cd799439012',
  steamId: '76561198000000000',
  alias: 'Duo régulier',
  note: 'Joue souvent en classé',
  tags: ['duo', 'ranked'],
  createdAt: '2026-11-16T09:00:00.000Z',
  updatedAt: '2026-11-16T09:00:00.000Z',
};
const metaExample = {
  fetchedAt: '2026-11-16T09:00:00.000Z',
  sourceUpdatedAt: null,
  isStale: false,
  isPartial: false,
};

const errorResponse = (description: string, code: string, message: string) => ({
  description,
  content: json(ref('Error'), { error: { code, message } }),
});

export const openApiDocument: O.Document = {
  openapi: '3.1.0',
  info: {
    title: 'thebaroness API',
    version: OPENAPI_VERSION,
    description:
      'API du tracker de statistiques Deadlock. Les statistiques proviennent de Deadlock API ' +
      "(api.deadlock-api.com, source communautaire indépendante de Valve) ; l'espace privé est " +
      'stocké dans MongoDB. Erreurs : `{ "error": { "code", "message" } }`. Inconnu = `null`, jamais 0.',
  },
  servers: [{ url: '/api' }],
  tags: [
    { name: 'Santé' },
    { name: 'Authentification', description: 'Connexion Steam OpenID uniquement.' },
    { name: 'Joueurs', description: 'Données publiques issues de Deadlock API, avec cache.' },
    { name: 'Suivis', description: 'Liste privée de joueurs suivis (Bearer JWT).' },
    { name: 'Catalogue', description: 'Héros, rangs, carte (assets Deadlock, en français).' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Santé'],
        summary: 'Santé du serveur',
        responses: {
          '200': {
            description: 'Serveur opérationnel',
            content: json(
              {
                type: 'object',
                required: ['status'],
                properties: { status: { const: 'ok' } },
                additionalProperties: false,
              },
              { status: 'ok' },
            ),
          },
        },
      },
    },

    '/auth/steam': {
      get: {
        tags: ['Authentification'],
        summary: 'Démarre la connexion Steam',
        description:
          'À ouvrir par **navigation complète** (pas en fetch). Redirige vers Steam OpenID 2.0.',
        responses: {
          '302': { description: 'Redirection vers https://steamcommunity.com/openid/login' },
          '429': response('RateLimited'),
        },
      },
    },
    '/auth/steam/callback': {
      get: {
        tags: ['Authentification'],
        summary: 'Retour de Steam (appelé par Steam)',
        description:
          "Vérifie l'assertion OpenID (localement puis via `check_authentication`), crée ou met à jour " +
          "l'utilisateur, puis redirige vers le front :\n\n" +
          '- succès : `<FRONT_URL>/auth/callback#token=<JWT>`\n' +
          '- échec : `<FRONT_URL>/auth/callback?error=<code>` avec `STEAM_CANCELLED`, ' +
          '`STEAM_AUTH_FAILED`, `STEAM_UNAVAILABLE` ou `INVALID_STATE`.',
        parameters: [
          { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'openid.*',
            in: 'query',
            required: false,
            description: 'Paramètres OpenID 2.0 ajoutés par Steam.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '302': { description: 'Redirection vers `<FRONT_URL>/auth/callback`' },
          '429': response('RateLimited'),
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Authentification'],
        summary: 'Utilisateur courant',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Utilisateur authentifié',
            content: json(ref('PublicUser'), {
              id: '665f1c2e9b1e8a0012345678',
              steamId: '76561198957316510',
              displayName: 'Corvid',
              avatarUrl: null,
            }),
          },
          '401': response('Unauthorized'),
          '429': response('RateLimited'),
        },
      },
    },

    '/players/search': {
      get: {
        tags: ['Joueurs'],
        summary: 'Rechercher un joueur',
        description: 'Par pseudo Steam ou SteamID64. Cache 5 min.',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 64 },
            example: 'Corvid',
          },
        ],
        responses: {
          '200': {
            description: 'Résultats (éventuellement vides)',
            content: json(ref('PlayerSearchResult'), {
              items: [
                {
                  steamId: '76561198000000000',
                  accountId: 39734272,
                  displayName: 'ExempleJoueur',
                  avatarUrl: null,
                },
              ],
              meta: metaExample,
            }),
          },
          '400': response('BadRequest'),
          '429': response('RateLimited'),
          '502': response('UpstreamError'),
          '503': response('ServiceUnavailable'),
        },
      },
    },
    '/players/{steamId}': {
      get: {
        tags: ['Joueurs'],
        summary: 'Profil public et statistiques',
        description:
          'Statistiques calculées sur les **parties disponibles** (victoires/défaites). ' +
          'Si l’historique est indisponible, `stats` est entièrement `null` et `meta.isPartial` vaut `true`. ' +
          'Cache profil 15 min, historique 3 min.',
        parameters: [steamIdParam],
        responses: {
          '200': { description: 'Profil', content: json(ref('PlayerProfile')) },
          '400': response('BadRequest'),
          '404': response('NotFound'),
          '429': response('RateLimited'),
          '502': response('UpstreamError'),
          '503': response('ServiceUnavailable'),
        },
      },
    },
    '/players/{steamId}/matches': {
      get: {
        tags: ['Joueurs'],
        summary: 'Historique des parties (paginé)',
        parameters: [
          steamIdParam,
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
          {
            name: 'cursor',
            in: 'query',
            description: 'Jeton opaque `nextCursor` de la page précédente, à transmettre tel quel.',
            schema: { type: 'string', maxLength: 128 },
          },
        ],
        responses: {
          '200': { description: 'Page de parties', content: json(ref('MatchPage')) },
          '400': response('BadRequest'),
          '404': response('NotFound'),
          '429': response('RateLimited'),
          '502': response('UpstreamError'),
          '503': response('ServiceUnavailable'),
        },
      },
    },

    '/heroes': {
      get: {
        tags: ['Catalogue'],
        summary: 'Héros jouables',
        description: 'Textes en français, triés par nom. Cache 24 h.',
        responses: {
          '200': {
            description: 'Catalogue',
            content: json({
              type: 'object',
              required: ['items', 'meta'],
              properties: {
                items: { type: 'array', items: ref('HeroSummary') },
                meta: ref('DataMeta'),
              },
            }),
          },
          '429': response('RateLimited'),
          '502': response('UpstreamError'),
          '503': response('ServiceUnavailable'),
        },
      },
    },
    '/heroes/{heroId}': {
      get: {
        tags: ['Catalogue'],
        summary: "Détail d'un héros",
        parameters: [
          {
            name: 'heroId',
            in: 'path',
            required: true,
            schema: { type: 'integer', minimum: 1 },
            example: 6,
          },
        ],
        responses: {
          '200': {
            description: 'Héros',
            content: json({
              type: 'object',
              required: ['hero', 'meta'],
              properties: { hero: ref('HeroDetail'), meta: ref('DataMeta') },
            }),
          },
          '400': response('BadRequest'),
          '404': response('NotFound'),
          '429': response('RateLimited'),
          '502': response('UpstreamError'),
          '503': response('ServiceUnavailable'),
        },
      },
    },
    '/ranks': {
      get: {
        tags: ['Catalogue'],
        summary: 'Paliers de rang (0 à 11)',
        responses: {
          '200': {
            description: 'Paliers, sans meta',
            content: json({
              type: 'object',
              required: ['items'],
              properties: { items: { type: 'array', items: ref('RankTier') } },
            }),
          },
          '429': response('RateLimited'),
          '503': response('ServiceUnavailable'),
        },
      },
    },
    '/map': {
      get: {
        tags: ['Catalogue'],
        summary: 'Images de la carte',
        responses: {
          '200': {
            description: 'URLs, sans meta',
            content: json({
              type: 'object',
              required: ['minimap', 'tunnels', 'frame'],
              properties: {
                minimap: { type: 'string' },
                tunnels: nullable('string'),
                frame: nullable('string'),
              },
            }),
          },
          '429': response('RateLimited'),
          '503': response('ServiceUnavailable'),
        },
      },
    },

    '/tracked-players': {
      get: {
        tags: ['Suivis'],
        summary: 'Lister mes suivis',
        description:
          'Uniquement ceux du compte authentifié, du plus récemment modifié au plus ancien.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Liste (vide : `{ "items": [] }`)',
            content: json(
              {
                type: 'object',
                required: ['items'],
                properties: { items: { type: 'array', items: ref('TrackedPlayer') } },
              },
              { items: [trackedExample] },
            ),
          },
          '401': response('Unauthorized'),
          '429': response('RateLimited'),
        },
      },
      post: {
        tags: ['Suivis'],
        summary: 'Suivre un joueur',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json(ref('TrackedPlayerCreate'), {
            steamId: '76561198000000000',
            alias: 'Duo régulier',
            note: 'Joue souvent en classé',
            tags: ['duo', 'ranked'],
          }),
        },
        responses: {
          '201': { description: 'Suivi créé', content: json(ref('TrackedPlayer'), trackedExample) },
          '400': response('BadRequest'),
          '401': response('Unauthorized'),
          '409': errorResponse(
            'Joueur déjà suivi par ce compte',
            'ALREADY_TRACKED',
            'Ce joueur est déjà dans votre liste.',
          ),
          '429': response('RateLimited'),
        },
      },
    },
    '/tracked-players/{id}': {
      parameters: [trackedIdParam],
      get: {
        tags: ['Suivis'],
        summary: 'Consulter un suivi',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Suivi', content: json(ref('TrackedPlayer'), trackedExample) },
          '400': response('BadRequest'),
          '401': response('Unauthorized'),
          '404': response('NotFound'),
          '429': response('RateLimited'),
        },
      },
      patch: {
        tags: ['Suivis'],
        summary: 'Modifier un suivi (partiel)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: json(ref('TrackedPlayerUpdate'), { note: 'Analyse mise à jour' }),
        },
        responses: {
          '200': { description: 'Suivi modifié', content: json(ref('TrackedPlayer')) },
          '400': response('BadRequest'),
          '401': response('Unauthorized'),
          '404': response('NotFound'),
          '429': response('RateLimited'),
        },
      },
      delete: {
        tags: ['Suivis'],
        summary: 'Supprimer un suivi',
        security: [{ bearerAuth: [] }],
        responses: {
          '204': { description: 'Supprimé, sans corps' },
          '400': response('BadRequest'),
          '401': response('Unauthorized'),
          '404': response('NotFound'),
          '429': response('RateLimited'),
        },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT HS256 obtenu via la connexion Steam (`#token=` au retour).',
      },
    },
    responses: {
      BadRequest: errorResponse(
        'Entrée invalide (champ, identifiant, JSON, PATCH vide…)',
        'INVALID_INPUT',
        'tags : 10 tags maximum',
      ),
      Unauthorized: errorResponse(
        'Jeton absent, invalide ou expiré',
        'UNAUTHORIZED',
        'Session absente ou expirée.',
      ),
      NotFound: errorResponse(
        "Ressource absente ou appartenant à un autre compte (pas de divulgation d'existence)",
        'NOT_FOUND',
        'Ressource introuvable.',
      ),
      RateLimited: {
        ...errorResponse(
          'Trop de requêtes',
          'RATE_LIMITED',
          'Trop de requêtes, réessayez dans quelques instants.',
        ),
        headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Secondes' } },
      },
      UpstreamError: errorResponse(
        'Réponse inexploitable du fournisseur de statistiques',
        'UPSTREAM_ERROR',
        'Réponse inexploitable du fournisseur de statistiques.',
      ),
      ServiceUnavailable: {
        ...errorResponse(
          'Fournisseur de statistiques indisponible et aucune copie en cache',
          'SERVICE_UNAVAILABLE',
          'Les statistiques sont temporairement indisponibles.',
        ),
        headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Secondes' } },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'INVALID_INPUT',
                  'UNAUTHORIZED',
                  'NOT_FOUND',
                  'ALREADY_TRACKED',
                  'RATE_LIMITED',
                  'UPSTREAM_ERROR',
                  'SERVICE_UNAVAILABLE',
                  'INTERNAL_ERROR',
                ],
              },
              message: { type: 'string' },
            },
          },
        },
      },
      DataMeta: {
        type: 'object',
        required: ['fetchedAt', 'sourceUpdatedAt', 'isStale', 'isPartial'],
        properties: {
          fetchedAt: { type: 'string', format: 'date-time', description: 'Date de collecte' },
          sourceUpdatedAt: nullable('string', { format: 'date-time' }),
          isStale: { type: 'boolean', description: 'Copie en cache servie faute de fournisseur' },
          isPartial: { type: 'boolean', description: 'Une partie des données est indisponible' },
        },
      },
      PublicUser: {
        type: 'object',
        required: ['id', 'steamId', 'displayName', 'avatarUrl'],
        properties: {
          id: { type: 'string' },
          steamId: { type: 'string', pattern: '^\\d{17}$' },
          displayName: { type: 'string', description: 'Pseudo Steam (repli : le steamId)' },
          avatarUrl: nullable('string', { format: 'uri' }),
        },
      },
      PlayerSummary: {
        type: 'object',
        required: ['steamId', 'accountId', 'displayName', 'avatarUrl'],
        properties: {
          steamId: { type: 'string', pattern: '^\\d{17}$' },
          accountId: { type: 'integer', description: 'SteamID3 (32 bits)' },
          displayName: { type: 'string' },
          avatarUrl: nullable('string', { format: 'uri' }),
        },
      },
      PlayerSearchResult: {
        type: 'object',
        required: ['items', 'meta'],
        properties: {
          items: { type: 'array', items: ref('PlayerSummary') },
          meta: ref('DataMeta'),
        },
      },
      PlayerStats: {
        type: 'object',
        description: 'Agrégats sur les parties disponibles ; `null` si inconnu.',
        required: [
          'matchesPlayed',
          'wins',
          'losses',
          'winRate',
          'kills',
          'deaths',
          'assists',
          'kda',
        ],
        properties: {
          matchesPlayed: nullable('integer'),
          wins: nullable('integer'),
          losses: nullable('integer'),
          winRate: nullable('number', { description: 'En %, 2 décimales' }),
          kills: nullable('integer'),
          deaths: nullable('integer'),
          assists: nullable('integer'),
          kda: nullable('number', { description: '(K + A) / max(D, 1), 2 décimales' }),
        },
      },
      PlayerProfile: {
        type: 'object',
        required: ['player', 'stats', 'rank', 'meta'],
        properties: {
          player: {
            allOf: [
              ref('PlayerSummary'),
              {
                type: 'object',
                properties: {
                  region: nullable('string', { description: 'Code pays Steam (ex. FR)' }),
                },
              },
            ],
          },
          stats: ref('PlayerStats'),
          rank: ref('PlayerRank'),
          meta: ref('DataMeta'),
        },
      },
      PlayerRank: {
        type: 'object',
        description:
          'Rang issu de la partie classée la plus récente (`ranked_display_badge`). ' +
          'Tout à `null` si aucune partie classée connue.',
        required: ['badgeId', 'name', 'tier', 'subrank', 'imageUrl', 'color'],
        properties: {
          badgeId: nullable('integer', { description: '`tier * 10 + subrank` (ex. 113)' }),
          name: nullable('string', { example: 'Éternus 3' }),
          tier: nullable('integer', { minimum: 0, maximum: 11 }),
          subrank: nullable('integer', { minimum: 1, maximum: 6 }),
          imageUrl: nullable('string', { format: 'uri' }),
          color: nullable('string', { example: '#5CE9A9' }),
        },
      },
      RankTier: {
        type: 'object',
        required: ['tier', 'name', 'color', 'imageUrl', 'subranks'],
        properties: {
          tier: { type: 'integer', minimum: 0, maximum: 11 },
          name: { type: 'string', example: 'Éternus' },
          color: { type: 'string' },
          imageUrl: { type: 'string', format: 'uri' },
          subranks: {
            type: 'array',
            minItems: 6,
            maxItems: 6,
            description: 'Images des sous-rangs 1 à 6 (index 0 = sous-rang 1)',
            items: nullable('string', { format: 'uri' }),
          },
        },
      },
      HeroImages: {
        type: 'object',
        required: ['card', 'small', 'vertical', 'background', 'name'],
        properties: {
          card: { type: 'string' },
          small: { type: 'string' },
          vertical: { type: 'string' },
          background: { type: 'string' },
          name: nullable('string'),
        },
      },
      HeroSummary: {
        type: 'object',
        required: ['id', 'name', 'role', 'gunTag', 'complexity', 'tags', 'color', 'images'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          role: { type: 'string', enum: ['assassin', 'brawler', 'marksman', 'mystic', 'healer'] },
          gunTag: nullable('string'),
          complexity: nullable('integer'),
          tags: { type: 'array', items: { type: 'string' } },
          color: { type: 'string', description: 'Couleur d’accent hexadécimale' },
          images: ref('HeroImages'),
        },
      },
      HeroDetail: {
        allOf: [
          ref('HeroSummary'),
          {
            type: 'object',
            required: ['lore', 'stats', 'abilities'],
            properties: {
              lore: { type: 'string' },
              stats: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['key', 'label', 'value'],
                  properties: {
                    key: { type: 'string' },
                    label: { type: 'string' },
                    value: { type: 'number' },
                  },
                },
              },
              abilities: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'name', 'imageUrl', 'type', 'description', 'cooldownSeconds'],
                  properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    imageUrl: nullable('string'),
                    type: { type: 'string', enum: ['signature', 'ultimate'] },
                    description: { type: 'string' },
                    cooldownSeconds: nullable('number'),
                  },
                },
              },
            },
          },
        ],
      },
      MatchSummary: {
        type: 'object',
        required: [
          'matchId',
          'playedAt',
          'heroId',
          'heroName',
          'heroImageUrl',
          'outcome',
          'durationSeconds',
          'kills',
          'deaths',
          'assists',
          'netWorth',
        ],
        properties: {
          matchId: { type: 'string' },
          playedAt: { type: 'string', format: 'date-time' },
          heroId: { type: 'integer' },
          heroName: {
            type: 'string',
            description: 'Repli `Héros #<id>` si catalogue indisponible',
          },
          heroImageUrl: nullable('string', { description: 'Portrait (null sans catalogue)' }),
          outcome: { type: 'string', enum: ['win', 'loss'] },
          durationSeconds: nullable('integer'),
          kills: nullable('integer'),
          deaths: nullable('integer'),
          assists: nullable('integer'),
          netWorth: nullable('integer'),
        },
      },
      MatchPage: {
        type: 'object',
        required: ['items', 'nextCursor', 'meta'],
        properties: {
          items: { type: 'array', items: ref('MatchSummary') },
          nextCursor: nullable('string'),
          meta: ref('DataMeta'),
        },
      },
      TrackedPlayer: {
        type: 'object',
        required: ['id', 'steamId', 'alias', 'note', 'tags', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          steamId: { type: 'string', pattern: '^\\d{17}$' },
          alias: { type: 'string' },
          note: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      TrackedPlayerCreate: {
        type: 'object',
        required: ['steamId'],
        additionalProperties: false,
        properties: {
          steamId: { type: 'string', pattern: '^\\d{17}$' },
          alias: { type: 'string', maxLength: 80, description: 'Trim appliqué' },
          note: { type: 'string', maxLength: 1000, description: 'Trim appliqué' },
          tags: {
            type: 'array',
            maxItems: 10,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 24 },
          },
        },
      },
      TrackedPlayerUpdate: {
        type: 'object',
        minProperties: 1,
        additionalProperties: false,
        description: '`steamId`, `id`, `ownerId` et dates sont refusés (400).',
        properties: {
          alias: { type: 'string', maxLength: 80 },
          note: { type: 'string', maxLength: 1000 },
          tags: {
            type: 'array',
            maxItems: 10,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 24 },
          },
        },
      },
    },
  },
};
