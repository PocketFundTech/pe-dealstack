// ─── generate_chart tool ──────────────────────────────────────────
// Returns a fenced ```chart block containing a minified JSON ChartSpec.
// The frontend chat renderer extracts that block and renders Chart.js
// inline inside the message bubble. No rendering happens server-side —
// the tool's job is just to SHAPE the spec, validate it, and emit the
// marker. Persistence is "free" because the marker rides inside the
// chat message body.
//
// The schema below MIRRORS the `ChartSpec` interface in
// `apps/web-next/src/lib/dealchat-skills/chart-spec.ts`. We intentionally
// duplicate the shape rather than cross-importing across apps — sharing
// types over the workspace boundary breaks the tsc build path in both
// directions. If you change one schema, update the other.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here. Ported from a LangChain-only `tool()` wrapper
// (2026-08-14) so it's available on both the legacy and streaming
// (DEAL_CHAT_ENGINE=streaming) barrels — see tools.ts.
//
// Deliberate deviation from the addNote.ts `parse` idiom: `parse` here
// is a lenient passthrough (never throws) and `run` does its own
// `safeParse` + friendly-error-string return, exactly as the original
// LangChain implementation did. Chart args are the one schema in this
// barrel with a cross-field `.refine()` (pie/waterfall ⇒ single series),
// and letting the model see a plain-text "Chart generation failed: ..."
// result (so it can self-correct next turn) is safer than surfacing a
// thrown validation error through the tool-runner's error path — keeps
// identical behavior on both the legacy and streaming barrels.

import { z } from 'zod';
import { log } from '../../../../utils/logger.js';

const CHART_FENCE_OPEN = '```chart';
const CHART_FENCE_CLOSE = '```';

const chartPointSchema = z.object({
  x: z.union([z.string(), z.number()]),
  y: z.number().finite(),
});

const chartSeriesSchema = z.object({
  name: z.string().min(1),
  data: z.array(chartPointSchema).min(1),
});

const chartAnnotationSchema = z.object({
  x: z.union([z.string(), z.number()]),
  label: z.string().min(1),
});

const chartUnitSchema = z
  .enum(['K', 'M', 'B', 'units', '%', 'x'])
  .describe(
    [
      "Display unit for y-axis ticks. REQUIRED — picking the wrong one renders dollar prefixes on percentages, or vice versa.",
      "Currency charts (revenue, EBITDA, dollars): map from the row's unitScale — ACTUALS -> 'units', THOUSANDS -> 'K', MILLIONS -> 'M', BILLIONS -> 'B'.",
      "Percentage charts (margins, growth rates, ratios): USE '%' — axis ticks render as '20%' / '-30.6%' WITHOUT a $ prefix. DO NOT use 'units' for percentages — they will mis-render as '$20' / '-$30.6'.",
      "Multiplier charts (EV/EBITDA, EV/Revenue, P/E, etc.): USE 'x' — axis ticks render as '8.5x' / '12x' WITHOUT a $ prefix. DO NOT use 'units' for multiples.",
      "'units' is for raw scalars only: actual-dollar amounts shown as '$6,900', headcount, slice counts.",
      "Mismatch will mis-render the chart axis (e.g., raw-dollar y-values rendered with the default 'M' suffix display as $0.0M for every tick).",
    ].join(' '),
  );

export const inputSchema = z
  .object({
    type: z.enum(['line', 'bar', 'waterfall', 'pie']),
    title: z.string().min(1),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    series: z.array(chartSeriesSchema).min(1),
    annotations: z.array(chartAnnotationSchema).optional(),
    // Kept optional for backwards-compatibility with older tool callers; the
    // tool description and the agent's system prompt instruct callers to
    // ALWAYS set this when y-values come from financials. The frontend
    // renderer has a defensive fallback (see deal-chat-chart-artifact.tsx)
    // when this is omitted, but the agent prompt is the primary fix.
    unit: chartUnitSchema.optional(),
  })
  .refine(
    (s) => !(s.type === 'pie' || s.type === 'waterfall') || s.series.length === 1,
    { message: 'pie and waterfall charts must have exactly one series' },
  );

type ChartSpecInput = z.infer<typeof inputSchema>;

function buildChartArtifact(spec: ChartSpecInput): string {
  // Strip undefined optionals before serializing so the marker stays compact.
  const compact: Record<string, unknown> = {
    type: spec.type,
    title: spec.title,
    series: spec.series,
  };
  if (spec.xLabel !== undefined) compact.xLabel = spec.xLabel;
  if (spec.yLabel !== undefined) compact.yLabel = spec.yLabel;
  if (spec.annotations !== undefined) compact.annotations = spec.annotations;
  if (spec.unit !== undefined) compact.unit = spec.unit;
  const json = JSON.stringify(compact);
  return `${CHART_FENCE_OPEN}\n${json}\n${CHART_FENCE_CLOSE}`;
}

export function makeGenerateChartTool() {
  return {
    type: 'custom' as const,
    name: 'generate_chart',
    description:
      "Render a chart inline in the chat. Returns a fenced ```chart...``` text block that you MUST copy VERBATIM into your final reply — opening fence, JSON line, and closing fence. The frontend chat renderer scans for that exact fence pair and draws Chart.js from the JSON inside; summarizing or paraphrasing the JSON means NO chart appears. Use for trends, comparisons, distributions. DO NOT also describe the same data in a long paragraph after the chart. Chart data must come from get_deal_financials (or compare_deals for comp sets) — never fabricate. CRITICAL: set the `unit` field — currency: ACTUALS -> 'units', THOUSANDS -> 'K', MILLIONS -> 'M', BILLIONS -> 'B'; percentages (margins, growth): '%'; multiples (EV/EBITDA, P/E): 'x'. Omitting `unit` defaults to millions and renders raw-dollar values as $0.0M.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['line', 'bar', 'waterfall', 'pie'] },
        title: { type: 'string' },
        xLabel: { type: 'string' },
        yLabel: { type: 'string' },
        series: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              data: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    x: { type: ['string', 'number'] },
                    y: { type: 'number' },
                  },
                  required: ['x', 'y'],
                },
              },
            },
            required: ['name', 'data'],
          },
        },
        annotations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: ['string', 'number'] },
              label: { type: 'string' },
            },
            required: ['x', 'label'],
          },
        },
        unit: {
          type: 'string',
          enum: ['K', 'M', 'B', 'units', '%', 'x'],
          description: "Display unit for y-axis ticks. Currency: ACTUALS -> 'units', THOUSANDS -> 'K', MILLIONS -> 'M', BILLIONS -> 'B'. Percentages: '%'. Multiples: 'x'.",
        },
      },
      required: ['type', 'title', 'series'],
    },
    // Lenient passthrough — see the file-header note on why this deviates
    // from the standard `inputSchema.parse(input)` idiom used elsewhere in
    // this barrel. `run` below performs the real validation via safeParse.
    parse: (input: unknown) => input as ChartSpecInput,
    run: async (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        log.warn('[generate_chart] validation failed', { message });
        return `Chart generation failed: ${message}`;
      }

      log.info('[generate_chart] called', {
        type: parsed.data.type,
        seriesCount: parsed.data.series.length,
        pointCount: parsed.data.series.reduce((acc, s) => acc + s.data.length, 0),
      });

      return buildChartArtifact(parsed.data);
    },
  };
}
