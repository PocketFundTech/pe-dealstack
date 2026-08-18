/**
 * PROD REGRESSION (2026-08-18, found by the authenticated QA pass):
 * POST /api/deals/:dealId/chat had TWO implementations. The
 * DEAL_CHAT_ENGINE-aware one (routes/deals-chat-ai.ts — SSE streaming,
 * financial-context tables, history caps) was mounted only in app-lite via
 * routes/deals.ts, but pickBundle sends /api/deals/:id/chat to the AI
 * bundle — where an older legacy-only duplicate in routes/ai.ts answered
 * instead. Every chat improvement shipped that week (streaming engine, the
 * 4-tool port, the schema + silent-error fixes) landed on a handler
 * production never executed for that path, while the flag read "on".
 *
 * Two invariants pinned here, by static source scan (fast, env-free):
 *   1. routes/ai.ts must NOT define POST /deals/:dealId/chat.
 *   2. app-ai.ts must mount routes/deals-chat-ai.ts, and must do so BEFORE
 *      routes/ai.ts (Express first-match wins), so a future duplicate can't
 *      shadow it even if it slips back in.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (rel: string) => readFileSync(path.join(srcDir, rel), 'utf-8');

describe('POST /api/deals/:dealId/chat has exactly one owner in the AI bundle', () => {
  it('routes/ai.ts does not define a competing /deals/:dealId/chat POST handler', () => {
    const src = read('routes/ai.ts');
    expect(src).not.toMatch(/router\.post\(\s*['"]\/deals\/:dealId\/chat['"]/);
  });

  it('routes/deals-chat-ai.ts is the owner (defines POST /:dealId/chat)', () => {
    const src = read('routes/deals-chat-ai.ts');
    expect(src).toMatch(/router\.post\(\s*['"]\/:dealId\/chat['"]/);
    // and it is the flag-aware one
    expect(src).toContain("process.env.DEAL_CHAT_ENGINE === 'streaming'");
  });

  it('app-ai.ts mounts deals-chat-ai BEFORE the generic aiRouter (first-match wins)', () => {
    const src = read('app-ai.ts');
    const mountDealsChat = src.search(/app\.use\(\s*['"]\/api\/deals['"][^\n]*dealsChatAiRouter\s*\)/);
    const mountAiRouter = src.search(/app\.use\(\s*['"]\/api['"][^\n]*\baiRouter\s*\)/);
    expect(mountDealsChat, 'dealsChatAiRouter must be mounted in app-ai.ts').toBeGreaterThan(-1);
    expect(mountAiRouter, 'aiRouter mount not found').toBeGreaterThan(-1);
    expect(mountDealsChat, 'dealsChatAiRouter must be mounted before aiRouter').toBeLessThan(mountAiRouter);
  });
});
