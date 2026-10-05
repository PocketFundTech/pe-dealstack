"use client";

// ---------------------------------------------------------------------------
// AI message body renderer (Phase 3)
//
// Splits an AI chat message into ordered parts via `splitMessageWithCharts`
// and renders each:
//   - `text` parts → sanitized markdown through the existing renderMarkdown +
//     DOMPurify pipeline (same as the legacy single-blob renderer).
//   - `chart` parts → <DealChatChartArtifact /> for inline Chart.js.
//
// The styling on each text segment matches the legacy bubble: spacing-1,
// list bullets, bolded strong, break-words on long pasted URLs. We render
// each text part as its own block so charts can naturally slot between
// paragraphs without breaking markdown nesting.
// ---------------------------------------------------------------------------

import dynamic from "next/dynamic";
import DOMPurify from "dompurify";
import { renderMarkdown } from "@/lib/markdown";
import { splitMessageWithCharts } from "@/lib/dealchat-skills/chart-spec";

// chart.js + react-chartjs-2 are heavy (deal-financials.tsx already lazy-loads
// them for the same reason). DealChatChartArtifact used to be a static import
// here, which pulled chart.js into every deal page's initial bundle via
// deal-tabs.tsx -> deal-tabs-ai-message-body.tsx, regardless of whether any
// chat message ever contains a chart. Load it lazily so chart.js is only
// fetched once a message actually needs to render one. ssr:false is safe:
// this only ever renders inside the already-client ChatTab subtree.
const DealChatChartArtifact = dynamic(
  () => import("./deal-chat-chart-artifact").then((m) => m.DealChatChartArtifact),
  {
    ssr: false,
    loading: () => (
      <div
        className="my-2 h-[240px] w-full animate-pulse rounded-lg bg-gray-100"
        aria-hidden="true"
      />
    ),
  },
);

export function AiMessageBody({ content }: { content: string }) {
  const parts = splitMessageWithCharts(content);

  // Defensive fallback — if the splitter returns nothing (e.g., empty string)
  // render the original content through the same sanitized markdown pipeline
  // so the caller never has to special-case "empty" messages.
  if (parts.length === 0) {
    return (
      <div
        className="chat-markdown space-y-1 break-words [&_p]:mb-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:pl-4 [&_ol]:list-decimal [&_li]:mb-0.5 [&_strong]:font-semibold"
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(renderMarkdown(content)),
        }}
      />
    );
  }

  return (
    <>
      {parts.map((part, idx) => {
        if (part.kind === "chart") {
          return <DealChatChartArtifact key={idx} spec={part.spec} />;
        }
        if (part.kind === "nodata") {
          // Red-on-rose banner so a "no data available" response is
          // instantly visually distinct from prose. Used when the agent
          // is asked to render a chart but zero numeric data exists for
          // the requested metric/period. Multi-line text preserved.
          return (
            <div
              key={idx}
              role="status"
              className="my-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              <div className="mb-1 flex items-center gap-1.5 font-semibold">
                <span aria-hidden>⚠</span>
                <span>Chart unavailable — no data</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-red-700/90">
                {part.text}
              </div>
            </div>
          );
        }
        return (
          <div
            key={idx}
            className="chat-markdown space-y-1 break-words [&_p]:mb-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:pl-4 [&_ol]:list-decimal [&_li]:mb-0.5 [&_strong]:font-semibold"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(renderMarkdown(part.content)),
            }}
          />
        );
      })}
    </>
  );
}
