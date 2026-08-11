"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { formatRelativeTime, getInitials } from "@/lib/formatters";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  Contact, TYPE_CONFIG, LinkedDeal,
  ContactFormData, ContactModal, DeleteConfirmModal,
} from "./components";
import { LinkDealModal, ConnectionModal } from "./detail-modals";
import { IntegrationActivityFeed } from "@/components/integrations/IntegrationActivityFeed";
import { ContactEmailSummary } from "./ContactEmailSummary";
import { HubSpotFieldsCard } from "@/components/HubSpotFieldsCard";
import { ContactAskAI } from "./ContactAskAI";
import {
  Connection, ContactEnrichment, FollowUpSuggestion,
  INTERACTION_ICONS, STAGE_STYLES, RELATIONSHIP_TYPE_CONFIG,
  SUGGEST_FOLLOW_UP_TIMEOUT_MS, FOLLOW_UP_NOTE_MAX_LEN,
} from "./detail-panel-types";
import { InteractionStats, AddInteractionForm } from "./detail-panel-sections";
import { FollowUpSection, EnrichmentBox } from "./detail-panel-followup";

// ─── Detail Panel ──────────────────────────────────────────

export function DetailPanel({
  contactId, contactScores, onClose, onRefresh,
}: {
  contactId: string;
  contactScores: Record<string, { score: number; label: string }>;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [showInteractionForm, setShowInteractionForm] = useState(false);
  const [linkDealOpen, setLinkDealOpen] = useState(false);
  const [connectionModalOpen, setConnectionModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [unlinkDealId, setUnlinkDealId] = useState<string | null>(null);
  const [removeConnectionId, setRemoveConnectionId] = useState<string | null>(null);
  const [savingFollowUp, setSavingFollowUp] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichment, setEnrichment] = useState<ContactEnrichment | null>(null);
  const [suggestingFollowUp, setSuggestingFollowUp] = useState(false);
  const [followUpSuggestion, setFollowUpSuggestion] = useState<FollowUpSuggestion | null>(null);
  const [followUpSuggestFailed, setFollowUpSuggestFailed] = useState(false);
  const [pulseSuggestion, setPulseSuggestion] = useState(false);
  const { showToast } = useToast();

  const loadContact = useCallback(async () => {
    try {
      const data = await api.get<Contact>(`/contacts/${contactId}`);
      setContact(data);
    } catch (err) {
      console.warn("[contacts] loadContact failed:", err);
    }
    setLoading(false);
  }, [contactId]);

  const loadConnections = useCallback(async () => {
    try {
      const data = await api.get<{ connections: Connection[] }>(`/contacts/${contactId}/connections`);
      setConnections(data.connections || []);
    } catch (err) {
      console.warn("[contacts] loadConnections failed:", err);
      setConnections([]);
    }
  }, [contactId]);

  useEffect(() => { loadContact(); loadConnections(); }, [loadContact, loadConnections]);

  async function handleSaveContact(formData: ContactFormData) {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...formData };
      Object.keys(body).forEach((k) => { if (body[k] === "" || body[k] === undefined) delete body[k]; });
      if (formData.tags.length > 0) body.tags = formData.tags; else delete body.tags;
      await api.patch(`/contacts/${contactId}`, body);
      setEditModalOpen(false);
      await loadContact();
      onRefresh();
      showToast("Contact updated", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save contact", "error");
    }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    try {
      await api.delete(`/contacts/${contactId}`);
      setDeleteConfirmOpen(false);
      onClose();
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete contact", "error");
    }
  }

  // PATCH followUpAt. Pass null to clear. Optimistically reloads the contact.
  async function updateFollowUp(value: string | null) {
    setSavingFollowUp(true);
    try {
      await api.patch(`/contacts/${contactId}`, { followUpAt: value });
      await loadContact();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update follow-up", "error");
    } finally {
      setSavingFollowUp(false);
    }
  }

  // Cheap, genuinely-AI follow-up suggestion — a SINGLE bounded LLM call.
  // Does NOT run the full enrichment agent (no web scrape / research).
  // Races the request against a hard timeout so the spinner can't hang forever;
  // on timeout we surface a retry affordance instead of a perpetual "Thinking...".
  async function handleSuggestFollowUp() {
    setSuggestingFollowUp(true);
    setFollowUpSuggestFailed(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Suggestion timed out — please try again.")),
          SUGGEST_FOLLOW_UP_TIMEOUT_MS,
        );
      });
      const data = await Promise.race([
        api.post<FollowUpSuggestion>("/ai/suggest-follow-up", { contactId }),
        timeout,
      ]);
      setFollowUpSuggestion(data);
      setPulseSuggestion(true);
      setTimeout(() => setPulseSuggestion(false), 1500);
    } catch (err) {
      setFollowUpSuggestFailed(true);
      showToast(err instanceof Error ? err.message : "Failed to suggest a follow-up", "error");
    } finally {
      if (timer) clearTimeout(timer);
      setSuggestingFollowUp(false);
    }
  }

  // Apply a suggested follow-up: set the date AND persist the suggested action
  // text into the contact's follow-up note. We never clobber an existing note —
  // if the user already wrote one, theirs wins (the suggestion is advisory).
  async function applyFollowUpSuggestion(suggestion: FollowUpSuggestion) {
    setSavingFollowUp(true);
    try {
      const existingNote = (contact as { followUpNote?: string | null } | null)?.followUpNote?.trim();
      const body: Record<string, unknown> = { followUpAt: suggestion.date };
      if (!existingNote && suggestion.action.trim()) {
        // followUpNote is capped at 500 chars by the PATCH validator.
        body.followUpNote = suggestion.action.trim().slice(0, FOLLOW_UP_NOTE_MAX_LEN);
      }
      await api.patch(`/contacts/${contactId}`, body);
      await loadContact();
      setFollowUpSuggestion(null);
      showToast("Follow-up applied", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to apply follow-up", "error");
    } finally {
      setSavingFollowUp(false);
    }
  }

  async function handleAskAi() {
    setEnriching(true);
    try {
      const data = await api.post<ContactEnrichment>("/ai/enrich-contact", { contactId });
      setEnrichment(data);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to get AI suggestions", "error");
    } finally {
      setEnriching(false);
    }
  }

  async function performUnlinkDeal(dealId: string) {
    try {
      await api.delete(`/contacts/${contactId}/deals/${dealId}`);
      await loadContact();
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to unlink deal", "error");
    } finally {
      setUnlinkDealId(null);
    }
  }

  async function performDeleteConnection(connectionId: string) {
    try {
      await api.delete(`/contacts/${contactId}/connections/${connectionId}`);
      await loadConnections();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to remove connection", "error");
    } finally {
      setRemoveConnectionId(null);
    }
  }

  if (loading) {
    return (
      <>
        <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
        <div className="right-drawer fixed top-0 right-0 h-full w-[450px] max-w-full bg-surface-card shadow-2xl z-50 flex flex-col border-l border-border-subtle">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <h2 className="text-lg font-bold text-text-main">Contact Details</h2>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-text-muted"><span className="material-symbols-outlined text-[20px]">close</span></button>
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center"><span className="material-symbols-outlined text-primary text-3xl animate-spin mb-3">sync</span><p className="text-text-muted text-sm">Loading contact details...</p></div>
          </div>
        </div>
      </>
    );
  }

  if (!contact) return null;
  const tc = TYPE_CONFIG[contact.type] || TYPE_CONFIG.OTHER;
  const sortedInteractions = [...(contact.interactions || [])].sort((a, b) => new Date(b.date || b.createdAt).getTime() - new Date(a.date || a.createdAt).getTime());
  const tags = contact.tags || [];
  const linkedDeals = contact.linkedDeals || [];
  const scoreData = contactScores[contact.id];

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="right-drawer fixed top-0 right-0 h-full w-[450px] max-w-full bg-surface-card shadow-2xl z-50 flex flex-col border-l border-border-subtle">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle shrink-0">
          <h2 className="text-lg font-bold text-text-main">Contact Details</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-main transition-colors"><span className="material-symbols-outlined text-[20px]">close</span></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
          {/* Avatar + Name */}
          <div className="flex items-start gap-4 mb-6">
            <div className="size-14 rounded-full flex items-center justify-center shrink-0 text-lg font-bold shadow-sm" style={{ backgroundColor: tc.avatarBg, color: tc.avatarText }}>
              {getInitials(contact.firstName, contact.lastName)}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-bold text-text-main leading-tight">{contact.firstName} {contact.lastName}</h3>
              {contact.title && <p className="text-text-secondary text-sm mt-0.5">{contact.title}</p>}
              {contact.company && <p className="text-text-muted text-sm flex items-center gap-1 mt-0.5"><span className="material-symbols-outlined text-[14px]">business</span>{contact.company}</p>}
              <span className={cn("inline-block mt-2 px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider", tc.bg, tc.text)}>{tc.label}</span>
            </div>
          </div>

          {/* Contact Info */}
          <div className="mb-6">
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">Contact Information</h4>
            <div className="flex flex-col gap-2">
              {contact.email && <a href={`mailto:${contact.email}`} className="flex items-center gap-2.5 text-sm text-text-secondary hover:text-primary transition-colors p-2 rounded-lg hover:bg-primary-light/50"><span className="material-symbols-outlined text-[18px] text-text-muted">mail</span>{contact.email}</a>}
              {contact.phone && <a href={`tel:${contact.phone}`} className="flex items-center gap-2.5 text-sm text-text-secondary hover:text-primary transition-colors p-2 rounded-lg hover:bg-primary-light/50"><span className="material-symbols-outlined text-[18px] text-text-muted">call</span>{contact.phone}</a>}
              {contact.linkedinUrl && <a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 text-sm text-text-secondary hover:text-primary transition-colors p-2 rounded-lg hover:bg-primary-light/50"><span className="material-symbols-outlined text-[18px] text-text-muted">open_in_new</span>LinkedIn Profile</a>}
              {!contact.email && !contact.phone && !contact.linkedinUrl && <p className="text-text-muted text-sm italic p-2">No contact information added</p>}
            </div>
          </div>

          {/* HubSpot-imported fields (custom fields, lifecycle stage, etc.) */}
          {contact.hubspotProperties && (
            <div className="mb-6">
              <HubSpotFieldsCard properties={contact.hubspotProperties} />
            </div>
          )}

          {/* Email Summary (Gmail threads) */}
          <ContactEmailSummary contactId={contactId} />

          {/* Ask AI about this contact (scoped chat) */}
          <ContactAskAI contactId={contactId} contactName={contact.firstName || "this contact"} />

          {/* Follow-up */}
          <FollowUpSection
            followUpAt={contact.followUpAt}
            savingFollowUp={savingFollowUp}
            suggestingFollowUp={suggestingFollowUp}
            followUpSuggestion={followUpSuggestion}
            followUpSuggestFailed={followUpSuggestFailed}
            pulseSuggestion={pulseSuggestion}
            onSuggest={handleSuggestFollowUp}
            onUpdateFollowUp={updateFollowUp}
            onApplySuggestion={applyFollowUpSuggestion}
            onDismissSuggestion={() => setFollowUpSuggestion(null)}
          />

          {/* AI Suggestions */}
          {enrichment && (
            <EnrichmentBox
              enrichment={enrichment}
              savingFollowUp={savingFollowUp}
              onDismiss={() => setEnrichment(null)}
              onApplyFollowUpDate={(date) => updateFollowUp(date)}
            />
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <div className="mb-6">
              <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">Tags</h4>
              <div className="flex flex-wrap gap-1.5">{tags.map((t, i) => <span key={i} className="px-2.5 py-1 rounded-full bg-gray-50 text-text-secondary text-xs font-medium border border-border-subtle">{t}</span>)}</div>
            </div>
          )}

          {/* Connections */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted">Connections</h4>
              <button onClick={() => setConnectionModalOpen(true)} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-primary hover:bg-primary-light transition-colors">
                <span className="material-symbols-outlined text-[14px]">add</span> Add
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {connections.length === 0 ? <p className="text-text-muted text-sm italic">No connections yet</p> : connections.map((conn) => {
                const c = conn.contact || {} as Connection["contact"];
                const rtc = RELATIONSHIP_TYPE_CONFIG[conn.type] || { label: conn.type, icon: "link", bg: "bg-gray-100", text: "text-gray-700" };
                const ctc = TYPE_CONFIG[c.type] || TYPE_CONFIG.OTHER;
                return (
                  <div key={conn.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border-subtle hover:border-primary/30 hover:bg-primary-light/30 transition-all group">
                    <div className="size-8 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold" style={{ backgroundColor: ctc.avatarBg, color: ctc.avatarText }}>{getInitials(c.firstName, c.lastName)}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-main truncate group-hover:text-primary">{c.firstName} {c.lastName}</p>
                      <p className="text-[10px] text-text-muted truncate">{c.company || ""}{c.title ? " · " + c.title : ""}</p>
                    </div>
                    <span className={cn("px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider shrink-0", rtc.bg, rtc.text)}>{rtc.label}</span>
                    <button onClick={() => setRemoveConnectionId(conn.id)} className="p-1 rounded hover:bg-red-50 text-text-muted hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 shrink-0" title="Remove">
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Notes */}
          {contact.notes && (
            <div className="mb-6">
              <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">Notes</h4>
              <div className="p-3 bg-gray-50 rounded-lg border border-border-subtle text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{contact.notes}</div>
            </div>
          )}

          {/* Linked Deals */}
          <div className="mb-6">
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">Linked Deals <span className="text-text-muted">({linkedDeals.length})</span></h4>
            {linkedDeals.length === 0 ? <p className="text-text-muted text-sm italic">No linked deals</p> : (
              <div className="flex flex-col gap-2">
                {linkedDeals.map((d) => {
                  const deal = d.deal || {} as LinkedDeal["deal"];
                  const dealId = deal.id || d.dealId;
                  const ss = STAGE_STYLES[deal.stage] || { bg: "bg-gray-100", text: "text-gray-600", label: deal.stage };
                  return (
                    <div key={dealId} className="flex items-center justify-between p-3 rounded-lg border border-border-subtle hover:border-primary/30 hover:bg-primary-light/30 transition-all group">
                      <div className="flex items-center gap-2.5 flex-1 min-w-0">
                        <span className="material-symbols-outlined text-text-muted text-[18px] group-hover:text-primary">work</span>
                        <span className="text-sm font-medium text-text-main group-hover:text-primary truncate">{deal.name}</span>
                        {deal.stage && <span className={cn("px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider shrink-0", ss.bg, ss.text)}>{ss.label}</span>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {d.role && <span className="text-[10px] text-text-muted">{d.role}</span>}
                        <button onClick={() => setUnlinkDealId(dealId)} className="p-1 rounded hover:bg-red-50 text-text-muted hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100" title="Unlink deal">
                          <span className="material-symbols-outlined text-[16px]">link_off</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Interaction Stats */}
          {sortedInteractions.length > 0 && <InteractionStats interactions={sortedInteractions} scoreData={scoreData} />}

          {/* Add Interaction Form */}
          {showInteractionForm && <AddInteractionForm contactId={contactId} onDone={() => { setShowInteractionForm(false); loadContact(); onRefresh(); }} onCancel={() => setShowInteractionForm(false)} />}

          {/* Synced from connected tools (Granola / Gmail / Calendar) */}
          <div className="mb-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">Synced from your tools</h4>
            <IntegrationActivityFeed contactId={contactId} />
          </div>

          {/* Interaction Timeline */}
          <div className="mb-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">Interaction Timeline <span className="text-text-muted">({sortedInteractions.length})</span></h4>
            {sortedInteractions.length === 0 ? <p className="text-text-muted text-sm italic">No interactions recorded</p> : (
              <div className="flex flex-col gap-0">
                {sortedInteractions.map((inter, idx) => {
                  const icon = INTERACTION_ICONS[inter.type] || INTERACTION_ICONS.OTHER;
                  const isLast = idx === sortedInteractions.length - 1;
                  return (
                    <div key={inter.id} className="flex gap-3 relative">
                      {!isLast && <div className="absolute left-[15px] top-[32px] bottom-0 w-px bg-border-subtle" />}
                      <div className="size-[30px] rounded-full bg-gray-50 border border-border-subtle flex items-center justify-center shrink-0 z-10">
                        <span className="material-symbols-outlined text-text-muted text-[16px]">{icon}</span>
                      </div>
                      <div className="flex-1 pb-4 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-text-main truncate">{inter.title || inter.type}</p>
                          <span className="text-[11px] text-text-muted shrink-0">{formatRelativeTime(inter.date || inter.createdAt)}</span>
                        </div>
                        {inter.notes && <p className="text-xs text-text-secondary mt-1 leading-relaxed">{inter.notes}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Actions Bar — three labeled primary actions stretch evenly;
            Edit/Delete are icon-only so the row never wraps or clips in the
            450px panel. */}
        <div className="shrink-0 border-t border-border-subtle px-4 py-3 bg-surface-card">
          <div className="flex items-center gap-1.5">
            <button onClick={() => setShowInteractionForm(true)} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border border-border-subtle text-sm font-medium text-text-secondary whitespace-nowrap hover:border-primary/30 hover:text-primary hover:bg-primary-light/50 transition-all">
              <span className="material-symbols-outlined text-[16px]">edit_note</span>Add Note
            </button>
            <button onClick={() => setLinkDealOpen(true)} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border border-border-subtle text-sm font-medium text-text-secondary whitespace-nowrap hover:border-primary/30 hover:text-primary hover:bg-primary-light/50 transition-all">
              <span className="material-symbols-outlined text-[16px]">link</span>Link Deal
            </button>
            <button onClick={handleAskAi} disabled={enriching} className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border border-border-subtle text-sm font-medium text-text-secondary whitespace-nowrap hover:border-primary/30 hover:text-primary hover:bg-primary-light/50 transition-all disabled:opacity-50">
              <span className={cn("material-symbols-outlined text-[16px]", enriching && "animate-spin")}>{enriching ? "sync" : "auto_awesome"}</span>{enriching ? "Asking…" : "Ask AI"}
            </button>
            <div className="w-px h-6 bg-border-subtle mx-0.5 shrink-0" aria-hidden="true" />
            <button onClick={() => setEditModalOpen(true)} title="Edit contact" aria-label="Edit contact" className="shrink-0 p-2 rounded-lg border border-border-subtle text-text-secondary hover:border-primary/30 hover:text-primary hover:bg-primary-light/50 transition-all">
              <span className="material-symbols-outlined text-[18px] block">edit</span>
            </button>
            <button onClick={() => setDeleteConfirmOpen(true)} title="Delete contact" aria-label="Delete contact" className="shrink-0 p-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-all">
              <span className="material-symbols-outlined text-[18px] block">delete</span>
            </button>
          </div>
        </div>
      </div>

      {/* Sub-modals */}
      {linkDealOpen && <LinkDealModal contactId={contactId} linkedDeals={linkedDeals} onClose={() => setLinkDealOpen(false)} onLinked={() => { setLinkDealOpen(false); loadContact(); onRefresh(); }} />}
      {connectionModalOpen && <ConnectionModal contactId={contactId} onClose={() => setConnectionModalOpen(false)} onCreated={() => { setConnectionModalOpen(false); loadConnections(); }} />}
      {editModalOpen && <ContactModal contact={contact} saving={saving} onSave={handleSaveContact} onClose={() => setEditModalOpen(false)} />}
      {deleteConfirmOpen && <DeleteConfirmModal onConfirm={handleDelete} onCancel={() => setDeleteConfirmOpen(false)} />}
      <ConfirmDialog
        open={unlinkDealId !== null}
        title="Unlink Deal"
        message="Remove this deal link?"
        confirmLabel="Unlink"
        variant="danger"
        onConfirm={() => unlinkDealId && performUnlinkDeal(unlinkDealId)}
        onCancel={() => setUnlinkDealId(null)}
      />
      <ConfirmDialog
        open={removeConnectionId !== null}
        title="Remove Connection"
        message="Remove this connection?"
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => removeConnectionId && performDeleteConnection(removeConnectionId)}
        onCancel={() => setRemoveConnectionId(null)}
      />
    </>
  );
}
