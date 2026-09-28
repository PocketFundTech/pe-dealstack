/**
 * trackedEmbeddings.ts model labeling (usage-cost-accuracy). The old
 * hardcoded EMBEDDING_MODEL constant ('text-embedding-004') had drifted from
 * the model rag.ts actually calls (`gemini-embedding-001`, env-overridable
 * via EMBEDDING_MODEL) — every embedding UsageEvent row was mislabeled.
 * Callers must now pass the real model; the module falls back to a
 * documented default label only when they don't.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recordUsageEvent } = vi.hoisted(() => ({ recordUsageEvent: vi.fn(async () => {}) }));
vi.mock('../../src/services/usage/trackedLLM.js', () => ({ recordUsageEvent }));

import { trackedEmbedDocuments, trackedEmbedQuery, EMBEDDING_PRICES } from '../../src/services/usage/trackedEmbeddings.js';

beforeEach(() => {
  recordUsageEvent.mockClear();
});

describe('trackedEmbedDocuments', () => {
  it('labels the row with the caller-supplied model', async () => {
    await trackedEmbedDocuments('gemini_embed_doc', ['a', 'bb'], async () => [1, 2], 'gemini-embedding-001');
    expect(recordUsageEvent.mock.calls[0][0]).toMatchObject({
      model: 'gemini-embedding-001',
      metadata: expect.objectContaining({ embeddingModel: 'gemini-embedding-001' }),
    });
  });

  it('respects an env-overridden model name rather than a stale constant', async () => {
    await trackedEmbedDocuments('gemini_embed_doc', ['a'], async () => [1], 'text-embedding-custom-v2');
    expect(recordUsageEvent.mock.calls[0][0].model).toBe('text-embedding-custom-v2');
  });

  it('falls back to the documented default label when the caller omits model', async () => {
    await trackedEmbedDocuments('gemini_embed_doc', ['a'], async () => [1]);
    expect(recordUsageEvent.mock.calls[0][0].model).toBe(EMBEDDING_PRICES.model);
  });

  it('still labels the row with the model on a failed embedding call', async () => {
    await expect(
      trackedEmbedDocuments('gemini_embed_doc', ['a'], async () => { throw new Error('rate limited'); }, 'gemini-embedding-001'),
    ).rejects.toThrow('rate limited');
    expect(recordUsageEvent.mock.calls[0][0]).toMatchObject({ model: 'gemini-embedding-001', status: 'error' });
  });
});

describe('trackedEmbedQuery', () => {
  it('labels the row with the caller-supplied model', async () => {
    await trackedEmbedQuery('gemini_embed_query', 'hello', async () => [0.1], 'gemini-embedding-001');
    expect(recordUsageEvent.mock.calls[0][0].model).toBe('gemini-embedding-001');
  });
});
