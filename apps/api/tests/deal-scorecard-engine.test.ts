/**
 * services/agents/dealScorecard — scoreDeal engine tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackedClaudeMessage = vi.fn();
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const analyzeFinancials = vi.fn();
vi.mock('../src/services/analysis/index.js', () => ({
  analyzeFinancials: (...args: any[]) => analyzeFinancials(...args),
}));

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

let dealRow: any;
let statements: any[];
let orgSettings: Record<string, any>;
let persistedScorecard: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: dealRow, error: null }) }) }) }),
        update: (patch: any) => { persistedScorecard = patch.scorecard; return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
      };
    }
    if (table === 'FinancialStatement') {
      return { select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: statements, error: null }) }) }) }) };
    }
    if (table === 'Organization') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: orgSettings }, error: null }) }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

const CRITERIA = {
  sectorsInclude: ['Software'], sectorsExclude: [], dealSizeMin: 5, dealSizeMax: 15,
  revenueMin: null, revenueMax: null, ebitdaMin: 1, hardExclusions: ['startups'], thesis: 'Recurring revenue',
};

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      overallScore: 72, verdict: 'GO', qualityScore: 78, thesisFitScore: 66,
      reasons: [{ kind: 'hit', text: 'Within size range' }],
      ...overrides,
    }),
    model: 'claude-sonnet-5',
    stopReason: 'end_turn',
    usage: { inputTokens: 900, outputTokens: 150 },
  };
}

async function getEngine() {
  return await import('../src/services/agents/dealScorecard/index.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  persistedScorecard = null;
  dealRow = { id: 'deal-1', name: 'Acme', industry: 'Software', stage: 'INITIAL_REVIEW', revenue: 10, ebitda: 2, dealSize: 12, irrProjected: null, mom: null, description: null };
  statements = [{ statementType: 'INCOME_STATEMENT', period: 'FY2023', lineItems: { Revenue: 10 } }];
  orgSettings = { dealCriteria: CRITERIA };
  analyzeFinancials.mockResolvedValue({ redFlags: [{ severity: 'medium', title: 'Customer concentration' }] });
  mockSupabase.from.mockImplementation(tableMock());
  delete process.env.DEAL_SCORECARD_TIMEOUT_MS;
});

describe('scoreDeal', () => {
  it('produces and persists a schema-shaped scorecard with scoredAt and served model', async () => {
    trackedClaudeMessage.mockResolvedValue(verdict());
    const { scoreDeal } = await getEngine();
    const result = await scoreDeal('deal-1', 'org-1');

    expect(result.verdict).toBe('GO');
    expect(result.overallScore).toBe(72);
    expect(result.model).toBe('claude-sonnet-5');
    expect(typeof result.scoredAt).toBe('string');
    expect(persistedScorecard).toEqual(result);

    const call = trackedClaudeMessage.mock.calls[0][0];
    expect(call.operation).toBe('deal_scorecard');
    expect(call.role).toBe('chat');
    expect(call.outputSchema).toBeDefined();
    // Criteria and financial data both reach the prompt
    expect(call.messages[0].content).toContain('Recurring revenue');
    expect(call.messages[0].content).toContain('Customer concentration');
  });

  it('throws CRITERIA_NOT_CONFIGURED when the org has no dealCriteria', async () => {
    orgSettings = {};
    const { scoreDeal, CriteriaNotConfiguredError } = await getEngine();
    await expect(scoreDeal('deal-1', 'org-1')).rejects.toBeInstanceOf(CriteriaNotConfiguredError);
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });

  it('scores on metadata alone when no financials exist, without calling analyzeFinancials', async () => {
    statements = [];
    trackedClaudeMessage.mockResolvedValue(verdict());
    const { scoreDeal } = await getEngine();
    await scoreDeal('deal-1', 'org-1');
    expect(analyzeFinancials).not.toHaveBeenCalled();
    expect(trackedClaudeMessage.mock.calls[0][0].messages[0].content).toContain('No extracted financial statements');
  });

  it('throws (and persists nothing) when the deal is not in the org', async () => {
    dealRow = null;
    const { scoreDeal } = await getEngine();
    await expect(scoreDeal('deal-1', 'org-1')).rejects.toThrow('Deal not found');
    expect(persistedScorecard).toBeNull();
  });

  it('throws (and persists nothing) when the model call fails', async () => {
    trackedClaudeMessage.mockRejectedValue(new Error('boom'));
    const { scoreDeal } = await getEngine();
    await expect(scoreDeal('deal-1', 'org-1')).rejects.toThrow('boom');
    expect(persistedScorecard).toBeNull();
  });
});

describe('maybeScoreAfterExtraction', () => {
  it('runs scoreDeal when criteria exist', async () => {
    trackedClaudeMessage.mockResolvedValue(verdict());
    const { maybeScoreAfterExtraction } = await getEngine();
    await maybeScoreAfterExtraction('deal-1', 'org-1');
    expect(trackedClaudeMessage).toHaveBeenCalledTimes(1);
  });

  it('is a silent no-op when criteria are not configured', async () => {
    orgSettings = {};
    const { maybeScoreAfterExtraction } = await getEngine();
    await expect(maybeScoreAfterExtraction('deal-1', 'org-1')).resolves.toBeUndefined();
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });

  it('never throws even when scoring fails', async () => {
    trackedClaudeMessage.mockRejectedValue(new Error('boom'));
    const { maybeScoreAfterExtraction } = await getEngine();
    await expect(maybeScoreAfterExtraction('deal-1', 'org-1')).resolves.toBeUndefined();
  });
});
