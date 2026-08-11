import { describe, it, expect } from 'vitest';
import {
  scoreDealSignals,
  priorityRank,
  LLM_EXTRACTION_GATE,
  PRIORITY_HIGH_MIN,
} from '../src/services/inboxDealSignals.js';

// Calibrated against the real sourcing transcripts in the deal-testing corpus
// (Pocket Fund "Spencer" drafts + "Project <name>" teasers). These are the
// emails the inbox scan MUST pick up; generic newsletters are what it must gate.

describe('scoreDealSignals — real sourcing emails score high priority', () => {
  it('scores a Project-teaser email (rich metrics + attachment) as high priority', () => {
    const result = scoreDealSignals({
      subject:
        'Project Anchor — Vertical SaaS Opportunity, $2.1M ARR, 91% Gross Retention (Confidential)',
      body: `Wanted to flag a deal that just came across our desk. ARR $2.1M, EBITDA $410K,
        gross margin 85%. Asking price: $3.6M-$4.0M (approximately 9-10x EBITDA). Founder is
        seeking partial liquidity. Process is off-market; no banker involved.`,
      attachmentNames: ['Project_Anchor_Financial_Model.xlsx'],
    });
    expect(result.priority).toBe('high');
    expect(result.score).toBeGreaterThanOrEqual(PRIORITY_HIGH_MIN);
    expect(result.signals.length).toBeGreaterThan(3);
  });

  it('scores a Pocket-Fund multi-deal email (MRR + multiple + one-pager) as high priority', () => {
    const result = scoreDealSignals({
      subject: "Here are this week's acquisition opportunities",
      body: `1. ipapi — Type: B2B SaaS. MRR: ~$23.5K. Asking Price: ~$1.2M. YoY Growth: 240%.
        2. Maglia — MRR: $18K-$25K. Asking Price: Approx. 6x EBITDA. Founder-led, bootstrapped.
        I've attached the one-pager for both these deals.`,
      attachmentNames: ['ipapi-one-pager.pdf'],
    });
    expect(result.priority).toBe('high');
    // The enumerated deals + MRR + asking price + multiple + founder all register.
    expect(result.signals).toContain('Recurring-revenue metric (MRR / ARR)');
  });
});

describe('scoreDealSignals — noise is gated out', () => {
  it('gates a generic newsletter that merely brushes a keyword', () => {
    const result = scoreDealSignals({
      subject: 'Your weekly product newsletter',
      body: 'Big news this week! Our new dashboard is now for sale in the app store. Enjoy.',
      attachmentNames: [],
    });
    expect(result.priority).toBe('low');
    expect(result.score).toBeLessThan(LLM_EXTRACTION_GATE);
  });

  it('gates an empty / contentless email', () => {
    const result = scoreDealSignals({ subject: 'Re: lunch', body: 'sounds good, see you at 1', attachmentNames: [] });
    expect(result.score).toBe(0);
    expect(result.priority).toBe('low');
  });
});

describe('scoreDealSignals — mechanics', () => {
  it('caps the score at 100 and sorts signals strongest-first', () => {
    const result = scoreDealSignals({
      subject: 'Acquisition opportunity — $5M ARR SaaS, asking price $20M, 4-6x EBITDA',
      body: 'MRR growing fast, EBITDA strong, gross margin 90%. Founder open to a full exit. Off-market.',
      attachmentNames: ['teaser.pdf', 'cap-table.xlsx'],
    });
    expect(result.score).toBeLessThanOrEqual(100);
    // Attachment is the heaviest single signal, so it leads the breakdown.
    expect(result.signals[0]).toMatch(/Deal document attached/);
  });

  it('priorityRank orders high < medium < low', () => {
    expect(priorityRank('high')).toBeLessThan(priorityRank('medium'));
    expect(priorityRank('medium')).toBeLessThan(priorityRank('low'));
  });
});
