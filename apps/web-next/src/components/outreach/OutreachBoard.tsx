"use client";

import { useCallback, useEffect, useState, type DragEvent } from "react";
import { api, ApiError, NotFoundError } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OutreachColumn } from "./OutreachColumn";
import { ContactFormModal } from "./ContactFormModal";
import { OutreachToolbar } from "./OutreachToolbar";
import { BulkActionsBar } from "./BulkActionsBar";
import { useOutreachSelection } from "./useOutreachSelection";
import {
  emptyContactForm,
  contactToFormValues,
  sortStagesByPosition,
  type EnrichContactResult,
  type OutreachContact,
  type OutreachContactFormValues,
  type OutreachStage,
  type SyncRepliesResult,
} from "./types";

// ---------------------------------------------------------------------------
// Outreach Kanban board — the "authorized" content of
// app/(app)/outreach/page.tsx. Fetches stages + contacts from the /outreach
// API (built in parallel under apps/api/), renders one column per stage, and
// handles create / move / edit / delete for contacts.
// ---------------------------------------------------------------------------
export function OutreachBoard() {
  const { showToast } = useToast();

  const [stages, setStages] = useState<OutreachStage[]>([]);
  const [contacts, setContacts] = useState<OutreachContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notLive, setNotLive] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [formStageId, setFormStageId] = useState<string>("");
  const [editingContact, setEditingContact] = useState<OutreachContact | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<OutreachContact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Contact id currently mid-enrichment, if any — drives the loading state on
  // the "Enrich" action wherever it's triggered from (card menu or modal).
  const [enrichingId, setEnrichingId] = useState<string | null>(null);

  // Contact id currently having its "needs review" flag cleared, if any —
  // drives the loading state on the modal's "Mark reviewed" action.
  const [markingReviewedId, setMarkingReviewedId] = useState<string | null>(null);

  // True while a board-wide POST /outreach/sync-replies call is in flight —
  // drives the loading state on the "Sync Replies" header button.
  const [syncingReplies, setSyncingReplies] = useState(false);

  // Contact id currently having its "needs match review" flag cleared, if
  // any — drives the loading state on the modal's "Confirm as new contact"
  // action. Separate from markingReviewedId above: needsMatchReview is a
  // bulk-import duplicate-detection concern, not reply-intent review.
  const [confirmingMatchReviewId, setConfirmingMatchReviewId] = useState<string | null>(null);

  // Stage id currently being dragged over, if any — drives the dashed-border
  // highlight on OutreachColumn. Same pattern as deals-page-kanban-view.tsx.
  const [dragOverStageId, setDragOverStageId] = useState<string | null>(null);

  const orderedStages = sortStagesByPosition(stages);

  const { selectedIds, bulkMoving, toggleSelect, toggleSelectAllInStage, clearSelection, bulkMove } =
    useOutreachSelection(contacts, setContacts);

  // ─── Load ───────────────────────────────────────────────────────────────

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNotLive(false);
    try {
      // The API wraps list responses in a named field
      // (`{ stages: [...] }` / `{ contacts: [...] }`) rather than returning
      // bare arrays — see apps/api/src/routes/outreach.ts.
      const [stagesData, contactsData] = await Promise.all([
        api.get<{ stages: OutreachStage[] }>("/outreach/stages"),
        api.get<{ contacts: OutreachContact[] }>("/outreach/contacts"),
      ]);
      setStages(stagesData?.stages || []);
      setContacts(contactsData?.contacts || []);
    } catch (err) {
      // The outreach backend is being built in parallel — treat "not found"
      // as "not deployed yet" rather than a hard error, matching the pattern
      // used elsewhere for endpoints that may not exist yet (see
      // DealTeasers.tsx / FirmTeaserSection.tsx).
      if (err instanceof NotFoundError) {
        setNotLive(true);
      } else {
        const message = err instanceof ApiError ? err.message : "Failed to load the outreach board";
        setLoadError(message);
        showToast(message, "error");
      }
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  // ─── Form open/close ────────────────────────────────────────────────────

  function openCreate(stageId: string) {
    setFormMode("create");
    setEditingContact(null);
    setFormStageId(stageId);
    setFormOpen(true);
  }

  function openEdit(contact: OutreachContact) {
    setFormMode("edit");
    setEditingContact(contact);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingContact(null);
  }

  // ─── Create / edit ──────────────────────────────────────────────────────

  async function handleSave(values: OutreachContactFormValues) {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        stageId: values.stageId,
        name: values.name,
        channel: values.channel,
        company: values.company.trim() || undefined,
        title: values.title.trim() || undefined,
        email: values.email.trim() || undefined,
        phone: values.phone.trim() || undefined,
        linkedinUrl: values.linkedinUrl.trim() || undefined,
        notes: values.notes.trim() || undefined,
      };

      if (formMode === "edit" && editingContact) {
        const updated = await api.patch<OutreachContact>(`/outreach/contacts/${editingContact.id}`, body);
        setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        showToast("Contact updated", "success");
      } else {
        const created = await api.post<OutreachContact>("/outreach/contacts", body);
        setContacts((prev) => [...prev, created]);
        showToast("Contact added", "success");
      }
      closeForm();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save contact";
      showToast(message, "error");
    } finally {
      setSaving(false);
    }
  }

  // ─── Move between stages (optimistic, rolled back on failure) ─────────

  async function handleMove(contactId: string, stageId: string) {
    const snapshot = contacts;
    setContacts((prev) => prev.map((c) => (c.id === contactId ? { ...c, stageId } : c)));
    try {
      const updated = await api.patch<OutreachContact>(`/outreach/contacts/${contactId}`, { stageId });
      setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      setContacts(snapshot);
      const message = err instanceof ApiError ? err.message : "Failed to move contact";
      showToast(message, "error");
    }
  }

  // Drag-and-drop is just a gesture for triggering the same move — no
  // separate mutation logic, reuses handleMove's optimistic update/rollback.
  function handleDrop(e: DragEvent<HTMLDivElement>, stageId: string) {
    e.preventDefault();
    setDragOverStageId(null);
    const contactId = e.dataTransfer.getData("text/plain");
    if (!contactId) return;
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact || contact.stageId === stageId) return;
    handleMove(contactId, stageId);
  }

  // ─── Delete ─────────────────────────────────────────────────────────────

  function requestDelete() {
    if (editingContact) setDeleteTarget(editingContact);
  }

  async function performDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.delete(`/outreach/contacts/${deleteTarget.id}`);
      setContacts((prev) => prev.filter((c) => c.id !== deleteTarget.id));
      showToast("Contact deleted", "success");
      setDeleteTarget(null);
      closeForm();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to delete contact";
      showToast(message, "error");
    } finally {
      setDeleting(false);
    }
  }

  // ─── Enrich ─────────────────────────────────────────────────────────────
  // Providers (Clay/Apollo/Anymail) may not be configured yet — that's the
  // expected/normal state right now, surfaced as an info toast rather than
  // an error. When a provider did run, the endpoint returns the updated
  // contact directly, same shape as PATCH.

  async function handleEnrich(contactId: string) {
    if (enrichingId) return;
    setEnrichingId(contactId);
    try {
      const result = await api.post<EnrichContactResult>(`/outreach/contacts/${contactId}/enrich`, {});
      if ("enriched" in result && result.enriched === false) {
        showToast(result.reason, "info");
      } else {
        const updated = result as OutreachContact;
        setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        setEditingContact((prev) => (prev && prev.id === updated.id ? updated : prev));
        showToast("Contact enriched", "success");
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to enrich contact";
      showToast(message, "error");
    } finally {
      setEnrichingId(null);
    }
  }

  // ─── Mark reviewed ──────────────────────────────────────────────────────
  // Clears a flagged contact's needsReview flag once a human has read the
  // reply and made a judgment call. A plain partial PATCH, same pattern as
  // handleMove above.

  async function handleMarkReviewed(contactId: string) {
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

  // ─── Confirm as new contact (clears needsMatchReview) ──────────────────
  // Clears a bulk-import duplicate-detection flag once a human has checked
  // the contact isn't actually a duplicate. Same plain-PATCH shape as
  // handleMarkReviewed above, but a distinct field — needsMatchReview is a
  // Private Circle import concern, unrelated to reply-intent review. No
  // merge UI here by design; combining duplicate records stays a manual,
  // out-of-band step.

  async function handleConfirmMatchReview(contactId: string) {
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

  // ─── Sync replies ───────────────────────────────────────────────────────
  // Board-level "check for new replies" action — pulls from Reply.io and
  // runs Claude intent-classification server-side. Reply.io may not be
  // configured yet, same "not run" idiom as handleEnrich above. On success,
  // refetch the whole board so any newly-updated lastReplyText/replyIntent/
  // needsReview show up across every card.

  async function handleSyncReplies() {
    if (syncingReplies) return;
    setSyncingReplies(true);
    try {
      const result = await api.post<SyncRepliesResult>("/outreach/sync-replies", {});
      if ("reason" in result) {
        showToast(result.reason, "info");
      } else {
        const { checked, newReplies, flaggedForReview } = result;
        await loadBoard();
        const contactWord = `contact${checked !== 1 ? "s" : ""}`;
        if (newReplies === 0) {
          showToast(`Checked ${checked} ${contactWord} — no new replies`, "success");
        } else {
          const replyWord = newReplies === 1 ? "reply" : "replies";
          const reviewPart =
            flaggedForReview > 0
              ? `, ${flaggedForReview} need${flaggedForReview === 1 ? "s" : ""} review`
              : "";
          showToast(
            `Checked ${checked} ${contactWord} — ${newReplies} new ${replyWord}${reviewPart}`,
            "success",
          );
        }
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to sync replies";
      showToast(message, "error");
    } finally {
      setSyncingReplies(false);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center text-text-muted">
          <span className="material-symbols-outlined text-4xl animate-spin">progress_activity</span>
          <p className="mt-2 text-sm">Loading outreach board...</p>
        </div>
      </div>
    );
  }

  if (notLive) {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface-card p-8 text-center">
        <span className="material-symbols-outlined text-4xl text-text-muted mb-2 block">construction</span>
        <p className="text-text-main font-medium">Outreach board isn&apos;t live yet</p>
        <p className="text-sm text-text-muted mt-1">Check back shortly — this feature is still being wired up.</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <span className="material-symbols-outlined text-red-500 text-4xl mb-4">error</span>
        <p className="text-text-main font-medium mb-2">Failed to load the outreach board</p>
        <p className="text-sm text-text-muted mb-4">{loadError}</p>
        <button
          type="button"
          onClick={loadBoard}
          className="px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-colors"
          style={{ backgroundColor: "#003366" }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <OutreachToolbar
        contactCount={contacts.length}
        stageCount={orderedStages.length}
        onImported={loadBoard}
        syncingReplies={syncingReplies}
        onSyncReplies={handleSyncReplies}
        canAddContact={orderedStages.length > 0}
        onAddContact={() => openCreate(orderedStages[0]?.id ?? "")}
      />

      <BulkActionsBar
        count={selectedIds.size}
        stages={orderedStages}
        moving={bulkMoving}
        onMove={bulkMove}
        onClear={clearSelection}
      />

      {orderedStages.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-surface-card p-8 text-center">
          <span className="material-symbols-outlined text-4xl text-text-muted mb-2 block">view_column</span>
          <p className="text-text-main font-medium">No pipeline stages configured</p>
          <p className="text-sm text-text-muted mt-1">Ask an admin to set up the outreach pipeline stages.</p>
        </div>
      ) : (
        <div className="flex items-stretch gap-1">
          {orderedStages.map((stage, index) => (
            <div key={stage.id} className="flex items-stretch flex-1 min-w-0">
              <OutreachColumn
                stage={stage}
                contacts={contacts.filter((c) => c.stageId === stage.id)}
                allStages={orderedStages}
                onAddContact={openCreate}
                onOpenContact={openEdit}
                onMoveContact={handleMove}
                onEnrichContact={handleEnrich}
                enrichingContactId={enrichingId}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onToggleSelectAll={toggleSelectAllInStage}
                dragOverStageId={dragOverStageId}
                onDragOverStage={setDragOverStageId}
                onDragLeaveStage={() => setDragOverStageId(null)}
                onDropOnStage={handleDrop}
              />
              {index < orderedStages.length - 1 && (
                <div className="flex items-center justify-center w-6 shrink-0 text-text-muted/60" aria-hidden="true">
                  <span className="material-symbols-outlined text-[20px]">arrow_forward</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <ContactFormModal
          mode={formMode}
          contact={editingContact}
          stages={orderedStages}
          initialValues={
            formMode === "edit" && editingContact
              ? contactToFormValues(editingContact)
              : emptyContactForm(formStageId || orderedStages[0]?.id || "")
          }
          saving={saving}
          onSave={handleSave}
          onDelete={formMode === "edit" ? requestDelete : undefined}
          onClose={closeForm}
          enriching={formMode === "edit" && editingContact ? enrichingId === editingContact.id : false}
          onEnrich={
            formMode === "edit" && editingContact ? () => handleEnrich(editingContact.id) : undefined
          }
          markingReviewed={
            formMode === "edit" && editingContact ? markingReviewedId === editingContact.id : false
          }
          onMarkReviewed={
            formMode === "edit" && editingContact ? () => handleMarkReviewed(editingContact.id) : undefined
          }
          confirmingMatchReview={
            formMode === "edit" && editingContact ? confirmingMatchReviewId === editingContact.id : false
          }
          onConfirmMatchReview={
            formMode === "edit" && editingContact
              ? () => handleConfirmMatchReview(editingContact.id)
              : undefined
          }
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Contact"
        message={`Remove ${deleteTarget?.name ?? "this contact"} from the outreach pipeline? This action cannot be undone.`}
        confirmLabel={deleting ? "Deleting..." : "Delete"}
        variant="danger"
        onConfirm={performDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
