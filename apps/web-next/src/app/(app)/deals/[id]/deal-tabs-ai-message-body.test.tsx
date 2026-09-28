/**
 * Perf regression coverage: AiMessageBody used to statically
 * `import { DealChatChartArtifact } from "./deal-chat-chart-artifact"`,
 * which pulls chart.js + react-chartjs-2 into every deal page's initial
 * bundle via deal-tabs.tsx -> deal-tabs-ai-message-body.tsx, regardless of
 * whether any chat message ever contains a chart. It's now loaded through
 * next/dynamic({ ssr: false }) so chart.js is only fetched once a message
 * actually needs to render one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Stand in for the real chart component -- it renders <canvas> via
// react-chartjs-2/chart.js, which needs a 2D context jsdom doesn't provide.
// The point of this test is the dynamic-loading wiring, not chart.js
// rendering itself (deal-chat-chart-artifact.tsx has no test of its own;
// that's a pre-existing gap, out of scope here).
vi.mock("./deal-chat-chart-artifact", () => ({
  DealChatChartArtifact: ({ spec }: { spec: { title: string } }) => (
    <div data-testid="chart-artifact">{spec.title}</div>
  ),
}));

import { AiMessageBody } from "./deal-tabs-ai-message-body";

const CHART_MESSAGE = [
  "Here's revenue by quarter:",
  "",
  "```chart",
  JSON.stringify({
    type: "bar",
    title: "Quarterly Revenue",
    series: [{ name: "Revenue", data: [{ x: "Q1", y: 100 }] }],
  }),
  "```",
].join("\n");

describe("AiMessageBody chart lazy-loading", () => {
  it("does not statically import chart.js (no static DealChatChartArtifact import in source)", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/app/(app)/deals/[id]/deal-tabs-ai-message-body.tsx"),
      "utf-8",
    );
    expect(source).not.toMatch(/^import\s*\{\s*DealChatChartArtifact\s*\}/m);
    expect(source).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\(["']\.\/deal-chat-chart-artifact["']\)/);
  });

  it("renders plain text messages without touching the chart module", () => {
    render(<AiMessageBody content="Just a plain answer, no charts here." />);
    expect(screen.getByText(/Just a plain answer/)).toBeInTheDocument();
    expect(screen.queryByTestId("chart-artifact")).not.toBeInTheDocument();
  });

  it("lazy-loads and renders the chart artifact for a message with a chart fence", async () => {
    render(<AiMessageBody content={CHART_MESSAGE} />);
    // Text before the fence renders immediately.
    expect(screen.getByText(/Here's revenue by quarter/)).toBeInTheDocument();
    // The dynamic-loaded chart component resolves asynchronously.
    await waitFor(() =>
      expect(screen.getByTestId("chart-artifact")).toHaveTextContent("Quarterly Revenue"),
    );
  });
});
