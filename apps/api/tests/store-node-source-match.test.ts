/**
 * computeSourceMatchAvg tests: confidence-scoring must not silently corrupt
 * claude-native-pdf extractions (no real text layer), while staying byte-
 * identical for legacy/claude-excel sources (real rawText available).
 */
import { describe, it, expect } from 'vitest';

async function getStoreNode() {
  return await import('../src/services/agents/financialAgent/nodes/storeNode.js');
}

function stmt(lineItems: Record<string, number | string | null>) {
  return [
    {
      statementType: 'INCOME_STATEMENT' as const,
      unitScale: 'MILLIONS' as const,
      currency: 'USD',
      periods: [{ period: '2023', periodType: 'HISTORICAL' as const, confidence: 90, lineItems }],
    },
  ];
}

describe('computeSourceMatchAvg', () => {
  it('uses real substring matching for non-claude-native-pdf rawText', async () => {
    const { computeSourceMatchAvg } = await getStoreNode();
    const rawText = 'The company reported Revenue of $45.2M in fiscal 2023.';
    const avg = computeSourceMatchAvg(stmt({ revenue: 45.2, revenue_source: 'Revenue of $45.2M' }), rawText);
    expect(avg).toBe(100); // exact substring match
  });

  it('scores a real quote as 75 (unverifiable but present) for claude-native-pdf rawText', async () => {
    const { computeSourceMatchAvg, CLAUDE_NATIVE_PDF_MARKER } = await getStoreNode();
    const rawText = `${CLAUDE_NATIVE_PDF_MARKER} cim.pdf — extracted via structured output; no text-layer dump`;
    const avg = computeSourceMatchAvg(stmt({ revenue: 45.2, revenue_source: 'Revenue of $45.2M' }), rawText);
    expect(avg).toBe(75);
  });

  it('scores a bare page marker as 20 (no real citation) for claude-native-pdf rawText', async () => {
    const { computeSourceMatchAvg, CLAUDE_NATIVE_PDF_MARKER } = await getStoreNode();
    const rawText = `${CLAUDE_NATIVE_PDF_MARKER} cim.pdf`;
    const avg = computeSourceMatchAvg(stmt({ revenue: 45.2, revenue_source: 'p12' }), rawText);
    expect(avg).toBe(20);
  });

  it('defaults to 20 when there are no _source fields or no rawText', async () => {
    const { computeSourceMatchAvg } = await getStoreNode();
    expect(computeSourceMatchAvg(stmt({ revenue: 45.2 }), 'some real text')).toBe(20);
    expect(computeSourceMatchAvg(stmt({ revenue: 45.2, revenue_source: 'Revenue' }), '')).toBe(20);
    expect(computeSourceMatchAvg([], 'some real text')).toBe(20);
  });
});
