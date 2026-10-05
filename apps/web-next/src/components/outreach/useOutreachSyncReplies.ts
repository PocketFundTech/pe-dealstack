"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import type { SyncRepliesResult } from "./types";

// ---------------------------------------------------------------------------
// Board-level "check for new replies" action — pulls from Reply.io and runs
// Claude intent-classification server-side. Reply.io may not be configured
// yet, same "not run" idiom as Enrich. On success, the caller's `onSynced`
// refetches the whole board so any newly-updated lastReplyText/replyIntent/
// needsReview show up across every card.
//
// Pulled out of OutreachBoard.tsx (over the repo's 500-line convention once
// the pipeline-automation UI landed) — same extraction pattern as every
// other useOutreach* hook before it.
// ---------------------------------------------------------------------------
export function useOutreachSyncReplies(onSynced: () => Promise<void>) {
  const { showToast } = useToast();
  const [syncingReplies, setSyncingReplies] = useState(false);

  async function handleSyncReplies() {
    if (syncingReplies) return;
    setSyncingReplies(true);
    try {
      const result = await api.post<SyncRepliesResult>("/outreach/sync-replies", {});
      if ("reason" in result) {
        showToast(result.reason, "info");
      } else {
        const { checked, newReplies, flaggedForReview } = result;
        await onSynced();
        const contactWord = `contact${checked !== 1 ? "s" : ""}`;
        if (newReplies === 0) {
          showToast(`Checked ${checked} ${contactWord} — no new replies`, "success");
        } else {
          const replyWord = newReplies === 1 ? "reply" : "replies";
          const reviewPart =
            flaggedForReview > 0 ? `, ${flaggedForReview} need${flaggedForReview === 1 ? "s" : ""} review` : "";
          showToast(`Checked ${checked} ${contactWord} — ${newReplies} new ${replyWord}${reviewPart}`, "success");
        }
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to sync replies";
      showToast(message, "error");
    } finally {
      setSyncingReplies(false);
    }
  }

  return { syncingReplies, handleSyncReplies };
}
