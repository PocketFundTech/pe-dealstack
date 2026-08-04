"use client";

import { useState } from "react";
import { visibleHubspotFields } from "@/lib/hubspotFields";

// ---------------------------------------------------------------------------
// Renders the `hubspotProperties` blob imported from HubSpot — every property
// the client had on the record that PE OS has no dedicated column for
// (custom fields, addresses, lifecycle stage, close date, ...).
//
// Without this the importer's work is invisible: the data lands in the JSONB
// column and nothing ever reads it back out.
// ---------------------------------------------------------------------------

const COLLAPSED_COUNT = 8;

export function HubSpotFieldsCard({
  properties,
}: {
  properties?: Record<string, string | null> | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const fields = visibleHubspotFields(properties);

  if (fields.length === 0) return null;

  const shown = expanded ? fields : fields.slice(0, COLLAPSED_COUNT);
  const hiddenCount = fields.length - shown.length;

  return (
    <div className="bg-white rounded-xl border border-border-subtle shadow-sm">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle">
        <div
          className="w-6 h-6 rounded flex items-center justify-center shrink-0"
          style={{ backgroundColor: "#FF7A59", color: "#fff" }}
        >
          <span className="material-symbols-outlined text-[14px]">hub</span>
        </div>
        <h3 className="text-sm font-bold text-text-main">Imported from HubSpot</h3>
        <span className="ml-auto text-xs text-text-muted">{fields.length} fields</span>
      </div>

      <dl className="divide-y divide-border-subtle">
        {shown.map((field) => (
          <div key={field.key} className="flex gap-4 px-4 py-2.5 text-sm">
            <dt className="w-2/5 shrink-0 text-text-secondary">{field.label}</dt>
            <dd className="flex-1 break-words text-text-main">{field.value}</dd>
          </div>
        ))}
      </dl>

      {(hiddenCount > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full px-4 py-2.5 text-xs font-semibold border-t border-border-subtle hover:bg-gray-50"
          style={{ color: "#003366" }}
        >
          {expanded ? "Show less" : `Show ${hiddenCount} more`}
        </button>
      )}
    </div>
  );
}
