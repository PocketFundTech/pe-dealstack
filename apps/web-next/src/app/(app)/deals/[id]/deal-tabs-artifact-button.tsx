"use client";

import Link from "next/link";
import type { ChatAction } from "./deal-detail-shared";

// ---------------------------------------------------------------------------
// Artifact action button — rendered below an AI message when the backend
// returns an `action` object on POST /deals/:id/chat. Mirrors the legacy
// implementation in deal-chat.js.
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, string> = {
  create_memo: "edit_note",
  open_data_room: "folder_open",
  upload_document: "upload_file",
  view_financials: "analytics",
  change_stage: "swap_horiz",
};

export function ArtifactActionButton({ action }: { action: ChatAction }) {
  const icon = ICON_MAP[action.type] || "arrow_forward";
  const isExternal = /^https?:\/\//.test(action.url);

  const buttonClassName =
    "ai-action-btn inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-primary to-primary-hover text-white text-sm font-semibold rounded-lg hover:shadow-lg hover:shadow-primary/25 transition-all group no-underline";

  return (
    <div className="mt-3 pt-3 border-t border-border-subtle/50">
      {isExternal ? (
        <a
          href={action.url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClassName}
        >
          <span className="material-symbols-outlined text-lg">{icon}</span>
          <span>{action.label}</span>
          <span className="material-symbols-outlined text-lg group-hover:translate-x-0.5 transition-transform">
            arrow_forward
          </span>
        </a>
      ) : (
        <Link href={action.url} className={buttonClassName}>
          <span className="material-symbols-outlined text-lg">{icon}</span>
          <span>{action.label}</span>
          <span className="material-symbols-outlined text-lg group-hover:translate-x-0.5 transition-transform">
            arrow_forward
          </span>
        </Link>
      )}
      {action.description && (
        <p className="text-xs text-text-muted mt-1.5 ml-1">{action.description}</p>
      )}
    </div>
  );
}
