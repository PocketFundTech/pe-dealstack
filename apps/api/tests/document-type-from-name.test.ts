import { describe, it, expect } from 'vitest';
import { documentTypeFromName } from '../src/services/documentTypeFromName';

describe('documentTypeFromName', () => {
  it('does not treat "sta-nda-rd" as an NDA', () => {
    expect(documentTypeFromName('Standard CSP Master Customer Services Agreement - Template.pdf')).not.toBe('NDA');
  });
  it('does not treat "Process Letter" as an LOI', () => {
    expect(documentTypeFromName('CSP Process Letter Q3 2026.pdf')).not.toBe('LOI');
    expect(documentTypeFromName('CSP Process Letter Q3 2026.pdf', null, 'ingest')).not.toBe('LOI');
  });
  it('recognises real NDAs', () => {
    expect(documentTypeFromName('Mutual NDA.pdf')).toBe('NDA');
    expect(documentTypeFromName('Mutual_NDA.pdf')).toBe('NDA');
    expect(documentTypeFromName('Non-Disclosure Agreement.pdf')).toBe('NDA');
  });
  it('recognises real LOIs', () => {
    expect(documentTypeFromName('LOI - Project X.pdf')).toBe('LOI');
    expect(documentTypeFromName('Letter of Intent.pdf', null, 'ingest')).toBe('LOI');
  });
  it('does not treat "Addendum" as due diligence', () => {
    expect(documentTypeFromName('Addendum.pdf')).not.toBe('LEGAL');
    expect(documentTypeFromName('Addendum.pdf', null, 'ingest')).not.toBe('DD_REPORT');
  });
  it('recognises DD documents', () => {
    expect(documentTypeFromName('DD list.pdf')).toBe('LEGAL');
    expect(documentTypeFromName('Due Diligence Report.pdf', null, 'ingest')).toBe('DD_REPORT');
  });
  it('keeps CIM / teaser / financials rules', () => {
    expect(documentTypeFromName('Acme CIM.pdf')).toBe('CIM');
    expect(documentTypeFromName('Confidential Memo.pdf')).toBe('CIM');
    expect(documentTypeFromName('Teaser.pdf')).toBe('TEASER');
    expect(documentTypeFromName('Financial Model.pdf')).toBe('FINANCIALS');
    expect(documentTypeFromName('data.xlsx')).toBe('FINANCIALS');
    expect(documentTypeFromName('data', 'text/csv', 'ingest')).toBe('FINANCIALS');
    expect(documentTypeFromName('intro.msg')).toBe('EMAIL');
    expect(documentTypeFromName('random.pdf')).toBe('OTHER');
  });
});
