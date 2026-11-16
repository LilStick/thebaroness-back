import { z } from 'zod';

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET doit contenir au moins 32 caractères'),
  JWT_EXPIRES_IN: z
    .string()
    .regex(/^\d+(ms|s|m|h|d)?$/, 'JWT_EXPIRES_IN attend une durée du type 15m, 1h, 3600')
    .default('15m'),
  /** URL publique de l'API (sans /api), utilisée comme realm et return_to OpenID. */
  API_PUBLIC_URL: z.url().default('http://localhost:3001').transform(stripTrailingSlash),
  /** URL du front vers laquelle Steam renvoie l'utilisateur une fois authentifié. */
  FRONTEND_URL: z.url().default('http://localhost:5173').transform(stripTrailingSlash),
  /** Tentatives /api/auth/* autorisées par IP et par fenêtre de 15 min. */
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(60),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  DEADLOCK_API_BASE_URL: z.url().default('https://api.deadlock-api.com'),
  DEADLOCK_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Valide les variables d'environnement. Lève une erreur lisible (sans valeurs secrètes)
 * si la configuration est invalide, afin de refuser le démarrage.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration invalide :\n${details}`);
  }
  return result.data;
}
