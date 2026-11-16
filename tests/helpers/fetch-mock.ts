/**
 * Faux `fetch` déterministe pour simuler Deadlock API (NF-11 : aucun appel réseau réel).
 * Chaque route associe un motif (méthode + chemin, regex) à une réponse ou à une fonction.
 */
export interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Délai avant réponse, en ms (pour simuler un upstream lent). */
  delayMs?: number;
  /** Lever une erreur réseau au lieu de répondre. */
  networkError?: boolean;
}

export type MockHandler = MockResponseInit | ((url: URL) => MockResponseInit);

export interface FetchMock {
  fetch: typeof fetch;
  /** URLs appelées, dans l'ordre. */
  calls: URL[];
  on(pathPattern: RegExp, handler: MockHandler): FetchMock;
  reset(): void;
}

export function createFetchMock(): FetchMock {
  const routes: Array<{ pattern: RegExp; handler: MockHandler }> = [];
  const calls: URL[] = [];

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url);
    const route = routes.find(({ pattern }) => pattern.test(url.pathname));
    if (!route) throw new Error(`fetch-mock : aucune route pour ${url.pathname}`);

    const res = typeof route.handler === 'function' ? route.handler(url) : route.handler;
    if (res.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, res.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      });
    }
    if (res.networkError) throw new TypeError('fetch failed');

    // Chaîne → corps texte brut (ex. réponse key-value de Steam) ; sinon JSON.
    const isText = typeof res.body === 'string';
    const body = res.body === undefined ? null : isText ? res.body : JSON.stringify(res.body);
    return new Response(body as string | null, {
      status: res.status ?? 200,
      headers: { 'content-type': isText ? 'text/plain' : 'application/json', ...res.headers },
    });
  };

  const mock: FetchMock = {
    fetch: fetchImpl as typeof fetch,
    calls,
    on(pattern, handler) {
      routes.push({ pattern, handler });
      return mock;
    },
    reset() {
      routes.length = 0;
      calls.length = 0;
    },
  };
  return mock;
}
