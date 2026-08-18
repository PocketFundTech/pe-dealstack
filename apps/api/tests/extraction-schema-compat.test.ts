/**
 * Every structured-output schema in the codebase must be written INSIDE the
 * API's accepted JSON-Schema subset at the source, not just rescued by
 * normalizeOutputSchema() at the boundary (see services/ai/schemaCompat.ts).
 *
 * Why both layers: the normalizer stops the 400s; this test stops the
 * repo from lying about what it sends. Four separately-authored schemas
 * (deal reader, scorecard, NDA review, memo critique/revise) shipped
 * out-of-subset on 2026-08-18 alone — the first version of this test only
 * scanned two exported constants and missed the module-private ones, which
 * is why it now scans SOURCE TEXT of every file that passes an
 * `outputSchema:` to the AI client.
 *
 * Rules enforced (each maps to a real production 400):
 *   - no `minimum` / `maximum` / `exclusive*` / `multipleOf` keywords
 *   - every `type: 'object'` schema literal carries `additionalProperties: false`
 *   - no `type: [ ... ]` arrays (use anyOf)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Files that hand a schema to trackedClaudeMessage's outputSchema. */
const schemaFiles = walk(srcDir).filter((f) => {
  const src = readFileSync(f, 'utf-8');
  return /outputSchema:/.test(src) && !f.endsWith('services/ai/client.ts');
});

/**
 * Pull the text of every `type: 'object'` schema-literal region so we can
 * check for additionalProperties. Approach: find each `type: 'object'`,
 * then scan forward to the matching close of its enclosing `{ ... }`.
 */
function objectLiteralRegions(src: string): string[] {
  const regions: string[] = [];
  const re = /type:\s*['"]object['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Walk backwards to the `{` that opens this literal.
    let open = src.lastIndexOf('{', m.index);
    if (open < 0) continue;
    // Walk forward to its matching `}`.
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) regions.push(src.slice(open, end + 1));
  }
  return regions;
}

describe('structured-output schemas stay inside the API-accepted subset (source scan)', () => {
  it('found the schema-bearing files', () => {
    expect(schemaFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(schemaFiles.map((f) => [path.relative(srcDir, f), f]))(
    '%s — no number-range keywords, no type arrays, every object has additionalProperties:false',
    (_rel, file) => {
      const src = readFileSync(file, 'utf-8');
      // Only inspect the schema-literal regions, not arbitrary code.
      const regions = objectLiteralRegions(src);
      const problems: string[] = [];
      for (const region of regions) {
        // Skip regions that aren't JSON-schema-ish (no `properties`/`items`/`enum`).
        if (!/properties\s*:|items\s*:|enum\s*:/.test(region)) continue;
        if (/\b(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)\s*:/.test(region)) {
          problems.push('number range keyword');
        }
        if (/type:\s*\[/.test(region)) problems.push('type array (use anyOf)');
        // The outermost object literal we captured is a `type: 'object'` schema —
        // it must declare additionalProperties at ITS OWN depth (depth-1 key).
        const topLevelHasAP = /^\{[^{}]*additionalProperties\s*:\s*false/m.test(
          region.replace(/\{[^{}]*\}/g, (inner, offset) => (offset === 0 ? inner : '{}')),
        ) || /additionalProperties\s*:\s*false/.test(stripNested(region));
        if (!topLevelHasAP) problems.push('object missing additionalProperties:false');
      }
      expect(problems, problems.join('; ')).toEqual([]);
    },
  );
});

/** Remove all nested `{...}` blocks, leaving only the top-level keys of a literal. */
function stripNested(region: string): string {
  let out = region.slice(1, -1); // drop outer braces
  let prev: string;
  do {
    prev = out;
    out = out.replace(/\{[^{}]*\}/g, '');
  } while (out !== prev);
  return out;
}
