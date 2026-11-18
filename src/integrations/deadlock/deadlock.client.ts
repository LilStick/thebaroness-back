import type { Logger } from 'pino';
import type { z } from 'zod';
import { AppError, type UpstreamReason } from '../../shared/errors';

export interface DeadlockClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch: typeof fetch;
  logger: Logger;
  /** Délai maximal d'une requête sortante. */
  timeoutMs?: number;
  /** Requêtes simultanées maximales vers le fournisseur. */
  maxConcurrent?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

const unavailable = (reason: UpstreamReason, retryAfter?: number) =>
  new AppError(
    503,
    'SERVICE_UNAVAILABLE',
    'Les statistiques sont temporairement indisponibles.',
    retryAfter,
    reason,
  );
const upstreamError = () =>
  new AppError(502, 'UPSTREAM_ERROR', 'Réponse inexploitable du fournisseur de statistiques.');

/** Route d'un chemin pour les quotas : `/v1/players/123/match-history` → `/v1/players/:id/match-history`. */
export const routeOf = (pathname: string) => pathname.replace(/\/\d+(?=\/|$)/g, '/:id');

/** `Retry-After` en secondes (entier ou date HTTP), borné à 1 h. */
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - now) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : undefined;
}

/**
 * Point d'accès unique à Deadlock API (§9.1) :
 * - timeout explicite ; erreurs traduites en 502 `UPSTREAM_ERROR` / 503 `SERVICE_UNAVAILABLE` ;
 * - déduplication des requêtes identiques en cours ;
 * - limite de concurrence (file d'attente FIFO) ;
 * - après un 429/503/504 avec `Retry-After`, échec immédiat jusqu'à l'échéance pour la même route
 *   (pas de martelage). Les quotas de Deadlock API sont par route (`ratelimit-*` constatés le
 *   18/11/2026 : `/v1/players/rank` épuisé pendant que la recherche répondait 200) ;
 * - validation Zod des réponses : aucun modèle brut non vérifié ne sort du client ;
 * - la clé API éventuelle reste côté serveur et n'apparaît dans aucune erreur.
 */
export class DeadlockClient {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  /** Échéance de blocage par route (segments numériques remplacés par `:id`). */
  private readonly blockedUntil = new Map<string, { until: number; reason: UpstreamReason }>();
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;

  constructor(private readonly options: DeadlockClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 6_000;
    this.maxConcurrent = options.maxConcurrent ?? 8;
  }

  /**
   * GET JSON validé par `schema`. Renvoie `null` si le fournisseur répond 404.
   * `timeoutMs` remplace le délai par défaut pour les requêtes lourdes (lots).
   */
  get<S extends z.ZodType>(
    path: string,
    query: Query,
    schema: S,
    { timeoutMs = this.timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<z.output<S> | null> {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.sort();
    const key = url.toString();

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<z.output<S> | null>;

    const promise = this.schedule(() => this.request(url, schema, timeoutMs)).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async schedule<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private async request<S extends z.ZodType>(
    url: URL,
    schema: S,
    timeoutMs: number,
  ): Promise<z.output<S> | null> {
    const now = Date.now();
    const route = routeOf(url.pathname);
    const block = this.blockedUntil.get(route);
    if (block && now < block.until) throw unavailable(block.reason, (block.until - now) / 1000);

    const { logger } = this.options;
    const log = { path: url.pathname };
    let res: Response;
    try {
      res = await this.options.fetch(url, {
        headers: {
          accept: 'application/json',
          ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      logger.warn({ ...log, err: name }, 'Deadlock API injoignable');
      throw unavailable(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable',
      );
    }

    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status === 429 || res.status === 503 || res.status === 504) {
      await res.body?.cancel();
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), Date.now());
      const reason: UpstreamReason = res.status === 429 ? 'rate_limited' : 'unavailable';
      if (retryAfter)
        this.blockedUntil.set(route, { until: Date.now() + retryAfter * 1000, reason });
      logger.warn({ ...log, status: res.status, retryAfter }, 'Deadlock API indisponible');
      throw unavailable(reason, retryAfter);
    }
    if (!res.ok) {
      await res.body?.cancel();
      logger.error({ ...log, status: res.status }, 'Deadlock API en erreur');
      throw upstreamError();
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      logger.error(log, 'Deadlock API : JSON invalide');
      throw upstreamError();
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      logger.error({ ...log, issue: parsed.error.issues[0] }, 'Deadlock API : format inattendu');
      throw upstreamError();
    }
    return parsed.data;
  }
}
