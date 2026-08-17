/**
 * PROD REGRESSION (2026-08-14, D2–D4): six routers (deals-scorecard,
 * deals-share, portal, organization-criteria, cron-signal-scan,
 * managed-agents-webhooks) were mounted only in app.ts — the local-dev
 * server — and in NEITHER of the two serverless bundles (app-lite.ts /
 * app-ai.ts) that production actually runs. Every one of those endpoints
 * 404'd on lmmos.ai while local dev worked.
 *
 * This test pins the invariant: every route file imported by app.ts must be
 * imported by at least one production bundle. It reads source text (no app
 * imports) so it stays fast and env-free.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

function routeImports(file: string): Set<string> {
  const source = readFileSync(path.join(srcDir, file), 'utf-8');
  const found = new Set<string>();
  for (const match of source.matchAll(/from '\.\/routes\/([a-z0-9-]+)\.js'/g)) {
    found.add(match[1]);
  }
  return found;
}

describe('serverless bundle route parity', () => {
  it('every route file mounted in app.ts is present in app-lite.ts or app-ai.ts', () => {
    const appRoutes = routeImports('app.ts');
    const bundleRoutes = new Set([...routeImports('app-lite.ts'), ...routeImports('app-ai.ts')]);

    const missing = [...appRoutes].filter((r) => !bundleRoutes.has(r)).sort();
    expect(missing, `route files in app.ts but in NEITHER production bundle: ${missing.join(', ')}`).toEqual([]);
  });
});
