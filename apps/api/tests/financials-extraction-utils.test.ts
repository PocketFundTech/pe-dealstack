/**
 * Tests for the human-readable error classification used by the multi-doc
 * financials/extract route. See financials-extraction-utils.ts.
 *
 * Prod incident (2026-09-28): both docs on a deal failed — one via a 120s
 * agent timeout, one via an Anthropic 400 "credit balance is too low" — and
 * the route swallowed both reasons, returning periodsStored: 0 with a
 * generic "No financial data found" toast. These tests lock in that the
 * real reason is surfaced instead.
 */
import { describe, it, expect } from 'vitest';
import { humanizeExtractionError, buildResultWarnings } from '../src/routes/financials-extraction-utils.js';

describe('humanizeExtractionError', () => {
  it('classifies an Anthropic credit-balance error as a billing message', () => {
    const msg = humanizeExtractionError('Your credit balance is too low to access the Anthropic API');
    expect(msg).toBe(
      'The AI provider account is out of credits. This is not a problem with your documents — contact your administrator.',
    );
  });

  it('classifies OpenAI insufficient_quota the same way', () => {
    const msg = humanizeExtractionError('insufficient_quota: You exceeded your current quota');
    expect(msg).toBe(
      'The AI provider account is out of credits. This is not a problem with your documents — contact your administrator.',
    );
  });

  it('classifies a per-doc agent timeout message', () => {
    const msg = humanizeExtractionError('Financial agent timed out after 120000ms');
    expect(msg).toBe('Extraction took too long and was stopped. Try again, or extract one document at a time.');
  });

  it('classifies the per-doc-budget timeout message the same way', () => {
    const msg = humanizeExtractionError('Extraction exceeded 240s per-doc budget');
    expect(msg).toBe('Extraction took too long and was stopped. Try again, or extract one document at a time.');
  });

  it('passes through an unrecognized error message unchanged', () => {
    const msg = humanizeExtractionError('Excel file appears empty or has no readable financial data');
    expect(msg).toBe('Excel file appears empty or has no readable financial data');
  });
});

describe('buildResultWarnings', () => {
  it('surfaces the real per-doc failure reason instead of staying silent', () => {
    const warnings = buildResultWarnings([
      {
        id: 'd1', name: 'Jantar_Energia_Financial_Model.xlsx', status: 'failed',
        error: 'Financial agent timed out after 120000ms', warnings: [],
      },
      {
        id: 'd2', name: 'Project_Bursztyn_CIM.pdf', status: 'failed',
        error: 'Your credit balance is too low to access the Anthropic API', warnings: [],
      },
    ] as any);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('Jantar_Energia_Financial_Model.xlsx');
    expect(warnings[0]).toContain('too long');
    expect(warnings[1]).toContain('Project_Bursztyn_CIM.pdf');
    expect(warnings[1]).toContain('out of credits');
  });

  it('does not prefix the document name when there is only one document', () => {
    const warnings = buildResultWarnings([
      { id: 'd1', name: 'solo.pdf', status: 'failed', error: 'Financial agent timed out after 120000ms', warnings: [] },
    ] as any);
    expect(warnings).toEqual(['Extraction took too long and was stopped. Try again, or extract one document at a time.']);
  });

  it('includes agent-level warnings from a completed doc alongside failure warnings from others', () => {
    const warnings = buildResultWarnings([
      { id: 'd1', name: 'ok.pdf', status: 'completed', warnings: ['No statement type CASH_FLOW found'] },
      { id: 'd2', name: 'bad.pdf', status: 'failed', error: 'Financial agent timed out after 120000ms', warnings: [] },
    ] as any);
    expect(warnings.some((w) => w.includes('CASH_FLOW'))).toBe(true);
    expect(warnings.some((w) => w.includes('too long'))).toBe(true);
  });

  it('returns an empty array when everything completed cleanly with no agent warnings', () => {
    const warnings = buildResultWarnings([
      { id: 'd1', name: 'ok.pdf', status: 'completed', warnings: [] },
    ] as any);
    expect(warnings).toEqual([]);
  });
});
