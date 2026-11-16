/**
 * Exporte le contrat OpenAPI dans docs/openapi.yaml (copie destinée au front, à SHA connu).
 * Usage : npm run openapi
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderOpenApiYaml } from './openapi-yaml';

const target = resolve(__dirname, '../docs/openapi.yaml');
writeFileSync(target, renderOpenApiYaml());
process.stdout.write(`Contrat OpenAPI écrit dans ${target}\n`);
