import { describe, it, expect } from "vitest";
import {
  CHART_FENCE_CLOSE,
  CHART_FENCE_OPEN,
  parseChartSpec,
  splitMessageWithCharts,
  type ChartSpec,
  type MessagePart,
} from "./chart-spec";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFenced(jsonBody: string): string {
  return `${CHART_FENCE_OPEN}\n${jsonBody}\n${CHART_FENCE_CLOSE}`;
}

const validLineSpec: ChartSpec = {
  type: "line",
  title: "Revenue trend",
  series: [
    {
      name: "Revenue",
      data: [
        { x: "FY22", y: 10 },
        { x: "FY23", y: 14 },
        { x: "FY24", y: 19 },
      ],
    },
  ],
};

const validBarSpec: ChartSpec = {
  type: "bar",
  title: "Comps",
  series: [
    {
      name: "EV/EBITDA",
      data: [
        { x: "Acme", y: 8.5 },
        { x: "Beta", y: 9.2 },
        { x: "Gamma", y: 11.0 },
      ],
    },
  ],
};

const validPieSpec: ChartSpec = {
  type: "pie",
  title: "Revenue mix",
  series: [
    {
      name: "Segments",
      data: [
        { x: "Enterprise", y: 60 },
        { x: "Mid-market", y: 30 },
        { x: "SMB", y: 10 },
      ],
    },
  ],
};

