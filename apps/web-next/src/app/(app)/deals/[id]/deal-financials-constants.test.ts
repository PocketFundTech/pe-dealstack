import { describe, it, expect } from 'vitest';
import { LINE_ITEM_LABELS } from './deal-financials-constants';

describe('LINE_ITEM_LABELS — Adjusted EBITDA', () => {
  it('labels the adjusted lines', () => {
    expect(LINE_ITEM_LABELS.adjusted_ebitda).toBe('Adjusted EBITDA');
    expect(LINE_ITEM_LABELS.adjusted_ebitda_margin_pct).toBe('Adjusted EBITDA Margin %');
  });
});
