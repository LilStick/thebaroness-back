import type { z } from 'zod';
import { invalidInput } from './errors';

/**
 * Valide `data` avec `schema` et renvoie la valeur typée,
 * ou lève une 400 `INVALID_INPUT` avec un message lisible (premier problème rencontré).
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue?.path.length ? `${issue.path.join('.')} : ` : '';
  throw invalidInput(`${path}${issue?.message ?? 'Données invalides.'}`);
}
