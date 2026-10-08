/**
 * The duplicate-check token lets the second step of an interactive intake
 * reuse the first step's AI extraction. It must only ever verify for the same
 * org, intake kind and source, within 30 minutes, untampered.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
const {
  signExtractionToken, verifyExtractionToken, hashContent, wantsDuplicateCheck, EXTRACTION_TOKEN_TTL_MS,
} = await import('../src/services/extractionToken.js');

const data = { companyName: { value: 'CSP', confidence: 90 }, summary: 'x'.repeat(5000) };
const hash = hashContent(Buffer.from('%PDF-1.4 file bytes'));
const sign = (over: Partial<Parameters<typeof signExtractionToken>[0]> = {}) =>
  signExtractionToken({ orgId: 'org-A', kind: 'upload', contentHash: hash, data, ...over });

describe('extraction token', () => {
  it('round-trips the extraction for the same org, kind and content', () => {
    const token = sign();
    expect(token.startsWith('v1.')).toBe(true);
    expect(verifyExtractionToken(token, { orgId: 'org-A', kind: 'upload', contentHash: hash })).toEqual(data);
  });

  it('is compressed (a repetitive 5KB payload stays small)', () => {
    expect(sign().length).toBeLessThan(1000);
  });

  it('rejects a tampered payload or signature', () => {
    const [v, payload, sig] = sign().split('.');
    const other = sign({ data: { companyName: { value: 'Evil', confidence: 99 } } }).split('.')[1];
    expect(verifyExtractionToken(`${v}.${other}.${sig}`, { orgId: 'org-A', kind: 'upload', contentHash: hash })).toBeNull();
    const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyExtractionToken(`${v}.${payload}.${flipped}`, { orgId: 'org-A', kind: 'upload', contentHash: hash })).toBeNull();
    expect(verifyExtractionToken('garbage', { orgId: 'org-A', kind: 'upload', contentHash: hash })).toBeNull();
    expect(verifyExtractionToken(undefined, { orgId: 'org-A', kind: 'upload', contentHash: hash })).toBeNull();
  });

  it('rejects another org', () => {
    expect(verifyExtractionToken(sign(), { orgId: 'org-B', kind: 'upload', contentHash: hash })).toBeNull();
  });

  it('rejects a different file / text / url', () => {
    expect(verifyExtractionToken(sign(), { orgId: 'org-A', kind: 'upload', contentHash: hashContent('other bytes') })).toBeNull();
  });

  it('rejects another intake kind', () => {
    expect(verifyExtractionToken(sign(), { orgId: 'org-A', kind: 'text', contentHash: hash })).toBeNull();
  });

  it('expires after 30 minutes', () => {
    const now = 1_000_000;
    const token = sign({ now });
    expect(verifyExtractionToken(token, { orgId: 'org-A', kind: 'upload', contentHash: hash, now: now + EXTRACTION_TOKEN_TTL_MS - 1 })).toEqual(data);
    expect(verifyExtractionToken(token, { orgId: 'org-A', kind: 'upload', contentHash: hash, now: now + EXTRACTION_TOKEN_TTL_MS + 1 })).toBeNull();
  });

  it('wantsDuplicateCheck accepts JSON true and the multipart string "true" only', () => {
    expect(wantsDuplicateCheck({ checkDuplicates: true })).toBe(true);
    expect(wantsDuplicateCheck({ checkDuplicates: 'true' })).toBe(true);
    expect(wantsDuplicateCheck({ checkDuplicates: false })).toBe(false);
    expect(wantsDuplicateCheck({})).toBe(false);
    expect(wantsDuplicateCheck(undefined)).toBe(false);
  });
});
