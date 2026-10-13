/**
 * NDA review engine (spec §4.6) — mirrors dealScorecard's structure:
 * one structured-output call, raced timeout, persist then return.
 *
 * The grounding assertions here are the ones that matter: a fabricated
 * quote must survive as a FLAGGED finding, never as a clean one and never
 * as a silently dropped one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
const logWarn = vi.fn();
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: (...a: any[]) => logWarn(...a), error: vi.fn(), debug: vi.fn() },
}));

const trackedClaudeMessage = vi.fn();
class AIRefusalError extends Error {
  category: string | null;
  constructor(category: string | null) { super('refused'); this.name = 'AIRefusalError'; this.category = category; }
}
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
  AIRefusalError,
}));

let orgSettings: any = {};
let insertedReview: any = null;

const SOURCE_HTML = `
  <p>1. Term. This Agreement shall remain in effect for five (5) years from the Effective Date.</p>
  <p>2. Standstill. The Receiving Party shall not acquire any securities of the Disclosing Party for twenty-four (24) months.</p>
`;

function tableMock() {
  return (table: string) => {
    if (table === 'Organization') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: orgSettings }, error: null }) }) }) };
    }
    if (table === 'NdaReview') {
      return {
        insert: (row: any) => {
          insertedReview = row;
          return { select: () => ({ single: async () => ({ data: { id: 'rev-1', ...row }, error: null }) }) };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

function modelResponse(findings: any[], extra: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      riskLevel: 'HIGH',
      summary: 'Standstill and long term are the issues.',
      findings,
      ...extra,
    }),
    model: 'claude-fable-5',
    stopReason: 'end_turn',
    usage: { inputTokens: 1000, outputTokens: 500 },
  };
}

const goodFinding = {
  clauseKey: 'term', clauseTitle: 'Term of agreement', status: 'DEVIATION', severity: 'MEDIUM',
  quotedText: 'remain in effect for five (5) years',
  whyItMatters: 'Longer than our two-year position.',
  playbookPosition: 'Two years from signature.',
  suggestedLanguage: 'This Agreement shall terminate on the second anniversary.',
};

beforeEach(() => {
  vi.clearAllMocks();
  insertedReview = null;
  orgSettings = {};
  mockSupabase.from.mockImplementation(tableMock());
  trackedClaudeMessage.mockResolvedValue(modelResponse([goodFinding]));
});

async function loadEngine() {
  return import('../src/services/agents/ndaReview/index.js');
}

describe('reviewNda', () => {
  it('reviews against the default playbook when the firm has not configured one', async () => {
    const { reviewNda } = await loadEngine();
    const review = await reviewNda({
      orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf',
    });

    expect(review.findings).toHaveLength(1);
    expect(trackedClaudeMessage).toHaveBeenCalledTimes(1);
    const call = trackedClaudeMessage.mock.calls[0][0];
    expect(call.operation).toBe('nda_review');
    expect(call.outputSchema).toBeTruthy();
    // The playbook must reach the model, or the review is generic.
    expect(JSON.stringify(call.messages)).toContain('standstill');
  });

  it('prefers the firm’s own playbook when configured', async () => {
    orgSettings = {
      ndaPlaybook: {
        positions: [{ key: 'custom', label: 'Our bespoke clause', ourPosition: 'Never accept X', dealBreaker: true }],
        generalNotes: '',
      },
    };
    const { reviewNda } = await loadEngine();
    await reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' });

    const prompt = JSON.stringify(trackedClaudeMessage.mock.calls[0][0].messages);
    expect(prompt).toContain('Our bespoke clause');
  });

  it('sends the NDA text, not the raw HTML', async () => {
    const { reviewNda } = await loadEngine();
    await reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' });

    const prompt = JSON.stringify(trackedClaudeMessage.mock.calls[0][0].messages);
    expect(prompt).toContain('five (5) years');
    expect(prompt).not.toContain('<p>');
  });

  it('marks a verbatim quote as verified', async () => {
    const { reviewNda } = await loadEngine();
    const review = await reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' });
    expect(review.findings[0].quoteVerified).toBe(true);
  });

  it('FLAGS a fabricated quote instead of trusting it', async () => {
    trackedClaudeMessage.mockResolvedValue(
      modelResponse([{ ...goodFinding, quotedText: 'the Receiving Party waives all rights to sue' }]),
    );
    const { reviewNda } = await loadEngine();
    const review = await reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' });

    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].quoteVerified).toBe(false);
  });

  it('logs a warning for every unverified quote so the rate is monitorable', async () => {
    trackedClaudeMessage.mockResolvedValue(
      modelResponse([{ ...goodFinding, quotedText: 'entirely invented language' }]),
    );
    const { reviewNda } = await loadEngine();
    await reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' });

    expect(logWarn).toHaveBeenCalled();
    expect(JSON.stringify(logWarn.mock.calls)).toContain('term');
  });

  it('persists the review with the playbook snapshot for audit', async () => {
    const { reviewNda } = await loadEngine();
    await reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' });

    expect(insertedReview).toMatchObject({
      organizationId: 'org-1', dealId: 'deal-1', sourceFileName: 'nda.pdf', riskLevel: 'HIGH',
    });
    expect(insertedReview.playbookSnapshot).toBeTruthy();
    expect(insertedReview.sourceHtml).toContain('five (5) years');
    expect(insertedReview.model).toBe('claude-fable-5');
  });

  it('sorts the worst findings to the top', async () => {
    trackedClaudeMessage.mockResolvedValue(modelResponse([
      { ...goodFinding, clauseKey: 'a', status: 'ACCEPTABLE', severity: 'LOW', quotedText: '' },
      { ...goodFinding, clauseKey: 'b', status: 'DEAL_BREAKER', severity: 'HIGH', quotedText: '' },
      { ...goodFinding, clauseKey: 'c', status: 'DEVIATION', severity: 'MEDIUM', quotedText: '' },
      { ...goodFinding, clauseKey: 'd', status: 'MISSING', severity: 'LOW', quotedText: '' },
    ]));
    const { reviewNda } = await loadEngine();
    const review = await reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' });

    expect(review.findings.map((f) => f.status)).toEqual([
      'DEAL_BREAKER', 'DEVIATION', 'MISSING', 'ACCEPTABLE',
    ]);
  });

  it('surfaces a refusal as a refusal, not a 500', async () => {
    trackedClaudeMessage.mockRejectedValue(new AIRefusalError('legal_advice'));
    const { reviewNda } = await loadEngine();
    await expect(
      reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' }),
    ).rejects.toMatchObject({ name: 'AIRefusalError' });
  });

  it('budgets output: maxTokens with headroom, effort high, length limits in schema + prompt', async () => {
    const { reviewNda, NDA_REVIEW_MAX_TOKENS, NDA_OUTPUT_LIMITS } = await loadEngine();
    await reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' });

    const call = trackedClaudeMessage.mock.calls[0][0];
    expect(call.maxTokens).toBe(NDA_REVIEW_MAX_TOKENS);
    expect(NDA_REVIEW_MAX_TOKENS).toBeGreaterThan(16000); // 8K and 16K were both hit by high-effort thinking
    expect(call.effort).toBe('high');

    const item = call.outputSchema.properties.findings.items.properties;
    expect(item.suggestedLanguage.description).toContain(`${NDA_OUTPUT_LIMITS.suggestedLanguageWords} words`);
    expect(item.quotedText.description).toContain(`${NDA_OUTPUT_LIMITS.quotedTextWords} words`);
    expect(item.whyItMatters.description).toContain(`${NDA_OUTPUT_LIMITS.whyItMattersWords} words`);
    // Structured outputs reject string/array length keywords — limits live in descriptions.
    expect(JSON.stringify(call.outputSchema)).not.toMatch(/maxLength|maxItems/);
    // Every field the UI renders is still required.
    expect(call.outputSchema.properties.findings.items.required).toEqual([
      'clauseKey', 'clauseTitle', 'status', 'severity',
      'quotedText', 'whyItMatters', 'playbookPosition', 'suggestedLanguage',
    ]);
    expect(call.system).toContain(`At most ${NDA_OUTPUT_LIMITS.maxUnmappedFindings} of these`);
    expect(call.system).toContain(`at most ${NDA_OUTPUT_LIMITS.suggestedLanguageWords} words`);
  });

  it('fails clearly (TRUNCATED, 502) when the answer hits max_tokens — never parses or persists it', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: '{"riskLevel":"HIGH","summary":"Standstill and","findings":[{"clauseKey":"te',
      model: 'claude-sonnet-5',
      stopReason: 'max_tokens',
      usage: { inputTokens: 9000, outputTokens: 16000 },
    });
    const { reviewNda, NdaReviewError } = await loadEngine();
    const err = await reviewNda({
      orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(NdaReviewError);
    expect(err).toMatchObject({ code: 'TRUNCATED', status: 502 });
    expect(insertedReview).toBeNull();
  });

  it('turns unparseable output into INVALID_OUTPUT (502) instead of a JSON.parse 500', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: 'not json', model: 'claude-sonnet-5', stopReason: 'end_turn',
      usage: { inputTokens: 1000, outputTokens: 10 },
    });
    const { reviewNda } = await loadEngine();
    await expect(
      reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: SOURCE_HTML, sourceFileName: 'nda.pdf' }),
    ).rejects.toMatchObject({ name: 'NdaReviewError', code: 'INVALID_OUTPUT', status: 502 });
    expect(insertedReview).toBeNull();
  });

  it('rejects an empty document rather than reviewing nothing', async () => {
    const { reviewNda, NdaReviewError } = await loadEngine();
    await expect(
      reviewNda({ orgId: 'org-1', dealId: 'deal-1', sourceHtml: '   ', sourceFileName: 'blank.pdf' }),
    ).rejects.toBeInstanceOf(NdaReviewError);
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });
});
