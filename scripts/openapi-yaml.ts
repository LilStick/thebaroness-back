import { stringify } from 'yaml';
import { OPENAPI_VERSION, openApiDocument } from '../src/docs/openapi';

export function renderOpenApiYaml(): string {
  const header =
    `# Généré depuis src/docs/openapi.ts (v${OPENAPI_VERSION}) par \`npm run openapi\`.\n` +
    '# Ne pas modifier à la main.\n';
  return header + stringify(openApiDocument, { lineWidth: 0, aliasDuplicateObjects: false });
}
