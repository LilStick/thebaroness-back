/**
 * Valide le contrat OpenAPI (structure 3.1 + références) et sa synchronisation avec
 * docs/openapi.yaml. Usage : npm run openapi:check (exécuté en CI).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { openApiDocument } from '../src/docs/openapi';
import { renderOpenApiYaml } from './openapi-yaml';

async function main(): Promise<void> {
  await SwaggerParser.validate(structuredClone(openApiDocument) as never);

  const committed = readFileSync(resolve(__dirname, '../docs/openapi.yaml'), 'utf8');
  if (committed !== renderOpenApiYaml()) {
    throw new Error('docs/openapi.yaml est désynchronisé : lancer `npm run openapi`.');
  }
  process.stdout.write(`OpenAPI ${openApiDocument.info.version} valide et synchronisé.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
