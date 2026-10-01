/**
 * The deal chat's get_analysis_summary printed QoE flags with f.label /
 * f.description, which don't exist on QoEFlag (title / detail), so every
 * flag reached the model as "- [critical] undefined: undefined".
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/supabase.js', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [{ id: 's1' }], error: null }) }) }) }) },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/services/analysis/customerConcentrationReader.js', () => ({ getConcentrationFacts: async () => null }));
vi.mock('../src/services/analysis/index.js', () => ({
  analyzeFinancials: async () => ({
    qoe: {
      score: 60,
      summary: 'Earnings quality needs review.',
      flags: [{ id: 'f1', severity: 'critical', category: 'customer', title: 'One Customer Is 39% of Revenue', detail: 'Top customer is also a part-owner.' }],
    },
  }),
}));

describe('get_analysis_summary', () => {
  it('prints each QoE flag with its title and detail', async () => {
    const { makeGetAnalysisSummaryTool } = await import('../src/services/agents/dealChatAgent/tools/getAnalysisSummary.js');
    const out = String(await makeGetAnalysisSummaryTool('deal-1', 'org-1').run());
    expect(out).toContain('- [critical] One Customer Is 39% of Revenue: Top customer is also a part-owner.');
    expect(out).not.toContain('undefined');
  });
});
