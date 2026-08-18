// ─── Structured-output schema compatibility ────────────────────────
// The Anthropic structured-output validator (output_config.format) accepts
// a SUBSET of JSON Schema. Three rules bit production on 2026-08-18 alone,
// across FOUR separately-authored schemas (deal reader, scorecard, NDA
// review, memo critique/revise):
//   1. Every `type: 'object'` must set `additionalProperties: false`
//      explicitly — "For 'object' type, 'additionalProperties' must be
//      explicitly set to false".
//   2. `minimum` / `maximum` (and their exclusive/multipleOf cousins) are
//      rejected on number/integer types — "For 'number' type, properties
//      maximum, minimum are not supported".
//   3. `type: [a, b]` arrays are rejected — use anyOf (see the 2026-08-17
//      generate_chart incident; that one is a tool input_schema, enforced
//      by deal-chat-tool-schemas.test.ts).
//
// Rather than trust every future author to remember, trackedClaudeMessage
// runs every outputSchema through normalizeOutputSchema() so an
// out-of-subset schema is fixed at the boundary. Ranges dropped from
// number fields are appended to the field's description so the model
// still sees the intent. Sources should STILL be written correctly (the
// schema-compat test enforces that) — this is defense-in-depth for the
// case where they aren't.

const NUMBER_RANGE_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeOutputSchema<T>(schema: T): T {
  return walk(schema) as T;
}

function walk(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walk);
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  const rangeNotes: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    if ((NUMBER_RANGE_KEYWORDS as readonly string[]).includes(key) && typeof value === 'number') {
      rangeNotes.push(`${key} ${value}`);
      continue; // dropped from the schema; surfaced in description below
    }
    out[key] = walk(value);
  }

  if (out.type === 'object' && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  if (Array.isArray(out.type)) {
    // type: ['string','null'] → anyOf: [{type:'string'},{type:'null'}]
    const alts = (out.type as unknown[]).map((t) => ({ type: t }));
    delete out.type;
    out.anyOf = alts;
  }
  if (rangeNotes.length > 0) {
    const existing = typeof out.description === 'string' ? out.description : '';
    const note = `(${rangeNotes.join(', ')})`;
    out.description = existing ? `${existing} ${note}` : note;
  }
  return out;
}
