/**
 * The contact panel's "Summarize emails" called GET /contacts/:id/email-summary,
 * which no route served. The UI treated the 404 as "No summary available",
 * so the feature never worked even with Gmail connected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const calls: unknown[][] = [];
let summarize: () => Promise<unknown> = async () => ({});
vi.mock('../src/services/gmailContactsService.js', () => ({
  getContactEmailSummary: (...args: unknown[]) => { calls.push(args); return summarize(); },
  scanCorrespondents: async () => ({}),
}));
vi.mock('../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1' }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

async function buildApp() {
  const { default: router } = await import('../src/routes/contacts.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'auth-1', organizationId: 'org-1' }; next(); });
  app.use('/api/contacts', router);
  return app;
}

beforeEach(() => { calls.length = 0; });

describe('GET /api/contacts/:id/email-summary', () => {
  it("returns the org-scoped summary for the signed-in user's Gmail", async () => {
    const summary = { connected: true, threadCount: 3, lastContact: '2026-09-20', summary: 'Discussed LOI terms.', highlights: ['Sent LOI'] };
    summarize = async () => summary;
    const res = await request(await buildApp()).get('/api/contacts/c-1/email-summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(summary);
    expect(calls).toEqual([['org-1', 'c-1', 'auth-1']]);
  });

  it('returns a readable error when the summary fails', async () => {
    summarize = async () => { throw new Error('gmail unavailable'); };
    const res = await request(await buildApp()).get('/api/contacts/c-1/email-summary');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not summarize emails right now. Please try again.');
  });
});
