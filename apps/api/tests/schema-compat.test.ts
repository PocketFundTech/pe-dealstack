/**
 * normalizeOutputSchema — the boundary defense against structured-output
 * schemas that fall outside the API's accepted JSON-Schema subset. Each
 * case here maps to a real 2026-08-18 production 400.
 */
import { describe, it, expect } from 'vitest';
import { normalizeOutputSchema } from '../src/services/ai/schemaCompat.js';

describe('normalizeOutputSchema', () => {
  it('adds additionalProperties:false to every object that lacks it (nested too)', () => {
    const out = normalizeOutputSchema({
      type: 'object',
      properties: {
        reasons: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } },
      },
    }) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.reasons.items.additionalProperties).toBe(false);
  });

  it('respects an explicit additionalProperties value', () => {
    const out = normalizeOutputSchema({ type: 'object', additionalProperties: true, properties: {} }) as any;
    expect(out.additionalProperties).toBe(true);
  });

  it('drops number range keywords and moves them into the description', () => {
    const out = normalizeOutputSchema({
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 1, maximum: 5 },
        conf: { type: 'number', minimum: 0, maximum: 100, description: 'Confidence' },
      },
    }) as any;
    expect(out.properties.score.minimum).toBeUndefined();
    expect(out.properties.score.maximum).toBeUndefined();
    expect(out.properties.score.description).toBe('(minimum 1, maximum 5)');
    expect(out.properties.conf.description).toBe('Confidence (minimum 0, maximum 100)');
  });

  it('rewrites type arrays as anyOf', () => {
    const out = normalizeOutputSchema({
      type: 'object',
      properties: { x: { type: ['string', 'null'] } },
    }) as any;
    expect(out.properties.x.type).toBeUndefined();
    expect(out.properties.x.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  it('leaves an already-compliant schema byte-for-byte equivalent', () => {
    const clean = {
      type: 'object',
      properties: { a: { type: 'string' }, n: { anyOf: [{ type: 'number' }, { type: 'null' }] } },
      required: ['a', 'n'],
      additionalProperties: false,
    };
    expect(normalizeOutputSchema(clean)).toEqual(clean);
  });

  it('does not mutate its input', () => {
    const input = { type: 'object', properties: { s: { type: 'integer', minimum: 0 } } };
    const snapshot = JSON.stringify(input);
    normalizeOutputSchema(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
