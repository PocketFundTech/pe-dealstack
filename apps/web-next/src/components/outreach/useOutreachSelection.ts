"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import type { OutreachContact } from "./types";

// ---------------------------------------------------------------------------
// Multi-select + bulk "move to stage" for the Outreach board. Pulled out of
// OutreachBoard.tsx (already at the 500-line cap) rather than grown inline —
// same reasoning as CsvImportButton's extraction.
//
// Why this exists: the per-card "Move to..." menu (OutreachCard.tsx) only
// ever moves one contact at a time. That's fine for day-to-day use, but a
// single Private Circle/Clay import can drop 200+ contacts into Source at
// once — nobody is going to open 200 menus. This is the bulk equivalent.
//
// No bulk API endpoint exists (PATCH /outreach/contacts/:id is single-row
// only) — this fans out plain PATCHes in bounded batches rather than one
// contact at a time or all-at-once. Bounded, not because a single PATCH is
// expensive (it's a plain DB update, no provider calls — nothing like the
// import route's auto-enrichment timeout problem), just no reason to fire
// hundreds of concurrent requests when a small batch size gets the same
// wall-clock time with far less thundering-herd risk on the API.
//
// Deliberately NOT optimistic: a bulk move can partially fail (network
// blip mid-batch), and rolling back a partial success cleanly is more
// bug surface than it's worth for what's still a manual, occasional
// action. State updates only for rows that actually succeeded; the toast
// reports the real count, failures included.
// ---------------------------------------------------------------------------

const BULK_MOVE_BATCH_SIZE = 15;

export function useOutreachSelection(
  contacts: OutreachContact[],
  setContacts: Dispatch<SetStateAction<OutreachContact[]>>,
) {
  const { showToast } = useToast();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMoving, setBulkMoving] = useState(false);

  const toggleSelect = useCallback((contactId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }, []);

  const toggleSelectAllInStage = useCallback(
    (stageId: string) => {
      const idsInStage = contacts.filter((c) => c.stageId === stageId).map((c) => c.id);
      setSelectedIds((prev) => {
        const allSelected = idsInStage.length > 0 && idsInStage.every((id) => prev.has(id));
        const next = new Set(prev);
        for (const id of idsInStage) {
          if (allSelected) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    },
    [contacts],
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  async function bulkMove(targetStageId: string) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || bulkMoving) return;
    setBulkMoving(true);

    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i += BULK_MOVE_BATCH_SIZE) {
      const batch = ids.slice(i, i + BULK_MOVE_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((id) => api.patch<OutreachContact>(`/outreach/contacts/${id}`, { stageId: targetStageId })),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          succeeded++;
          const updated = result.value;
          setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        } else {
          failed++;
        }
      }
    }

    setBulkMoving(false);
    clearSelection();
    if (failed === 0) {
      showToast(`Moved ${succeeded} contact${succeeded !== 1 ? "s" : ""}`, "success");
    } else {
      showToast(`Moved ${succeeded}, ${failed} failed — try again for those`, "warning");
    }
  }

  return { selectedIds, bulkMoving, toggleSelect, toggleSelectAllInStage, clearSelection, bulkMove };
}
