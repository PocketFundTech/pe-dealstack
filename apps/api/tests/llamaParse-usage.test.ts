import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const insertSpy = vi.fn(() => Promise.resolve({ data: null, error: null }));

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: insertSpy,
      select: vi.fn(() => Promise.resolve({ data: [], error: null })),
    })),
  },
}));

vi.mock('../src/services/usage/operationCredits.js', () => ({
  getCreditsForOperation: vi.fn(async () => 1),
}));

vi.mock('../src/services/auditLog.js', () => ({
  logAuditEvent: vi.fn(async () => {}),
  AUDIT_ACTIONS: { AI_INFERENCE: 'AI_INFERENCE' },
  RESOURCE_TYPES: { SETTINGS: 'SETTINGS' },
  SEVERITY: { INFO: 'INFO' },
}));

import { runWithUsageContext } from '../src/middleware/usageContext.js';

describe('llamaParse usage tracking', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.LLAMA_CLOUD_API_KEY;

  beforeEach(() => {
    insertSpy.mockClear();
    process.env.LLAMA_CLOUD_API_KEY = 'test-llama-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.LLAMA_CLOUD_API_KEY = originalKey;
  });

  it('records a per-page UsageEvent on a successful parse', async () => {
    let call = 0;
    global.fetch = vi.fn(async (url: string) => {
      call += 1;
      if (String(url).endsWith('/parsing/upload')) {
        return { ok: true, json: async () => ({ id: 'job-1' }) } as any;
      }
      if (String(url).includes('/parsing/job/job-1') && !String(url).endsWith('/result/markdown')) {
        return { ok: true, json: async () => ({ status: 'SUCCESS' }) } as any;
      }
      if (String(url).endsWith('/result/markdown')) {
        return { ok: true, json: async () => ({ markdown: '# Doc', job_metadata: { job_pages: 4 } }) } as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;

    const { parseWithLlama } = await import('../src/services/llamaParse.js');

    await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
      const result = await parseWithLlama(Buffer.from('pdf-bytes'), 'doc.pdf');
      expect(result).toEqual({ text: '# Doc', pages: 4 });
    });

    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.provider).toBe('llamaparse');
    expect(row.units).toBe(4);
    expect(Number(row.costUsd)).toBeCloseTo(4 * 0.003, 6);
    expect(row.status).toBe('success');
  });

  it('records a status-error UsageEvent when the upload step fails', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error',
    })) as any;

    const { parseWithLlama } = await import('../src/services/llamaParse.js');

    await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
      const result = await parseWithLlama(Buffer.from('pdf-bytes'), 'doc.pdf');
      expect(result).toBeNull();
    });

    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.provider).toBe('llamaparse');
    expect(row.units).toBe(0);
    expect(row.status).toBe('error');
    expect(row.metadata.stage).toBe('upload');
  });
});
