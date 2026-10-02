/**
 * Keeps apps/web-next/public/openapi.json (served at /openapi.json, the file
 * Postman/n8n import) in sync with the endpoint list the public docs page
 * renders. Regenerate with `npx tsx apps/api/tools/generate-openapi.ts`
 * whenever this fails after adding or removing a route.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_INDEX, ENDPOINT_TOTAL } from '../../web-next/src/app/api-reference/endpoint-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, '../../web-next/public/openapi.json');

function loadSpec(): any {
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
}

describe('openapi.json', () => {
  it('exists and is valid JSON', () => {
    expect(() => loadSpec()).not.toThrow();
  });

  it('declares both auth schemes Avise keys support', () => {
    const spec = loadSpec();
    expect(Object.keys(spec.components.securitySchemes)).toEqual(
      expect.arrayContaining(['bearerAuth', 'apiKeyHeader']),
    );
    expect(spec.security).toEqual(
      expect.arrayContaining([{ bearerAuth: [] }, { apiKeyHeader: [] }]),
    );
  });

  it('has exactly one operation per endpoint in ENDPOINT_INDEX — regenerate if this fails', () => {
    const spec = loadSpec();
    const operationCount = Object.values(spec.paths as Record<string, Record<string, unknown>>)
      .reduce((n, methods) => n + Object.keys(methods).length, 0);
    expect(operationCount).toBe(ENDPOINT_TOTAL);
  });

  it('every endpoint in ENDPOINT_INDEX has a matching OpenAPI operation', () => {
    const spec = loadSpec();
    const missing: string[] = [];
    for (const group of ENDPOINT_INDEX) {
      for (const [method, path] of group.endpoints) {
        const openApiPath = path.replace(/:([a-zA-Z0-9]+)/g, '{$1}');
        if (!spec.paths[openApiPath]?.[method.toLowerCase()]) missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('declares every path parameter as a required string parameter', () => {
    const spec = loadSpec();
    for (const [path, methods] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
      const names = [...path.matchAll(/\{([a-zA-Z0-9]+)\}/g)].map((m) => m[1]);
      if (!names.length) continue;
      for (const op of Object.values(methods)) {
        const declared = (op.parameters ?? []).map((p: { name: string }) => p.name);
        expect(declared).toEqual(expect.arrayContaining(names));
        for (const p of op.parameters ?? []) {
          if (names.includes(p.name)) {
            expect(p).toMatchObject({ in: 'path', required: true });
            expect(typeof p.description).toBe('string');
          }
        }
      }
    }
  });

  it('every operation has a responses object with at least one success and 401', () => {
    const spec = loadSpec();
    for (const methods of Object.values(spec.paths as Record<string, Record<string, any>>)) {
      for (const op of Object.values(methods)) {
        expect(op.responses).toBeTruthy();
        expect(op.responses['401']).toBeTruthy();
        const successCodes = Object.keys(op.responses).filter((c) => c.startsWith('2'));
        expect(successCodes.length).toBeGreaterThan(0);
      }
    }
  });
});
