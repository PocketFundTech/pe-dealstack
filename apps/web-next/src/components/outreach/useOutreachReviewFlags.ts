"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import type { OutreachContact } from "./types";

// ---------------------------------------------------------------------------
// The two "clear a review flag" actions in the contact detail modal —
// Mark reviewed (needsReview, a reply-intent concern) and Confirm as new
// contact (needsMatchReview, a bulk-import duplicate-detection concern).
// Pulled out of OutreachBoard.tsx (over the repo's 500-line convention
// once Send was wired in) — same plain-PATCH shape, same "keep the open
// modal's contact prop in sync" behavior, just packaged together since
// they're a matched pair rather than each meriting its own file.
// ---------------------------------------------------------------------------
export function useOutreachReviewFlags(
  setContacts: Dispatch<SetStateAction<OutreachContact[]>>,
  setEditingContact: Dispatch<SetStateAction<OutreachContact | null>>,
) {
  const { showToast } = useToast();
  const [markingReviewedId, setMarkingReviewedId] = useState<string | null>(null);
  const [confirmingMatchReviewId, setConfirmingMatchReviewId] = useState<string | null>(null);

  async function markReviewed(contactId: string) {
    if (markingReviewedId) return;
    setMarkingReviewedId(contactId);
    try {
      const updated = await api.patch<OutreachContact>(`/outreach/contacts/${contactId}`, {
        needsReview: false,
      });
      setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setEditingContact((prev) => (prev && prev.id === updated.id ? updated : prev));
      showToast("Marked as reviewed", "success");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to update contact";
      showToast(message, "error");
    } finally {
      setMarkingReviewedId(null);
    }
  }

  async function confirmMatchReview(contactId: string) {
    if (confirmingMatchReviewId) return;
    setConfirmingMatchReviewId(contactId);
    try {
      const updated = await api.patch<OutreachContact>(`/outreach/contacts/${contactId}`, {
        needsMatchReview: false,
      });
      setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setEditingContact((prev) => (prev && prev.id === updated.id ? updated : prev));
      showToast("Confirmed as new contact", "success");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to update contact";
      showToast(message, "error");
    } finally {
      setConfirmingMatchReviewId(null);
    }
  }

  return { markingReviewedId, confirmingMatchReviewId, markReviewed, confirmMatchReview };
}
