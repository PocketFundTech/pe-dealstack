"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, NotFoundError } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OutreachColumn } from "./OutreachColumn";
import { ContactFormModal } from "./ContactFormModal";
import {
  emptyContactForm,
  contactToFormValues,
  sortStagesByPosition,
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

  const orderedStages = sortStagesByPosition(stages);

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
        email: values.email.trim() || undefined,
        phone: values.phone.trim() || undefined,
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
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {contacts.length} contact{contacts.length !== 1 ? "s" : ""} across {orderedStages.length} stage
          {orderedStages.length !== 1 ? "s" : ""}
        </p>
        <button
          type="button"
          disabled={orderedStages.length === 0}
          onClick={() => openCreate(orderedStages[0]?.id ?? "")}
          className="flex items-center gap-2 px-4 py-2 text-white rounded-lg shadow-sm hover:bg-[#002855] transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: "#003366" }}
        >
          <span className="material-symbols-outlined text-[18px]">person_add</span>
          Add Contact
        </button>
      </div>

      {orderedStages.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-surface-card p-8 text-center">
          <span className="material-symbols-outlined text-4xl text-text-muted mb-2 block">view_column</span>
          <p className="text-text-main font-medium">No pipeline stages configured</p>
          <p className="text-sm text-text-muted mt-1">Ask an admin to set up the outreach pipeline stages.</p>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {orderedStages.map((stage) => (
            <OutreachColumn
              key={stage.id}
              stage={stage}
              contacts={contacts.filter((c) => c.stageId === stage.id)}
              allStages={orderedStages}
              onAddContact={openCreate}
              onOpenContact={openEdit}
              onMoveContact={handleMove}
            />
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
