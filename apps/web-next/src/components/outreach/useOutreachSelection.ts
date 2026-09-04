"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import type { EnrichContactResult, OutreachContact } from "./types";

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
// Lower than the move batch size — each enrich call fans out to up to 3
// provider calls with 15-20s timeouts (see outreachEnrichment.ts), not a
// single fast DB write. Client-side fan-out, so no server-timeout risk like
// the import route's now-removed uncapped auto-enrichment loop had — each
// call is its own request, not one server function racing a shared clock —
// this batch size is purely about not hammering the API/providers at once.
const BULK_ENRICH_BATCH_SIZE = 5;

export function useOutreachSelection(
  contacts: OutreachContact[],
  setContacts: Dispatch<SetStateAction<OutreachContact[]>>,
) {
  const { showToast } = useToast();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMoving, setBulkMoving] = useState(false);
  const [bulkEnriching, setBulkEnriching] = useState(false);

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

  // Distinguishes "found something" from "ran but found nothing" the same
  // way the per-card badge does — compares enrichmentSource length before
  // and after, since the enrich endpoint always returns 200 with an
  // updated contact even when no provider matched (see
  // outreachEnrichment.ts's enrichContact — enrichedAt/enrichmentData
  // record the attempt itself). Most selected contacts on a real
  // Private Circle/Clay-imported board will land in "found nothing" —
  // they're company-only rows with no real decision-maker name, so Apollo/
  // Anymail short-circuit to 'no_person' (see looksLikeCompanyNameOnly) —
  // that's expected, not a bug, and the toast says so rather than reading
  // as a silent failure.
  //
  // Shared by both entry points below: `bulkEnrich()` (whatever's currently
  // in `selectedIds`) and `enrichAllInStage()` (a caller-supplied id list,
  // used by the Source stage tile's "Enrich all" quick action) — same
  // batching/toast reporting either way, only how `ids` gets sourced
  // differs, so the fan-out loop itself isn't duplicated between them.
  async function enrichContactIds(ids: string[]) {
    if (ids.length === 0 || bulkEnriching) return;
    setBulkEnriching(true);

    let enriched = 0;
    let foundNothing = 0;
    let failed = 0;
    let notConfigured = false;

    for (let i = 0; i < ids.length; i += BULK_ENRICH_BATCH_SIZE) {
      const batch = ids.slice(i, i + BULK_ENRICH_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((id) => api.post<EnrichContactResult>(`/outreach/contacts/${id}/enrich`, {})),
      );
      results.forEach((result, j) => {
        if (result.status !== "fulfilled") {
          failed++;
          return;
        }
        const value = result.value;
        if ("enriched" in value) {
          // EnrichNotRunResult — no providers configured. TS won't narrow
          // `value` to OutreachContact from an `"enriched" in value` check
          // alone (OutreachContact has no `enriched` field, but the
          // narrowing isn't picked up through the .forEach callback), so
          // this branch is on the property's presence, not its value.
          notConfigured = true;
          return;
        }
        const updated: OutreachContact = value;
        const contactId = batch[j];
        const before = contacts.find((c) => c.id === contactId);
        const gainedSource = (updated.enrichmentSource?.length ?? 0) > (before?.enrichmentSource?.length ?? 0);
        if (gainedSource) enriched++;
        else foundNothing++;
        setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      });
    }

    setBulkEnriching(false);
    clearSelection();

    if (notConfigured && enriched === 0 && foundNothing === 0 && failed === 0) {
      showToast("No enrichment providers configured yet", "info");
      return;
    }
    const parts: string[] = [];
    if (enriched > 0) parts.push(`${enriched} enriched`);
    if (foundNothing > 0) parts.push(`${foundNothing} found nothing`);
    if (failed > 0) parts.push(`${failed} failed`);
    showToast(parts.join(", ") || "No changes", enriched > 0 ? "success" : "warning");
  }

  async function bulkEnrich() {
    await enrichContactIds(Array.from(selectedIds));
  }

  // One-shot "select exactly these, then enrich" — deliberately NOT built
  // on toggleSelectAllInStage (that one TOGGLES, so calling it when some
  // but not all of the stage is already selected could deselect instead of
  // select-all). Replaces the selection outright so the result is always
  // "exactly this stage's contacts", then reuses the same fan-out as
  // bulkEnrich above.
  async function enrichAllInStage(contactIds: string[]) {
    setSelectedIds(new Set(contactIds));
    await enrichContactIds(contactIds);
  }

  return {
    selectedIds,
    bulkMoving,
    bulkEnriching,
    toggleSelect,
    toggleSelectAllInStage,
    clearSelection,
    bulkMove,
    bulkEnrich,
    enrichAllInStage,
  };
}
