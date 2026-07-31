/**
 * compositeConfidence.ts — Composite confidence scoring for financial extraction.
 */

export interface ConfidenceInputs {
  llmConfidence: number;
  sourceMatch: number;
  mathValidation: number;
  crossModelAgreement: number | null;
}

export type ConfidenceTier = 'high' | 'medium' | 'low' | 'very_low';

export function computeCompositeConfidence(inputs: ConfidenceInputs): number {
  const { llmConfidence, sourceMatch, mathValidation, crossModelAgreement } = inputs;
  if (crossModelAgreement != null) {
    const score = (llmConfidence * 0.25) + (sourceMatch * 0.25) + (mathValidation * 0.25) + (crossModelAgreement * 0.25);
    return Math.round(Math.min(100, Math.max(0, score)));
  }
  const score = (llmConfidence * 0.333) + (sourceMatch * 0.333) + (mathValidation * 0.334);
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function getConfidenceTier(score: number): ConfidenceTier {
  if (score >= 90) return 'high';
  if (score >= 80) return 'medium';
  if (score >= 60) return 'low';
  return 'very_low';
}

export function scoreSourceMatch(sourceQuote: string | undefined, rawText: string): number {
  // Normalize BEFORE the falsy check — a whitespace-only quote is truthy but
  // carries no real citation; without this, `normalizedText.includes('')` is
  // always true and a blank quote scores a perfect 100 "match".
  const normalizedQuote = (sourceQuote ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedQuote) return 20;
  if (!rawText) return 40;
  const normalizedText = rawText.replace(/\s+/g, ' ').toLowerCase();
  if (normalizedText.includes(normalizedQuote)) return 100;
  const partial = normalizedQuote.slice(0, 30);
  if (partial.length > 10 && normalizedText.includes(partial)) return 80;
  return 40;
}

export function scoreMathValidation(errorCount: number, warningCount: number): number {
  if (errorCount === 0 && warningCount === 0) return 100;
  if (errorCount === 0 && warningCount <= 2) return 80;
  if (errorCount <= 1) return 40;
  return 20;
}

export function scoreCrossModel(agreedCount: number, flaggedCount: number): number | null {
  const total = agreedCount + flaggedCount;
  if (total === 0) return null;
  const ratio = agreedCount / total;
  if (ratio >= 0.95) return 100;
  if (ratio >= 0.80) return 70;
  return 30;
}
