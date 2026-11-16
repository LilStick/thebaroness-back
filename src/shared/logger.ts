import pino, { type Logger } from 'pino';

/** Chemins jamais écrits dans les logs (§9.1, §13.1, NF-09). */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.password',
  '*.passwordHash',
  '*.token',
  'password',
  'passwordHash',
  'token',
];

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'thebaroness-back' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
