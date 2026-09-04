"use client";

import { useCallback, useEffect, useState, type DragEvent } from "react";
import { api, ApiError, NotFoundError } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StageSummaryCard } from "./StageSummaryCard";
import { StageDetailModal } from "./StageDetailModal";
import { StaleContactsModal, STALE_STAGE_ID, STALE_VIEW_STAGE } from "./StaleContactsModal";
import { ContactFormModal } from "./ContactFormModal";
import { OutreachToolbar } from "./OutreachToolbar";
import { BulkActionsBar } from "./BulkActionsBar";
import { SendConfirmModal } from "./SendConfirmModal";
import { useOutreachSelection } from "./useOutreachSelection";
import { useOutreachSend } from "./useOutreachSend";
import { useOutreachReviewFlags } from "./useOutreachReviewFlags";
import { useOutreachStaleness } from "./useOutreachStaleness";
import { useOutreachSyncReplies } from "./useOutreachSyncReplies";
import {
  emptyContactForm,
  contactToFormValues,
  sortStagesByPosition,
  type EnrichContactResult,
  type OutreachContact,
  type OutreachContactFormValues,
  type OutreachStage,
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

  // Stage id currently being dragged over, if any — drives the dashed-border
  // highlight on OutreachColumn. Same pattern as deals-page-kanban-view.tsx.
  const [dragOverStageId, setDragOverStageId] = useState<string | null>(null);

  // Stage id whose full contact list is open, if any — the board's default
  // view is StageSummaryCard tiles only (see that file's header comment for
  // why); clicking one opens StageDetailModal for that single stage.
  const [openStageId, setOpenStageId] = useState<string | null>(null);

  const orderedStages = sortStagesByPosition(stages);
  // Lowest-position ("Source") stage — see resolveAutoAdvanceStage in
  // outreachEnrichment.ts. Reused for "Enrich all" + as the fallback add-stage.
  const sourceStageId = orderedStages[0]?.id;
  // Real (non-synthetic) stage whose contact list is open, if any.
  const openStage =
    openStageId && openStageId !== STALE_STAGE_ID ? (orderedStages.find((s) => s.id === openStageId) ?? null) : null;

  const {
    selectedIds,
    bulkMoving,
    bulkEnriching,
    toggleSelect,
    toggleSelectAllInStage,
    clearSelection,
    bulkMove,
    bulkEnrich,
    enrichAllInStage,
  } = useOutreachSelection(contacts, setContacts);

  // Computed cross-cutting filter over `contacts`, not a real stage — see useOutreachStaleness.ts.
  const { staleContacts } = useOutreachStaleness(contacts);

  const { sendModalContacts, sending, openSendModal, closeSendModal, confirmSend } = useOutreachSend(setContacts);

  const { markingReviewedId, confirmingMatchReviewId, markReviewed, confirmMatchReview } = useOutreachReviewFlags(
    setContacts,
    setEditingContact,
  );

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

  const { syncingReplies, handleSyncReplies } = useOutreachSyncReplies(loadBoard);

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

  // Shared by StageDetailModal + the Stale view — opens SendConfirmModal for one contact.
  function handleSendContact(contactId: string) {
    const target = contacts.find((c) => c.id === contactId);
    if (target) openSendModal([target]);
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
        onAddContact={() => openCreate(sourceStageId ?? "")}
      />

      <BulkActionsBar
        count={selectedIds.size}
        stages={orderedStages}
        moving={bulkMoving}
        enriching={bulkEnriching}
        sending={sending}
        onMove={bulkMove}
        onEnrich={bulkEnrich}
        onSend={() => openSendModal(contacts.filter((c) => selectedIds.has(c.id)))}
        onClear={clearSelection}
      />

      {orderedStages.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-surface-card p-8 text-center">
          <span className="material-symbols-outlined text-4xl text-text-muted mb-2 block">view_column</span>
          <p className="text-text-main font-medium">No pipeline stages configured</p>
          <p className="text-sm text-text-muted mt-1">Ask an admin to set up the outreach pipeline stages.</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {orderedStages.map((stage) => (
            <StageSummaryCard
              key={stage.id}
              stage={stage}
              contacts={contacts.filter((c) => c.stageId === stage.id)}
              onOpen={setOpenStageId}
              // Only the Source stage gets "Enrich all" — see enrichAllInStage.
              onEnrichAll={
                stage.id === sourceStageId
                  ? () => enrichAllInStage(contacts.filter((c) => c.stageId === sourceStageId).map((c) => c.id))
                  : undefined
              }
              enriching={stage.id === sourceStageId ? bulkEnriching : undefined}
            />
          ))}
          <StageSummaryCard
            stage={STALE_VIEW_STAGE}
            contacts={staleContacts}
            onOpen={setOpenStageId}
            icon="schedule"
          />
        </div>
      )}

      {openStageId === STALE_STAGE_ID && (
        <StaleContactsModal
          contacts={staleContacts}
          allStages={orderedStages}
          defaultAddStageId={sourceStageId ?? ""}
          onClose={() => setOpenStageId(null)}
          onAddContact={openCreate}
          onOpenContact={openEdit}
          onMoveContact={handleMove}
          onEnrichContact={handleEnrich}
          enrichingContactId={enrichingId}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSendContact={handleSendContact}
        />
      )}

      {openStage && (
        <StageDetailModal
          stage={openStage}
          contacts={contacts.filter((c) => c.stageId === openStage.id)}
          allStages={orderedStages}
          onClose={() => setOpenStageId(null)}
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
          onSendContact={handleSendContact}
        />
      )}

      {formOpen && (
        <ContactFormModal
          mode={formMode}
          contact={editingContact}
          stages={orderedStages}
          initialValues={
            formMode === "edit" && editingContact
              ? contactToFormValues(editingContact)
              : emptyContactForm(formStageId || sourceStageId || "")
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
            formMode === "edit" && editingContact ? () => markReviewed(editingContact.id) : undefined
          }
          confirmingMatchReview={
            formMode === "edit" && editingContact ? confirmingMatchReviewId === editingContact.id : false
          }
          onConfirmMatchReview={
            formMode === "edit" && editingContact
              ? () => confirmMatchReview(editingContact.id)
              : undefined
          }
          onSend={
            formMode === "edit" && editingContact ? () => openSendModal([editingContact]) : undefined
          }
        />
      )}

      {sendModalContacts && (
        <SendConfirmModal
          contacts={sendModalContacts}
          sending={sending}
          onConfirm={confirmSend}
          onClose={closeSendModal}
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
