/**
 * PROD REGRESSION (found 2026-09-01): every /api/cron/* route in the AI
 * bundle was silently dead in production, and had been for months.
 *
 * Two independent defects stacked:
 *
 *   1. ORDERING. app-ai.ts and app.ts mount several protected routers with
 *      the bare '/api' prefix (`app.use('/api', authMiddleware, ...)`).
 *      Express runs those handlers for ANY /api/* path registered AFTER
 *      them — including /api/cron/*. The cron mounts sat at the bottom of
 *      both files, so authMiddleware ran first. Vercel invokes crons with
 *      `Authorization: Bearer $CRON_SECRET`, which is not a Supabase JWT,
 *      so authMiddleware 401'd ("Invalid or expired token") and the cron
 *      body never executed. signal-scan, doc-request-reminders and
 *      reactivation had all been no-ops in prod.
 *
 *   2. BUNDLE PLACEMENT. pickBundle() routes ALL /api/cron/* to the AI
 *      bundle, but the three email-sweep crons added in PR #130 were
 *      mounted only in app-lite.ts. bundle-route-parity.test.ts passed
 *      (it only asserts "in app.ts => in lite OR ai"), so nothing caught it.
 *
 * These tests read source text (no app import) so they stay fast and
 * env-free, matching bundle-route-parity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

function lines(file: string): string[] {
  return readFileSync(path.join(srcDir, file), 'utf-8').split('\n');
}

/** Line indexes of every `app.use('/api/cron/...', ...)` mount. */
function cronMountLines(src: string[]): { line: number; path: string }[] {
  const out: { line: number; path: string }[] = [];
  src.forEach((text, i) => {
    const m = text.match(/^app\.use\('(\/api\/cron\/[a-z0-9-]+)'/);
    if (m) out.push({ line: i, path: m[1] });
  });
  return out;
}

/**
 * First line index of a bare-'/api' mount that runs authMiddleware. Anything
 * registered after this is auth-gated whether it means to be or not.
 */
function firstBareApiAuthMountLine(src: string[]): number {
  return src.findIndex((text) => /^app\.use\('\/api',\s*authMiddleware/.test(text));
}

describe('cron route mounting', () => {
  for (const file of ['app.ts', 'app-ai.ts']) {
    it(`${file}: every /api/cron mount is registered BEFORE the first bare-'/api' auth mount`, () => {
      const src = lines(file);
      const authLine = firstBareApiAuthMountLine(src);
      const crons = cronMountLines(src);

      expect(crons.length, `${file} should mount at least one cron router`).toBeGreaterThan(0);
      expect(authLine, `${file} should have a bare-'/api' auth mount to guard against`).toBeGreaterThan(-1);

      const tooLate = crons.filter((c) => c.line > authLine).map((c) => c.path);
      expect(
        tooLate,
        `${file}: these cron mounts sit AFTER authMiddleware on line ${authLine + 1} and will 401 ` +
          `before their CRON_SECRET check ever runs: ${tooLate.join(', ')}`,
      ).toEqual([]);
    });
  }

  it('every cron path scheduled in vercel.json is mounted in the AI bundle (pickBundle sends them there)', () => {
    const vercelJsonPath = path.join(srcDir, '../../../vercel.json');
    const vercel = JSON.parse(readFileSync(vercelJsonPath, 'utf-8')) as {
      crons?: { path: string }[];
    };
    const scheduled = (vercel.crons ?? [])
      .map((c) => c.path)
      .filter((p) => p.startsWith('/api/cron/'));

    expect(scheduled.length, 'vercel.json should schedule at least one /api/cron/* job').toBeGreaterThan(0);

    const mountedInAi = new Set(cronMountLines(lines('app-ai.ts')).map((c) => c.path));
    const missing = scheduled.filter((p) => !mountedInAi.has(p));

    expect(
      missing,
      `scheduled in vercel.json but NOT mounted in app-ai.ts — pickBundle routes all /api/cron/* ` +
        `to the AI bundle, so these will fail in production only: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('cron routers are not mounted in the lite bundle (pickBundle never routes there)', () => {
    const inLite = cronMountLines(lines('app-lite.ts')).map((c) => c.path);
    expect(
      inLite,
      `app-lite.ts mounts cron routers that pickBundle will never route to it: ${inLite.join(', ')}`,
    ).toEqual([]);
  });
});
