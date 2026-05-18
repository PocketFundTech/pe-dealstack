/**
 * AI Rate Limiter Tests
 *
 * Verifies that the 10 req/min AI rate limiter is mounted on every endpoint
 * that invokes a LangGraph agent or unrestrained LLM call. The general
 * 600/15min limiter is far too loose for endpoints that fan out into
 * 5-10 tool-calling GPT-4o requests per HTTP call.
 *
 * Approach: build a mini express app that mirrors the actual aiLimiter
 * mount pattern from src/app.ts, then drive 11 rapid requests at each
 * protected path and assert the 11th returns 429. Uses a fixed
 * Authorization header so every request hits the same rate-limit bucket
 * (matches the per-user keyGenerator in app.ts).
 *
 * Regression target: Phase 1 P0 — Task 4.1.
 *   POST /api/deals/:dealId/chat was only gated by the 600/15min general
 *   limiter, allowing one user to burn ~$300 of OpenAI spend in 15 min
 *   via the ReAct deal chat agent (up to 14 tools, 5-10 GPT-4o calls per
 *   message). Now bounded by the 10/min AI limiter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request } from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';

const FIXED_AUTH = 'Bearer test-token-rate-limit-bucket';

/**
 * Mirror src/app.ts:
 *   - rateLimitKeyGenerator: per-user bucket via Authorization header
 *   - aiLimiter: 10 req / 60s
 *   - mount paths must match what app.ts mounts (see line 178-181).
 */
function buildApp() {
  const app = express();
  app.set('trust proxy', 1);

  const rateLimitKeyGenerator = (req: Request) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return 'user:' + authHeader.slice(-16);
    }
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 'unknown';
  };

  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many AI requests, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
  });

  // ─── This block must mirror src/app.ts limiter mounts ────────────
  // If the test fails because the 11th request gets 200 not 429, the
  // path is NOT covered by aiLimiter in app.ts. Fix is to add the
  // matching app.use() in app.ts.
  app.use('/api/ai', aiLimiter);
  app.use('/api/memos/*/chat', aiLimiter);
  app.use('/api/memos/*/sections/*/generate', aiLimiter);
  app.use('/api/deals/*/chat', aiLimiter); // Phase 1 P0 Task 4.1

  // Stub handlers — we don't care what they return, only whether the
  // limiter fires before they execute.
  app.use(express.json());
  app.all('*', (_req, res) => res.json({ ok: true }));

  return app;
}

describe('AI rate limiter mount coverage', () => {
  let app: express.Express;

  beforeEach(() => {
    // Fresh app per test = fresh in-memory rate-limit store.
    app = buildApp();
  });

  // Helper: fire N sequential requests with the same auth header so
  // they all hit the same rate-limit bucket.
  async function fireN(path: string, n: number) {
    const responses: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await request(app)
        .post(path)
        .set('Authorization', FIXED_AUTH)
        .send({ message: 'hi' });
      responses.push(res.status);
    }
    return responses;
  }

  it('limits POST /api/ai/* (sanity — already-protected baseline)', async () => {
    const statuses = await fireN('/api/ai/enrich-contact', 11);
    expect(statuses.slice(0, 10).every(s => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('limits POST /api/memos/:id/chat (already-protected baseline)', async () => {
    const statuses = await fireN('/api/memos/memo-1/chat', 11);
    expect(statuses.slice(0, 10).every(s => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  // ─── Phase 1 P0 Task 4.1 regression test ─────────────────────────
  it('limits POST /api/deals/:dealId/chat — deal chat ReAct agent', async () => {
    const statuses = await fireN('/api/deals/deal-abc/chat', 11);
    expect(statuses.slice(0, 10).every(s => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('does NOT limit non-AI deal endpoints under the 10/min budget', async () => {
    // /api/deals/:id (no /chat suffix) is general-purpose CRUD and
    // must NOT trip the 10/min limiter — only the 600/15min general
    // limiter applies there. Sanity-check we didn't over-broaden.
    const statuses = await fireN('/api/deals/deal-abc', 11);
    expect(statuses.every(s => s === 200)).toBe(true);
  });
});

describe('src/app.ts limiter mount inspection', () => {
  /**
   * Whitebox check: read the actual source of src/app.ts and confirm
   * the path patterns we care about are mounted with aiLimiter. This
   * catches the case where someone deletes the limiter line in app.ts
   * but the supertest above still passes (because supertest is
   * exercising a parallel mini app).
   */
  it('app.ts mounts aiLimiter on the deal chat path', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const appTsPath = path.resolve(__dirname, '../src/app.ts');
    const source = await fs.readFile(appTsPath, 'utf-8');

    // Match the deals chat path mount in any of the common forms:
    //   app.use('/api/deals/*/chat', aiLimiter)
    //   app.use('/api/deals/:dealId/chat', aiLimiter)
    const dealsChatMount =
      /app\.use\(\s*['"`]\/api\/deals\/[^'"`]*chat['"`]\s*,\s*aiLimiter\s*\)/;
    expect(source).toMatch(dealsChatMount);
  });
});
