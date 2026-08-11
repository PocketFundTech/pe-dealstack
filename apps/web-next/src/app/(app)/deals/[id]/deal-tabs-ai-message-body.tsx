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

import DOMPurify from "dompurify";
import { renderMarkdown } from "@/lib/markdown";
import { splitMessageWithCharts } from "@/lib/dealchat-skills/chart-spec";
import { DealChatChartArtifact } from "./deal-chat-chart-artifact";

export function AiMessageBody({ content }: { content: string }) {
  const parts = splitMessageWithCharts(content);

  // Defensive fallback — if the splitter returns nothing (e.g., empty string)
  // render the original content through the same sanitized markdown pipeline
  // so the caller never has to special-case "empty" messages.
  if (parts.length === 0) {
    return (
      <div
        className="chat-markdown space-y-1 break-words [&_p]:mb-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:mb-0.5 [&_strong]:font-semibold"
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
            className="chat-markdown space-y-1 break-words [&_p]:mb-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:mb-0.5 [&_strong]:font-semibold"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(renderMarkdown(part.content)),
            }}
          />
        );
      })}
    </>
  );
}
