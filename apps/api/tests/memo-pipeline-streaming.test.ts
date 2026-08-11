/**
 * memoAgent/pipeline.ts — generateAllSectionsStreaming() tests (Phase 3-A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoContext } from '../src/services/agents/memoAgent/context.js';

const trackedClaudeMessage = vi.fn();
let anthropicAvailable = true;
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
  isAnthropicAvailable: () => anthropicAvailable,
}));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const captureAgentError = vi.fn();
vi.mock('../src/utils/sentryHelpers.js', () => ({
  captureAgentError: (...args: any[]) => captureAgentError(...args),
}));

const buildMemoContext = vi.fn();
vi.mock('../src/services/agents/memoAgent/context.js', async () => {
  const actual = await vi.importActual('../src/services/agents/memoAgent/context.js');
  return { ...actual, buildMemoContext: (...args: any[]) => buildMemoContext(...args) };
});

function fakeContext(): MemoContext {
  return {
    deal: { id: 'deal-1', name: 'Test Deal', stage: 'DUE_DILIGENCE', status: null, industry: null, revenue: 10, ebitda: 2, dealSize: null, irrProjected: null, mom: null, aiThesis: null, description: null, source: null },
    company: null,
    financials: [{ statementType: 'INCOME_STATEMENT', period: 'FY2023', lineItems: { Revenue: 10 }, extractionConfidence: 90, extractionSource: 'ai', isActive: true }],
    documents: [],
    activity: [],
    team: { leadPartner: null, analyst: null, members: [] },
    dataAvailability: { hasFinancials: true, hasDocuments: false, hasDetailedDocs: false, hasCIM: false },
  };
}

async function getPipeline() {
  return await import('../src/services/agents/memoAgent/pipeline.js');
}

// Two section types is enough to exercise a single batch (BATCH_SIZE=3)
// without the 2s inter-batch sleep slowing the test down.
const TWO_SECTIONS = ['EXECUTIVE_SUMMARY', 'RISK_ASSESSMENT'] as const;

function passingCritique() {
  return {
    text: JSON.stringify({
      overallPass: true,
      dimensions: [{ name: 'thesis_clarity', score: 4, pass: true }],
      sectionsNeedingRevision: [],
    }),
    model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
  };
}

beforeEach(() => {
  trackedClaudeMessage.mockReset();
  captureAgentError.mockReset();
  buildMemoContext.mockReset();
  buildMemoContext.mockResolvedValue(fakeContext());
  anthropicAvailable = true;
});

describe('generateAllSectionsStreaming', () => {
  it('yields section_start and section_complete for every section, then critique_start and done', async () => {
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        return { text: '<h3>x</h3><p>ok</p>', model: 'claude-sonnet-5' };
      }
      return passingCritique();
    });

    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS])) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'section_start')).toHaveLength(2);
    expect(types.filter((t) => t === 'section_complete')).toHaveLength(2);
    expect(types).toContain('critique_start');
    expect(types.filter((t) => t === 'section_revised')).toHaveLength(0); // critique passed
    expect(events[events.length - 1]).toMatchObject({ type: 'done' });
    expect(events[events.length - 1].sections).toHaveLength(2);
  });

  it('yields section_revised only for sections the critique actually changed', async () => {
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        return { text: '<h3>x</h3><p>original</p>', model: 'claude-sonnet-5' };
      }
      if (opts.operation === 'memo_critique') {
        return {
          text: JSON.stringify({
            overallPass: false,
            dimensions: [{ name: 'thesis_clarity', score: 2, pass: false, issue: 'weak' }],
            sectionsNeedingRevision: ['EXECUTIVE_SUMMARY'],
          }),
          model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      // memo_revise
      return {
        text: JSON.stringify({ revisedSections: [{ type: 'EXECUTIVE_SUMMARY', content: '<h3>x</h3><p>revised</p>' }] }),
        model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      };
    });

    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS])) {
      events.push(event);
    }

    const revised = events.filter((e) => e.type === 'section_revised');
    expect(revised).toHaveLength(1);
    expect(revised[0].sectionType).toBe('EXECUTIVE_SUMMARY');
    expect(revised[0].section.content).toContain('revised');
  });

  it('a failed section still yields a normal section_complete with placeholder content, not an error event', async () => {
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        throw new Error('Service unavailable');
      }
      return passingCritique();
    });

    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS])) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const completes = events.filter((e) => e.type === 'section_complete');
    expect(completes).toHaveLength(2);
    expect(completes[0].section.aiModel).toBe('error');
  });

  it('yields a single error event and nothing else when Anthropic is unavailable', async () => {
    anthropicAvailable = false;
    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS])) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'error', message: 'LLM is not available. Check API key configuration.' }]);
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });

  it('stops before starting more work once the signal is aborted', async () => {
    const controller = new AbortController();
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        controller.abort(); // simulate disconnect happening mid-batch
        return { text: '<h3>x</h3><p>ok</p>', model: 'claude-sonnet-5' };
      }
      return passingCritique();
    });

    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS], { signal: controller.signal })) {
      events.push(event);
    }

    // The in-flight batch still completes (already started, not cancelled
    // mid-flight) but critique/revise never runs after abort is observed.
    expect(events.some((e) => e.type === 'critique_start')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});

describe('generateAllSections (wrapper, Phase 2-C behavior preserved)', () => {
  it('returns the final sections and context from the done event', async () => {
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        return { text: '<h3>x</h3><p>ok</p>', model: 'claude-sonnet-5' };
      }
      return passingCritique();
    });
    const { generateAllSections } = await getPipeline();
    const result = await generateAllSections('deal-1', 'org-1', [...TWO_SECTIONS]);
    expect(result.sections).toHaveLength(2);
    expect(result.context).toBeDefined();
  });

  it('throws when Anthropic is unavailable, without calling trackedClaudeMessage', async () => {
    anthropicAvailable = false;
    const { generateAllSections } = await getPipeline();
    await expect(generateAllSections('deal-1', 'org-1')).rejects.toThrow('LLM is not available');
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });
});
