import { describe, it, expect } from 'vitest';
import {
  financialSourceAuthorityRank,
  SOURCE_AUTHORITY,
} from '../src/services/financialSourceAuthority.js';

describe('financialSourceAuthorityRank', () => {
  it('ranks a financials spreadsheet above a CIM narrative (the InstateMe case)', () => {
    const pnl = { type: 'FINANCIALS', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'InstateMe_Financials.xlsx' };
    const cim = { type: 'CIM', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'InstateMe_CIM.docx' };
    expect(financialSourceAuthorityRank(pnl)).toBe(SOURCE_AUTHORITY.FINANCIAL_SHEET);
    expect(financialSourceAuthorityRank(cim)).toBe(SOURCE_AUTHORITY.NARRATIVE);
    // The whole point: the P&L wins.
    expect(financialSourceAuthorityRank(pnl)).toBeGreaterThan(financialSourceAuthorityRank(cim));
  });

  it('detects a spreadsheet by mimeType or filename even when type is missing/OTHER', () => {
    expect(financialSourceAuthorityRank({ type: 'OTHER', name: 'model.xlsx' })).toBe(SOURCE_AUTHORITY.FINANCIAL_SHEET);
    expect(financialSourceAuthorityRank({ mimeType: 'text/csv', name: 'export' })).toBe(SOURCE_AUTHORITY.FINANCIAL_SHEET);
    expect(financialSourceAuthorityRank({ name: 'q3.CSV' })).toBe(SOURCE_AUTHORITY.FINANCIAL_SHEET);
  });

  it('ranks teaser/LOI/PDF narratives as NARRATIVE', () => {
    expect(financialSourceAuthorityRank({ type: 'TEASER', name: 't.pdf' })).toBe(SOURCE_AUTHORITY.NARRATIVE);
    expect(financialSourceAuthorityRank({ type: 'LOI' })).toBe(SOURCE_AUTHORITY.NARRATIVE);
    expect(financialSourceAuthorityRank({ mimeType: 'application/pdf', name: 'deck.pdf' })).toBe(SOURCE_AUTHORITY.NARRATIVE);
  });

  it('ranks unknown/empty metadata as OTHER (lowest)', () => {
    expect(financialSourceAuthorityRank(undefined)).toBe(SOURCE_AUTHORITY.OTHER);
    expect(financialSourceAuthorityRank(null)).toBe(SOURCE_AUTHORITY.OTHER);
    expect(financialSourceAuthorityRank({})).toBe(SOURCE_AUTHORITY.OTHER);
    expect(financialSourceAuthorityRank({ type: 'MYSTERY', name: 'x.bin' })).toBe(SOURCE_AUTHORITY.OTHER);
  });
});
