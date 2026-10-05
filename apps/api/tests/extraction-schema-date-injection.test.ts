/**
 * CLAUDE.md: extraction prompts must inject today's date at call time so
 * FY/LTM/"current quarter" period inference doesn't drift off the model's
 * training cutoff. EXTRACTION_SYSTEM_PROMPT and EXCEL_CONTAINER_INSTRUCTION
 * used to be static module-scope string constants with no date at all —
 * they're now builder functions taking today's date as a parameter.
 */
import { describe, it, expect } from 'vitest';
import {
  buildExtractionSystemPrompt,
  buildExcelContainerInstruction,
} from '../src/services/extraction/extractionSchema.js';

describe('buildExtractionSystemPrompt', () => {
  it('injects the given date into the system prompt', () => {
    const prompt = buildExtractionSystemPrompt('2027-03-14');
    expect(prompt).toContain('2027-03-14');
    expect(prompt).toMatch(/TODAY IS 2027-03-14/);
  });

  it('defaults to a fresh date when none is passed', () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const prompt = buildExtractionSystemPrompt();
    expect(prompt).toContain(todayIso);
  });

  it('produces a different prompt for a different date (not frozen at module load)', () => {
    const a = buildExtractionSystemPrompt('2026-01-01');
    const b = buildExtractionSystemPrompt('2030-12-31');
    expect(a).not.toBe(b);
    expect(a).toContain('2026-01-01');
    expect(b).toContain('2030-12-31');
  });
});

describe('buildExcelContainerInstruction', () => {
  it('injects the given date into the container instruction', () => {
    const instruction = buildExcelContainerInstruction('2027-03-14');
    expect(instruction).toContain('2027-03-14');
    expect(instruction).toMatch(/TODAY IS 2027-03-14/);
  });

  it('still contains the code-execution guidance the container-mode test relies on', () => {
    const instruction = buildExcelContainerInstruction('2027-03-14');
    expect(instruction).toContain('code execution environment');
  });
});
