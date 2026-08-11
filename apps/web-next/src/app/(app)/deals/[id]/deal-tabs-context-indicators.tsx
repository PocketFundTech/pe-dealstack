"use client";

import { cn } from "@/lib/cn";
import type { DocItem } from "./deal-detail-shared";

// ---------------------------------------------------------------------------
// Context Document Indicators (colored doc circles in chat header)
// ---------------------------------------------------------------------------

export function ContextDocIndicators({ documents }: { documents: DocItem[] }) {
  if (!documents || documents.length === 0) return null;

  const icons: Record<string, string> = { pdf: "P", xlsx: "X", xls: "X", csv: "C" };
  const bgColors = ["bg-red-100", "bg-emerald-100", "bg-blue-100", "bg-purple-100"];
  const textColors = ["text-red-700", "text-emerald-700", "text-blue-700", "text-purple-700"];

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted font-medium">Context:</span>
      <div className="flex -space-x-2">
        {documents.slice(0, 3).map((doc, i) => {
          const ext = doc.name.split(".").pop()?.toLowerCase() || "";
          const icon = icons[ext] || "D";
          return (
            <div
              key={doc.id}
              className={cn(
                "size-6 rounded-full border border-white flex items-center justify-center text-[10px] font-bold shadow-sm",
                bgColors[i % bgColors.length],
                textColors[i % textColors.length]
              )}
              style={{ zIndex: 20 - i * 10 }}
              title={doc.name}
            >
              {icon}
            </div>
          );
        })}
        {documents.length > 3 && (
          <div className="size-6 rounded-full bg-gray-100 border border-white flex items-center justify-center text-[10px] text-text-secondary z-0 shadow-sm">
            +{documents.length - 3}
          </div>
        )}
      </div>
    </div>
  );
}
