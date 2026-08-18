/**
 * NDA playbook — the firm's standing position on each clause (spec §4.4),
 * and the grounding verifier that keeps quoted language honest (§4.6).
 *
 * The grounding tests are the most important in this feature. An NDA review
 * that quotes language which isn't in the document is worse than no review:
 * it's a confident-sounding fabrication about a contract someone is about
 * to sign. Julian (M12) called exactly this behaviour trust-breaking.
 */
import { describe, it, expect } from 'vitest';
import {
  ndaPlaybookSchema,
  DEFAULT_NDA_PLAYBOOK,
} from '../src/services/ndaPlaybookDefaults.js';
import { verifyQuotes, htmlToPlainText } from '../src/services/agents/ndaReview/grounding.js';

describe('DEFAULT_NDA_PLAYBOOK', () => {
  it('parses against its own schema', () => {
    expect(() => ndaPlaybookSchema.parse(DEFAULT_NDA_PLAYBOOK)).not.toThrow();
  });

  it('covers the clauses a buy-side reviewer actually argues about', () => {
    const keys = DEFAULT_NDA_PLAYBOOK.positions.map((p) => p.key);
    for (const expected of [
      'term', 'confidentiality_period', 'non_solicit_employees',
      'non_circumvent', 'residuals', 'permitted_disclosures',
      'return_or_destruction', 'governing_law', 'standstill', 'no_obligation',
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it('gives every position a usable stated position', () => {
    for (const p of DEFAULT_NDA_PLAYBOOK.positions) {
      expect(p.ourPosition.length).toBeGreaterThan(10);
      expect(p.label.length).toBeGreaterThan(2);
    }
  });

  it('marks at least one position as a deal-breaker', () => {
    expect(DEFAULT_NDA_PLAYBOOK.positions.some((p) => p.dealBreaker)).toBe(true);
  });

  it('uses unique keys so findings map one-to-one', () => {
    const keys = DEFAULT_NDA_PLAYBOOK.positions.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('htmlToPlainText', () => {
  it('flattens markup so quotes can be matched against prose', () => {
    const text = htmlToPlainText('<p>The <strong>Receiving Party</strong> shall not disclose.</p>');
    expect(text).toContain('The Receiving Party shall not disclose.');
  });

  it('collapses whitespace introduced by block tags', () => {
    const text = htmlToPlainText('<p>one</p>\n\n   <p>two</p>');
    expect(text).toBe('one two');
  });

  it('decodes the entities the sanitiser produced', () => {
    expect(htmlToPlainText('<p>Buyer &amp; Co&rsquo;s duties</p>')).toContain("Buyer & Co’s duties");
  });
});

describe('verifyQuotes', () => {
  const source = `
    <p>1. Term. This Agreement shall remain in effect for five (5) years
    from the Effective Date.</p>
    <p>2. Non-Solicitation. The Receiving Party shall not solicit any
    employee of the Disclosing Party for a period of three (3) years.</p>
  `;

  it('passes a quote copied verbatim from the document', () => {
    const [finding] = verifyQuotes(
      [{ clauseKey: 'term', status: 'DEVIATION', quotedText: 'remain in effect for five (5) years' }],
      source,
    );
    expect(finding.quoteVerified).toBe(true);
  });

  it('tolerates whitespace and line-wrap differences', () => {
    // The model reflows the quote onto one line; that is not fabrication.
    const [finding] = verifyQuotes(
      [{ clauseKey: 'term', status: 'DEVIATION', quotedText: 'in effect for five (5) years from the Effective Date.' }],
      source,
    );
    expect(finding.quoteVerified).toBe(true);
  });

  it('FAILS a fabricated quote — the whole point of the check', () => {
    const [finding] = verifyQuotes(
      [{
        clauseKey: 'standstill',
        status: 'DEAL_BREAKER',
        quotedText: 'The Receiving Party agrees to a twelve (12) month standstill.',
      }],
      source,
    );
    expect(finding.quoteVerified).toBe(false);
  });

  it('fails a quote that subtly rewrites the document', () => {
    // "seven" instead of "five" — the kind of error that matters most and
    // is hardest to spot by eye.
    const [finding] = verifyQuotes(
      [{ clauseKey: 'term', status: 'DEVIATION', quotedText: 'remain in effect for seven (7) years' }],
      source,
    );
    expect(finding.quoteVerified).toBe(false);
  });

  it('does not demand a quote for a clause that is absent', () => {
    const [finding] = verifyQuotes(
      [{ clauseKey: 'standstill', status: 'MISSING', quotedText: '' }],
      source,
    );
    expect(finding.quoteVerified).toBe(true);
  });

  it('reports how many quotes failed, so the rate can be monitored', () => {
    const findings = verifyQuotes(
      [
        { clauseKey: 'term', status: 'DEVIATION', quotedText: 'five (5) years' },
        { clauseKey: 'x', status: 'DEVIATION', quotedText: 'not in the document at all' },
        { clauseKey: 'y', status: 'DEVIATION', quotedText: 'also invented' },
      ],
      source,
    );
    expect(findings.filter((f) => !f.quoteVerified)).toHaveLength(2);
  });

  it('keeps unverified findings rather than silently dropping them', () => {
    // Dropping would hide a model that is misbehaving. We keep the finding,
    // flag it, and let the UI suppress the quote.
    const findings = verifyQuotes(
      [{ clauseKey: 'term', status: 'DEVIATION', quotedText: 'invented' }],
      source,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].quoteVerified).toBe(false);
  });

  it('is case-insensitive about the quote but not about the content', () => {
    const [ok] = verifyQuotes(
      [{ clauseKey: 'term', status: 'DEVIATION', quotedText: 'REMAIN IN EFFECT FOR FIVE (5) YEARS' }],
      source,
    );
    expect(ok.quoteVerified).toBe(true);
  });
});
