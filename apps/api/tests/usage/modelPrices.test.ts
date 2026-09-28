import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getModelPrice, computeCostUsd, _resetModelPriceCache } from '../../src/services/usage/modelPrices.js';

vi.mock('../../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => Promise.resolve({
        data: [
          { model: 'gpt-4o', provider: 'openai', inputPricePer1M: 2.5, outputPricePer1M: 10.0 },
          { model: 'gpt-4o-mini', provider: 'openai', inputPricePer1M: 0.15, outputPricePer1M: 0.6 },
        ],
        error: null,
      })),
    })),
  },
}));

describe('modelPrices', () => {
  beforeEach(() => _resetModelPriceCache());

  it('returns prices for a known model', async () => {
    const price = await getModelPrice('gpt-4o');
    expect(price).toMatchObject({ inputPricePer1M: 2.5, outputPricePer1M: 10.0 });
  });

  it('returns null for unknown model', async () => {
    const price = await getModelPrice('does-not-exist');
    expect(price).toBeNull();
  });

  it('computes cost correctly', () => {
    const price = { inputPricePer1M: 2.5, outputPricePer1M: 10.0 };
    // 1000 prompt tokens at $2.5/1M = $0.0025
    // 500 completion tokens at $10/1M = $0.005
    // Total = $0.0075
    expect(computeCostUsd(price, 1000, 500)).toBeCloseTo(0.0075, 6);
  });

  it('returns 0 cost when price is null', () => {
    expect(computeCostUsd(null, 1000, 500)).toBe(0);
  });
});
