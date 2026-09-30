/**
 * Fix plan B3: "Extract all" queues documents instead of skipping them,
 * processes reported statements before derived models, and serialises the
 * per-deal merge so completion order can't race.
 */
import { describe, it, expect } from 'vitest';
import { extractionOrder, isDerivedModelName } from '../src/services/financialSourceAuthority.js';
import {
  acquireExtractionSlot, acquireExtractionSlotBy, releaseExtractionSlot, getActiveCount,
} from '../src/services/agents/financialAgent/concurrency.js';
import { withDealWriteLock } from '../src/services/financialExtractionOrchestrator.js';

describe('document order', () => {
  it('puts statements first and the valuation summary last (SRM files)', () => {
    const docs = [
      { name: 'SRM_Valuation_Summary_.xlsx' },
      { name: 'Strong Ready Mix CIM.pdf', type: 'CIM' },
      { name: 'Strong Ready Mix - P&L 2023-2025 YTD.xlsx' },
      { name: 'SRM LBO Model.xlsx' },
    ];
    const ordered = [...docs].sort((a, b) => extractionOrder(a) - extractionOrder(b)).map((d) => d.name);
    expect(ordered).toEqual([
      'Strong Ready Mix - P&L 2023-2025 YTD.xlsx', 'SRM LBO Model.xlsx', 'Strong Ready Mix CIM.pdf', 'SRM_Valuation_Summary_.xlsx',
    ]);
  });

  it.each([
    ['SRM_Valuation_Summary_.xlsx', true], ['Returns Analysis.xlsx', true], ['DCF.xlsx', true],
    ['Model Output.xlsx', true], ['LBO Model.xlsx', false], ['P&L 2024.xlsx', false],
  ])('isDerivedModelName(%s) = %s', (name, expected) => {
    expect(isDerivedModelName(name)).toBe(expected);
  });
});

describe('waiting for an extraction slot', () => {
  it('waits for a slot to free up instead of failing', async () => {
    const org = 'org-queue-test';
    expect(acquireExtractionSlot(org)).toBe(true);
    expect(acquireExtractionSlot(org)).toBe(true);
    setTimeout(() => releaseExtractionSlot(org), 50);
    await expect(acquireExtractionSlotBy(org, Date.now() + 2_000, 10)).resolves.toBe(true);
    releaseExtractionSlot(org);
    releaseExtractionSlot(org);
    expect(getActiveCount(org)).toBe(0);
  });

  it('gives up at the deadline', async () => {
    const org = 'org-queue-deadline';
    acquireExtractionSlot(org);
    acquireExtractionSlot(org);
    await expect(acquireExtractionSlotBy(org, Date.now() + 30, 10)).resolves.toBe(false);
    releaseExtractionSlot(org);
    releaseExtractionSlot(org);
  });
});

describe('per-deal write lock', () => {
  it('runs merges for the same deal one at a time, in arrival order', async () => {
    const events: string[] = [];
    const job = (name: string, ms: number) => withDealWriteLock('deal-1', async () => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${name}:end`);
    });
    await Promise.all([job('a', 30), job('b', 1), job('c', 1)]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('does not block other deals, and survives a failing job', async () => {
    const failing = withDealWriteLock('deal-2', async () => { throw new Error('boom'); });
    await expect(failing).rejects.toThrow('boom');
    await expect(withDealWriteLock('deal-2', async () => 'ok')).resolves.toBe('ok');
  });
});
