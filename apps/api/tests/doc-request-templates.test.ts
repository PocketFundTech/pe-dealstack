/**
 * Document-request checklist templates — the static packages a user picks
 * from when asking a broker/seller for documents (spec §3.5).
 */
import { describe, it, expect } from 'vitest';
import {
  DOC_REQUEST_TEMPLATES,
  expandTemplate,
  isTemplateKey,
} from '../src/services/docRequestTemplates.js';

describe('expandTemplate', () => {
  it('expands STANDARD_DD into an ordered checklist', () => {
    const items = expandTemplate('STANDARD_DD');

    expect(items.length).toBeGreaterThan(5);
    expect(items[0].label).toBe('3-year P&L');
    expect(items.map((i) => i.sortOrder)).toEqual(items.map((_, idx) => idx));
  });

  it('marks every item with an explicit required flag', () => {
    for (const key of Object.keys(DOC_REQUEST_TEMPLATES)) {
      for (const item of expandTemplate(key as never)) {
        expect(typeof item.required).toBe('boolean');
      }
    }
  });

  it('only emits docTypes the Document table accepts', () => {
    // Document.type is a fixed enum in documents-upload.ts — a template that
    // invents a type would produce rows the VDR filters can never match.
    const allowed = new Set([
      'CIM', 'TEASER', 'FINANCIALS', 'LEGAL', 'NDA', 'LOI', 'EMAIL', 'PDF', 'EXCEL', 'DOC', 'OTHER',
    ]);
    for (const key of Object.keys(DOC_REQUEST_TEMPLATES)) {
      for (const item of expandTemplate(key as never)) {
        if (item.docType) expect(allowed).toContain(item.docType);
      }
    }
  });

  it('returns a fresh array each call so callers can mutate safely', () => {
    const a = expandTemplate('FINANCIALS_ONLY');
    const b = expandTemplate('FINANCIALS_ONLY');
    a[0].label = 'mutated';
    expect(b[0].label).not.toBe('mutated');
  });
});

describe('isTemplateKey', () => {
  it('accepts known keys and rejects everything else', () => {
    expect(isTemplateKey('STANDARD_DD')).toBe(true);
    expect(isTemplateKey('QOE_PREP')).toBe(true);
    expect(isTemplateKey('NOT_A_TEMPLATE')).toBe(false);
    expect(isTemplateKey('')).toBe(false);
  });
});