const validWaterfallSpec: ChartSpec = {
  type: "waterfall",
  title: "EBITDA bridge",
  series: [
    {
      name: "Drivers",
      data: [
        { x: "Start", y: 10 },
        { x: "Price", y: 2 },
        { x: "Volume", y: -1 },
        { x: "End", y: 11 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// parseChartSpec — happy path
// ---------------------------------------------------------------------------

describe("parseChartSpec — valid specs", () => {
  it("parses a minimal valid line spec", () => {
    const out = parseChartSpec(JSON.stringify(validLineSpec));
    expect(out).not.toBeNull();
    expect(out?.type).toBe("line");
    expect(out?.title).toBe("Revenue trend");
    expect(out?.series).toHaveLength(1);
    expect(out?.series[0].data).toHaveLength(3);
  });

  it("parses a valid bar spec", () => {
    const out = parseChartSpec(JSON.stringify(validBarSpec));
    expect(out?.type).toBe("bar");
    expect(out?.series[0].name).toBe("EV/EBITDA");
  });

  it("parses a valid pie spec (single series)", () => {
    const out = parseChartSpec(JSON.stringify(validPieSpec));
    expect(out?.type).toBe("pie");
    expect(out?.series).toHaveLength(1);
  });

  it("parses a valid waterfall spec (single series, allows negative y)", () => {
    const out = parseChartSpec(JSON.stringify(validWaterfallSpec));
    expect(out?.type).toBe("waterfall");
    expect(out?.series[0].data.some((p) => p.y < 0)).toBe(true);
  });

  it("preserves optional xLabel / yLabel when provided", () => {
    const spec = {
      ...validLineSpec,
      xLabel: "Period",
      yLabel: "Revenue ($M)",
    };
    const out = parseChartSpec(JSON.stringify(spec));
    expect(out?.xLabel).toBe("Period");
    expect(out?.yLabel).toBe("Revenue ($M)");
  });

  it("preserves annotations when provided", () => {
    const spec = {
      ...validLineSpec,
      annotations: [
        { x: "FY23", label: "Refinance" },
        { x: "FY24", label: "New CFO" },
      ],
    };
    const out = parseChartSpec(JSON.stringify(spec));
    expect(out?.annotations).toHaveLength(2);
    expect(out?.annotations?.[0]).toEqual({ x: "FY23", label: "Refinance" });
  });

  it("omits xLabel/yLabel/annotations from output when not provided", () => {
    const out = parseChartSpec(JSON.stringify(validLineSpec));
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty("xLabel");
    expect(out).not.toHaveProperty("yLabel");
    expect(out).not.toHaveProperty("annotations");
  });

  it("accepts a line spec with multiple series sharing an x-axis", () => {
    const spec: ChartSpec = {
      type: "line",
      title: "Margins",
      series: [
        {
          name: "Gross margin",
          data: [{ x: "FY23", y: 55 }, { x: "FY24", y: 57 }],
        },
        {
          name: "EBITDA margin",
          data: [{ x: "FY23", y: 20 }, { x: "FY24", y: 22 }],
        },
      ],
    };
    const out = parseChartSpec(JSON.stringify(spec));
    expect(out?.series).toHaveLength(2);
  });

  it("accepts numeric x values (e.g., timestamps)", () => {
    const spec = {
      type: "line",
      title: "Cash",
      series: [
        {
          name: "Cash",
          data: [
            { x: 1, y: 100 },
            { x: 2, y: 120 },
          ],
        },
      ],
    };
    const out = parseChartSpec(JSON.stringify(spec));
    expect(out?.series[0].data[0].x).toBe(1);
  });

  it("accepts negative y-values on a pie (semantically odd but parser must not care)", () => {
    // The parser is shape-only — semantic concerns (pie slices should be
    // non-negative) are left to the renderer. Verify it accepts.
    const spec = {
      type: "pie",
      title: "Quirky",
      series: [
        {
          name: "Slices",
          data: [
            { x: "A", y: -5 },
            { x: "B", y: 10 },
          ],
        },
      ],
    };
    const out = parseChartSpec(JSON.stringify(spec));
    expect(out).not.toBeNull();
    expect(out?.series[0].data[0].y).toBe(-5);
  });

  it("accepts the optional `unit` field when set to a valid value (K)", () => {
    const spec = { ...validLineSpec, unit: "K" };
    const out = parseChartSpec(JSON.stringify(spec));
    expect(out).not.toBeNull();
    expect(out?.unit).toBe("K");
  });

  it("accepts the optional `unit` field for every allowed value (K/M/B/units)", () => {
    for (const u of ["K", "M", "B", "units"] as const) {
      const out = parseChartSpec(JSON.stringify({ ...validBarSpec, unit: u }));
      expect(out?.unit).toBe(u);
    }
  });

  it("omits `unit` from the output when the field is absent on input", () => {
    const out = parseChartSpec(JSON.stringify(validLineSpec));
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty("unit");
  });

  it("returns null when `unit` is present but not a string (defensive)", () => {
    const spec = { ...validLineSpec, unit: 123 };
    expect(parseChartSpec(JSON.stringify(spec))).toBeNull();
  });

  it("returns null when `unit` is a string but not one of the allowed values", () => {
    const spec = { ...validLineSpec, unit: "MM" };
    expect(parseChartSpec(JSON.stringify(spec))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseChartSpec — defensive negative cases
// ---------------------------------------------------------------------------

describe("parseChartSpec — invalid input returns null without throwing", () => {
  it("returns null for empty string", () => {
    expect(parseChartSpec("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(parseChartSpec("   \n  \t")).toBeNull();
  });

  it("returns null for plain (non-JSON) text", () => {
    expect(parseChartSpec("not a chart at all")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseChartSpec("{not: json}")).toBeNull();
  });

  it("returns null when JSON parses but is a primitive (number)", () => {
    expect(parseChartSpec("42")).toBeNull();
  });

  it("returns null when JSON parses but is a primitive (string)", () => {
    expect(parseChartSpec('"hello"')).toBeNull();
  });

  it("returns null when JSON parses but is null", () => {
    expect(parseChartSpec("null")).toBeNull();
  });

  it("returns null when JSON parses but is an array", () => {
    // arrays are objects but not the shape we want; parser must reject.
    expect(parseChartSpec("[]")).toBeNull();
  });

  it("returns null when the `type` field is missing", () => {
    expect(parseChartSpec(JSON.stringify({ title: "X", series: [] }))).toBeNull();
  });

  it('returns null when the `type` field is an invalid value (e.g., "scatter")', () => {
    expect(
      parseChartSpec(
        JSON.stringify({ ...validLineSpec, type: "scatter" }),
      ),
    ).toBeNull();
  });

  it("returns null when `type` is not a string", () => {
    expect(
      parseChartSpec(JSON.stringify({ ...validLineSpec, type: 123 })),
    ).toBeNull();
  });

  it("returns null when `title` is missing", () => {
    const { title: _t, ...rest } = validLineSpec;
    void _t;
    expect(parseChartSpec(JSON.stringify(rest))).toBeNull();
  });

  it("returns null when `title` is not a string", () => {
    expect(
      parseChartSpec(JSON.stringify({ ...validLineSpec, title: 42 })),
    ).toBeNull();
  });

  it("returns null when `series` is missing", () => {
    expect(
      parseChartSpec(JSON.stringify({ type: "line", title: "X" })),
    ).toBeNull();
  });

  it("returns null when `series` is not an array (object)", () => {
    expect(
      parseChartSpec(
        JSON.stringify({ type: "line", title: "X", series: { name: "S", data: [] } }),
      ),
    ).toBeNull();
  });

  it("returns null when `series` is an empty array", () => {
    expect(
      parseChartSpec(JSON.stringify({ type: "line", title: "X", series: [] })),
    ).toBeNull();
  });

  it("returns null when a series entry is missing `data`", () => {
    expect(
      parseChartSpec(
        JSON.stringify({
          type: "line",
          title: "X",
          series: [{ name: "S" }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a series entry's `data` is not an array", () => {
    expect(
      parseChartSpec(
        JSON.stringify({
          type: "line",
          title: "X",
          series: [{ name: "S", data: "not-array" }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a series entry's `name` is not a string", () => {
    expect(
      parseChartSpec(
        JSON.stringify({
          type: "line",
          title: "X",
          series: [{ name: 7, data: [] }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a data point is missing `x`", () => {
    expect(
      parseChartSpec(
        JSON.stringify({
          type: "line",
          title: "X",
          series: [{ name: "S", data: [{ y: 1 }] }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a data point has a non-finite y (NaN encoded as null)", () => {
    expect(
      parseChartSpec(
        JSON.stringify({
          type: "line",
          title: "X",
          series: [{ name: "S", data: [{ x: "A", y: null }] }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null for pie with more than one series (semantic constraint)", () => {
    const spec = {
      type: "pie",
      title: "Mix",
      series: [
        { name: "A", data: [{ x: "x", y: 1 }] },
        { name: "B", data: [{ x: "x", y: 2 }] },
      ],
    };
    expect(parseChartSpec(JSON.stringify(spec))).toBeNull();
  });

  it("returns null for waterfall with more than one series (semantic constraint)", () => {
    const spec = {
      type: "waterfall",
      title: "Bridge",
      series: [
        { name: "A", data: [{ x: "x", y: 1 }] },
        { name: "B", data: [{ x: "x", y: 2 }] },
      ],
    };
    expect(parseChartSpec(JSON.stringify(spec))).toBeNull();
  });

  it("returns null when an annotation is missing `label`", () => {
    const spec = {
      ...validLineSpec,
      annotations: [{ x: "FY23" }],
    };
    expect(parseChartSpec(JSON.stringify(spec))).toBeNull();
  });

  it("returns null for a deeply nested malformed structure (object instead of array of points)", () => {
    const spec = {
      type: "line",
      title: "X",
      series: [
        {
          name: "S",
          data: { not: "an array of points" },
        },
      ],
    };
    expect(parseChartSpec(JSON.stringify(spec))).toBeNull();
  });

  it("returns null when called with a non-string argument (defensive)", () => {
    // Public signature is `(raw: string)` but the implementation guards
    // against non-strings. Cast through unknown to exercise that branch
    // without violating strict-mode.
    const fn = parseChartSpec as unknown as (raw: unknown) => ChartSpec | null;
    expect(fn(null)).toBeNull();
    expect(fn(undefined)).toBeNull();
    expect(fn(123)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// splitMessageWithCharts
// ---------------------------------------------------------------------------

describe("splitMessageWithCharts", () => {
  it("returns an empty array for empty input", () => {
    // Implementation choice: empty string → empty array (documented in
    // source via the early-return guard).
    expect(splitMessageWithCharts("")).toEqual([]);
  });

  it("returns a single text part when the message contains no chart fences", () => {
    const parts = splitMessageWithCharts("hello world");
    expect(parts).toEqual<MessagePart[]>([
      { kind: "text", content: "hello world" },
    ]);
  });

  it("splits text + one chart + text into three parts in order", () => {
    const body = JSON.stringify(validLineSpec);
    const content = `Before the chart.\n${makeFenced(body)}\nAfter the chart.`;
    const parts = splitMessageWithCharts(content);
    expect(parts).toHaveLength(3);
    expect(parts[0].kind).toBe("text");
    expect((parts[0] as { content: string }).content).toContain("Before the chart");
    expect(parts[1].kind).toBe("chart");
    expect(parts[2].kind).toBe("text");
    expect((parts[2] as { content: string }).content).toContain("After the chart");
  });

  it("splits text + chart + text + chart + text into five parts", () => {
    const c1 = makeFenced(JSON.stringify(validLineSpec));
    const c2 = makeFenced(JSON.stringify(validBarSpec));
    const content = `intro\n${c1}\nmiddle\n${c2}\noutro`;
    const parts = splitMessageWithCharts(content);
    expect(parts).toHaveLength(5);
    expect(parts.map((p) => p.kind)).toEqual([
      "text",
      "chart",
      "text",
      "chart",
      "text",
    ]);
  });

  it("handles a chart at the very start of the message (no leading text)", () => {
    const content = `${makeFenced(JSON.stringify(validLineSpec))}\nfollow-up`;
    const parts = splitMessageWithCharts(content);
    expect(parts[0].kind).toBe("chart");
    expect(parts[1].kind).toBe("text");
    expect((parts[1] as { content: string }).content).toContain("follow-up");
  });

  it("handles a chart at the very end of the message (no trailing text)", () => {
    const content = `intro\n${makeFenced(JSON.stringify(validLineSpec))}`;
    const parts = splitMessageWithCharts(content);
    expect(parts[parts.length - 1].kind).toBe("chart");
    expect(parts[0].kind).toBe("text");
  });

  it("handles two adjacent chart blocks with no intervening text — empty text parts elided", () => {
    const c1 = makeFenced(JSON.stringify(validLineSpec));
    const c2 = makeFenced(JSON.stringify(validBarSpec));
    // No characters between c1's closing newline and c2's opener.
    const content = `${c1}${c2}`;
    const parts = splitMessageWithCharts(content);
    // Expect two chart parts back-to-back (no empty text part between them).
    const kinds = parts.map((p) => p.kind);
    expect(kinds.filter((k) => k === "chart")).toHaveLength(2);
    expect(kinds.filter((k) => k === "text" && false)).toHaveLength(0);
    // No "empty text" part with an empty string should appear.
    for (const part of parts) {
      if (part.kind === "text") expect(part.content).not.toBe("");
    }
  });

  it("falls through to text when a fenced chart block contains malformed JSON (does NOT crash or drop content)", () => {
    const content = `prefix\n${CHART_FENCE_OPEN}\n{this is not json}\n${CHART_FENCE_CLOSE}\nsuffix`;
    const parts = splitMessageWithCharts(content);
    // The whole fenced region survives as text. The "suffix" arrives as a
    // separate text segment after the closing fence.
    expect(parts.some((p) => p.kind === "chart")).toBe(false);
    const allText = parts
      .map((p) => (p.kind === "text" ? p.content : ""))
      .join("");
    expect(allText).toContain("prefix");
    expect(allText).toContain("{this is not json}");
    expect(allText).toContain("suffix");
  });

  it("falls through to text when JSON is valid but the chart shape is rejected", () => {
    // Valid JSON, but `type` is invalid — parseChartSpec returns null and
    // the splitter must preserve the fence body as text rather than drop it.
    const badBody = JSON.stringify({ type: "scatter", title: "X", series: [] });
    const content = `${CHART_FENCE_OPEN}\n${badBody}\n${CHART_FENCE_CLOSE}`;
    const parts = splitMessageWithCharts(content);
    expect(parts.some((p) => p.kind === "chart")).toBe(false);
    expect(parts.some((p) => p.kind === "text")).toBe(true);
  });

  it("emits the parsed spec on the chart part and preserves the raw body string", () => {
    const body = JSON.stringify(validLineSpec);
    const content = makeFenced(body);
    const parts = splitMessageWithCharts(content);
    expect(parts).toHaveLength(1);
    const chartPart = parts[0];
    expect(chartPart.kind).toBe("chart");
    if (chartPart.kind === "chart") {
      expect(chartPart.spec.type).toBe("line");
      expect(chartPart.spec.title).toBe("Revenue trend");
      // raw is the trimmed JSON body extracted from inside the fence.
      expect(chartPart.raw).toBe(body);
    }
  });

  it("treats an unterminated chart fence as text (no silent swallowing)", () => {
    const content = `intro text\n${CHART_FENCE_OPEN}\n{ "type": "line"`;
    const parts = splitMessageWithCharts(content);
    // No chart should be emitted; the unterminated block becomes text.
    expect(parts.some((p) => p.kind === "chart")).toBe(false);
    const allText = parts
      .map((p) => (p.kind === "text" ? p.content : ""))
      .join("");
    expect(allText).toContain("intro text");
    expect(allText).toContain(CHART_FENCE_OPEN);
  });

  it("tolerates whitespace between ```chart and the newline before the body", () => {
    // The opener-line scanner skips characters until a newline, so trailing
    // whitespace on the opener (e.g., `\`\`\`chart   \n`) is acceptable.
    const body = JSON.stringify(validLineSpec);
    const content = `${CHART_FENCE_OPEN}   \n${body}\n${CHART_FENCE_CLOSE}`;
    const parts = splitMessageWithCharts(content);
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe("chart");
  });

  it("skips a single trailing newline after the closing fence (no orphan blank line)", () => {
    const body = JSON.stringify(validLineSpec);
    const content = `${makeFenced(body)}\ntail`;
    const parts = splitMessageWithCharts(content);
    expect(parts.map((p) => p.kind)).toEqual(["chart", "text"]);
    // The "tail" text should not be prefixed with a leading newline.
    if (parts[1].kind === "text") {
      expect(parts[1].content.startsWith("\n")).toBe(false);
      expect(parts[1].content).toBe("tail");
    }
  });

  it("preserves message ordering when text, chart, malformed-chart, and text are interleaved", () => {
    const goodBody = JSON.stringify(validLineSpec);
    const badBody = JSON.stringify({ type: "scatter", title: "X", series: [] });
    const content =
      `pre\n${makeFenced(goodBody)}\nmiddle\n${makeFenced(badBody)}\npost`;
    const parts = splitMessageWithCharts(content);
    // Exactly one chart part survives; the malformed block becomes text.
    expect(parts.filter((p) => p.kind === "chart")).toHaveLength(1);
    const allText = parts
      .map((p) => (p.kind === "text" ? p.content : ""))
      .join(" ");
    expect(allText).toContain("pre");
    expect(allText).toContain("middle");
    expect(allText).toContain("post");
  });
});
