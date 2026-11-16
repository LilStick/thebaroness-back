import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

/**
 * Journal d'accès structuré (NF-09). Sérialiseurs minimaux et explicites :
 * - chemin **sans query string** (le callback Steam y porte l'assertion OpenID) ;
 * - aucun en-tête (ni `Authorization`, ni `Location` qui contient le JWT en fragment) ;
 * - identifiant de requête renvoyé dans `X-Request-Id` pour corréler une erreur.
 */
export function httpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: {
      req: (req: IncomingMessage & { id?: string }) => ({
        id: req.id,
        method: req.method,
        path: req.url?.split('?')[0],
      }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    // La santé est sondée en boucle par Docker : inutile de la journaliser.
    autoLogging: { ignore: (req) => req.url === '/api/health' },
  });
}
