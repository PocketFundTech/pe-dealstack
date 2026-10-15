/**
 * The deal Activity feed showed "FINANCIALS document uploaded and processed
 * (null pages extracted)" for every spreadsheet (no page count) — visible on
 * the Community Solar Platform demo deal (15 Oct 2026).
 */
import { describe, it, expect } from 'vitest';
import { uploadActivityDescription } from '../src/routes/documents-upload-activity.js';

describe('uploadActivityDescription', () => {
  it('never prints "null" for a document without a page count', () => {
    expect(uploadActivityDescription('FINANCIALS', null, true, false)).toBe('FINANCIALS document uploaded and processed');
    expect(uploadActivityDescription('FINANCIALS', null, true, true)).toBe('FINANCIALS document uploaded, processed and AI-analyzed');
  });

  it('keeps the page count for PDFs', () => {
    expect(uploadActivityDescription('CIM', 35, true, false)).toBe('CIM document uploaded and processed (35 pages extracted)');
    expect(uploadActivityDescription('CIM', 1, true, true)).toBe('CIM document uploaded, processed (1 page), and AI-analyzed');
  });

  it('says only "uploaded" when nothing was extracted', () => {
    expect(uploadActivityDescription('LOI', null, false, false)).toBe('LOI document uploaded');
  });
});
