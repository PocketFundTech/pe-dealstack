"use client";

import { useCallback, useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

import {
  MemoSection,
  Memo,
  ChatMessage,
  DealOption,
  TemplateOption,
  MemoListSidebar,
  MemoOutlineSidebar,
  MemoEditor,
  MemoChat,
  MemoChatCollapsed,
  CreateMemoModal,
  AddSectionModal,
} from "./components";
import { DocumentHeaderBar } from "./header-bar";
import { DeleteMemoConfirm, applyMemoDeleted, type PendingDeleteMemo } from "./delete-memo";
import { GeneratingOverlay } from "./generating-overlay";
import {
  MemoBreadcrumb,
  MemoEmptyState,
  MemoLoadingState,
  SuccessToast,
  ErrorToast,
} from "./page-views";
import {
  createGenerateSection,
  createSaveSection,
  createAddSection,
  createDeleteSection,
  createGenerateAll,
} from "./section-handlers";
import {
  createExportPDF,
  createExportMarkdown,
  createExportClipboard,
  createShare,
  createMemoHandler,
} from "./export-handlers";
import { createSendMessage } from "./chat-handler";
import {
  useLoadMemos,
  useLoadMemo,
  useOpenCreateModal,
  useDealIdEffect,
  useMemoIdEffect,
} from "./data-loaders";

export default function MemoBuilderPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
          <div className="size-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <MemoBuilderPageInner />
    </Suspense>
  );
}

function MemoBuilderPageInner() {
  const searchParams = useSearchParams();
  const urlDealId = searchParams.get("dealId");
  const urlMemoId = searchParams.get("memoId");
  const urlFromChat = searchParams.get("fromChat");
  /* ---- State ---- */
  const [memos, setMemos] = useState<Memo[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listSearch, setListSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [selectedMemo, setSelectedMemo] = useState<Memo | null>(null);
  const [sections, setSections] = useState<MemoSection[]>([]);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [loadingMemo, setLoadingMemo] = useState(false);
  const [editingContent, setEditingContent] = useState<Record<string, string>>({});
  const [generatingSection, setGeneratingSection] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Free up horizontal space for the AI Analyst panel by asking the sidebar
  // to collapse while chat is open. The sidebar restores the user's saved
  // preference when we un-force on close / unmount, so this never overwrites
  // their manual choice in localStorage.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("sidebar:auto-collapse", { detail: { collapsed: chatOpen } }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent("sidebar:auto-collapse", { detail: { collapsed: false } }),
      );
    };
  }, [chatOpen]);
  const [showCreate, setShowCreate] = useState(false);
  const [deals, setDeals] = useState<DealOption[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [createForm, setCreateForm] = useState({ dealId: "", templateId: "", title: "Investment Committee Memo" });
  const [creatingMemo, setCreatingMemo] = useState(false);
  const [showAddSection, setShowAddSection] = useState(false);
  const [addSectionType, setAddSectionType] = useState("CUSTOM");
  const [addSectionTitle, setAddSectionTitle] = useState("");
  const [addSectionAI, setAddSectionAI] = useState(true);
  const [addingSectionLoading, setAddingSectionLoading] = useState(false);
  const [pendingDeleteSection, setPendingDeleteSection] = useState<{ id: string; title: string } | null>(null);
  const [pendingDeleteMemo, setPendingDeleteMemo] = useState<PendingDeleteMemo | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [autoCreating, setAutoCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  /* ---- Data loading ---- */
  const loadMemos = useLoadMemos({ statusFilter, setMemos, setLoadingList });
  useEffect(() => { loadMemos(); }, [loadMemos]);

  const loadMemo = useLoadMemo({
    setLoadingMemo,
    setError,
    setSelectedMemo,
    setSections,
    setEditingContent,
    setActiveSection,
    setMessages,
  });

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  /* ---- Filtered list ---- */
  const filteredMemos = memos.filter((m) => {
    if (listSearch) {
      const q = listSearch.toLowerCase();
      if (!m.title.toLowerCase().includes(q) && !(m.projectName || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  /* ---- Create memo ---- */
  const openCreateModal = useOpenCreateModal({ setShowCreate, setCreateForm, setDeals, setTemplates });

  // Defer-fire mechanism for handleGenerateAll: handlers below need to call
  // it after creating a memo, but it's defined further down (depends on
  // sectionDeps which itself depends on selectedMemo). We stash a memoId in
  // state; a useEffect lower in the file watches selectedMemo and fires
  // handleGenerateAll when the memoId matches. Avoids stale-closure bugs
  // where handleGenerateAll's selectedMemo would be the previous memo.
  const [pendingGenerateMemoId, setPendingGenerateMemoId] = useState<string | null>(null);

  // useCallback so these have stable identity across renders. Otherwise
  // useDealIdEffect's dep array changes every render, the effect tears
  // down + reruns, and the cleanup sets cancelled=true on the in-flight
  // IIFE — which means the trailing onTriggerGenerateAll(createdId) call
  // (gated by !cancelled) gets skipped. That's why /generate-all wasn't
  // firing on chat-redirect even though suggest-meta + create succeeded.
  const triggerGenerateAll = useCallback((memoId: string) => {
    setPendingGenerateMemoId(memoId);
  }, []);
  const handleAutoCreateStart = useCallback(() => setAutoCreating(true), []);
  const handleAutoCreateEnd = useCallback(() => setAutoCreating(false), []);

  // URL ?dealId=X / ?memoId=X consumption — see data-loaders.ts for details.
  useDealIdEffect(
    urlDealId,
    urlFromChat,
    loadMemo,
    openCreateModal,
    handleAutoCreateStart,
    handleAutoCreateEnd,
    setError,
    triggerGenerateAll,
  );
  useMemoIdEffect(urlMemoId, loadMemo);

  const handleCreate = createMemoHandler({
    createForm,
    setMemos,
    setShowCreate,
    setCreateForm,
    setCreatingMemo,
    setError,
    loadMemo,
    triggerGenerateAll,
  });

  /* ---- Section actions ---- */
  const sectionDeps = {
    selectedMemo,
    sections,
    editingContent,
    activeSection,
    addSectionType,
    addSectionTitle,
    addSectionAI,
    setSections,
    setEditingContent,
    setActiveSection,
    setGeneratingSection,
    setSavingSection,
    setShowAddSection,
    setAddSectionTitle,
    setAddSectionType,
    setAddingSectionLoading,
    setPendingDeleteSection,
    setGeneratingAll,
    setGenerationStatus,
    setError,
  };
  const handleGenerate = createGenerateSection(sectionDeps);
  const handleSaveSection = createSaveSection(sectionDeps);
  const handleAddSection = createAddSection(sectionDeps, handleGenerate);
  const handleDeleteSection = createDeleteSection(sectionDeps);
  const handleGenerateAll = createGenerateAll(sectionDeps);

  // Fire deferred /generate-all once selectedMemo matches the pending id.
  // Ref avoids re-firing on handleGenerateAll identity churn (it's recreated
  // every render). Effect depends only on the trigger flag + memo identity.
  const handleGenerateAllRef = useRef(handleGenerateAll);
  useEffect(() => {
    handleGenerateAllRef.current = handleGenerateAll;
  }, [handleGenerateAll]);
  useEffect(() => {
    if (!pendingGenerateMemoId) return;
    if (!selectedMemo || selectedMemo.id !== pendingGenerateMemoId) return;
    // Clear the trigger flag so the effect only fires once per pending id.
    // Without this clear we'd re-enter every render until the memo changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingGenerateMemoId(null);
    handleGenerateAllRef.current();
  }, [pendingGenerateMemoId, selectedMemo]);

  /* ---- Export + Share ---- */

  // Auto-dismiss success toasts after 3s
  useEffect(() => {
    if (!successToast) return;
    const t = setTimeout(() => setSuccessToast(null), 3000);
    return () => clearTimeout(t);
  }, [successToast]);

  // Close export menu on outside click
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [exportMenuOpen]);

  const exportDeps = {
    selectedMemo,
    sections,
    editingContent,
    setExportMenuOpen,
    setSuccessToast,
    setError,
  };
  const handleExportPDF = createExportPDF(exportDeps);
  const handleExportMarkdown = createExportMarkdown(exportDeps);
  const handleExportClipboard = createExportClipboard(exportDeps);
  const handleShare = createShare(exportDeps);

  /* ---- Chat ---- */
  const sendMessage = createSendMessage({
    selectedMemo,
    chatInput,
    setChatInput,
    setMessages,
    setSendingChat,
    setSuccessToast,
    loadMemo,
  });

  /* ---- Render ---- */

  // Pick the highest-priority overlay status (one overlay at a time).
  // Note: creation is fast now (autoGenerate: false). Section generation runs
  // after via /generate-all and surfaces under the generatingAll slot, so the
  // overlay text transitions create → generate as the flow progresses.
  const overlayStatus = autoCreating
    ? "Setting up memo from deal context..."
    : creatingMemo
    ? "Creating memo..."
    : generatingAll
    ? (generationStatus ?? "Generating all memo sections...")
    : null;

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden min-w-0">
      {overlayStatus && <GeneratingOverlay status={overlayStatus} />}
      {/* ---- Left sidebar: memo list ---- */}
      <MemoListSidebar
        memos={memos}
        selectedMemoId={selectedMemo?.id}
        loadingList={loadingList}
        listSearch={listSearch}
        setListSearch={setListSearch}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onSelectMemo={loadMemo}
        onCreateNew={() => openCreateModal()}
        onDelete={(id) => {
          setPendingDeleteMemo({
            id,
            title: memos.find((m) => m.id === id)?.title ?? "this memo",
          });
        }}
        filteredMemos={filteredMemos}
      />

      {/* ---- Main column: breadcrumb + header + workspace ---- */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <MemoBreadcrumb selectedMemo={selectedMemo} onClearMemo={() => setSelectedMemo(null)} />

        {!selectedMemo ? (
          /* Empty state — matches legacy showEmptyMemoState */
          <MemoEmptyState onCreate={() => openCreateModal()} />
        ) : loadingMemo ? (
          <MemoLoadingState />
        ) : (
          <>
            <DocumentHeaderBar
              memo={selectedMemo}
              sections={sections}
              generatingAll={generatingAll}
              exportMenuOpen={exportMenuOpen}
              setExportMenuOpen={setExportMenuOpen}
              exportMenuRef={exportMenuRef}
              onGenerateAll={handleGenerateAll}
              onShare={handleShare}
              onExportPDF={handleExportPDF}
              onExportMarkdown={handleExportMarkdown}
              onExportClipboard={handleExportClipboard}
            />

            {/* Workspace: outline + document canvas + chat */}
            <div className="flex flex-1 overflow-hidden min-w-0">
              <MemoOutlineSidebar
                sections={sections}
                activeSection={activeSection}
                setActiveSection={setActiveSection}
                onAddSection={() => setShowAddSection(true)}
              />
              <MemoEditor
                memo={selectedMemo}
                sections={sections}
                activeSection={activeSection}
                setActiveSection={setActiveSection}
                editingContent={editingContent}
                setEditingContent={setEditingContent}
                generatingSection={generatingSection}
                savingSection={savingSection}
                onGenerate={handleGenerate}
                onSave={handleSaveSection}
                onDelete={setPendingDeleteSection}
              />
              {chatOpen ? (
                <MemoChat
                  messages={messages}
                  chatInput={chatInput}
                  setChatInput={setChatInput}
                  sendingChat={sendingChat}
                  onSend={sendMessage}
                  chatOpen={chatOpen}
                  onToggleChat={() => setChatOpen(false)}
                  chatEndRef={chatEndRef}
                />
              ) : (
                <MemoChatCollapsed onOpen={() => setChatOpen(true)} />
              )}
            </div>
          </>
        )}
      </div>

      {/* ---- Success toast ---- */}
      {successToast && (
        <SuccessToast message={successToast} onDismiss={() => setSuccessToast(null)} />
      )}

      {/* ---- Error toast ---- */}
      {error && (
        <ErrorToast message={error} onDismiss={() => setError(null)} />
      )}

      {/* ---- Create Memo Modal ---- */}
      <CreateMemoModal
        showCreate={showCreate}
        onClose={() => setShowCreate(false)}
        deals={deals}
        templates={templates}
        createForm={createForm}
        setCreateForm={setCreateForm}
        creatingMemo={creatingMemo}
        onCreate={handleCreate}
      />

      {/* ---- Add Section Modal ---- */}
      <AddSectionModal
        open={showAddSection}
        onClose={() => setShowAddSection(false)}
        sectionType={addSectionType}
        setSectionType={setAddSectionType}
        sectionTitle={addSectionTitle}
        setSectionTitle={setAddSectionTitle}
        generateAI={addSectionAI}
        setGenerateAI={setAddSectionAI}
        loading={addingSectionLoading}
        onAdd={handleAddSection}
      />

      {/* ---- Delete Section Confirm ---- */}
      <ConfirmDialog
        open={!!pendingDeleteSection}
        title="Delete Section"
        message={pendingDeleteSection ? `Delete "${pendingDeleteSection.title}"? This cannot be undone.` : ""}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => pendingDeleteSection && handleDeleteSection(pendingDeleteSection.id)}
        onCancel={() => setPendingDeleteSection(null)}
      />

      {/* ---- Delete Memo Confirm ---- */}
      <DeleteMemoConfirm
        pending={pendingDeleteMemo}
        setPending={setPendingDeleteMemo}
        onDeleted={(deletedId) => {
          const { nextMemos, clearSelection } = applyMemoDeleted(memos, selectedMemo, deletedId);
          setMemos(nextMemos);
          if (clearSelection) {
            setSelectedMemo(null);
            setSections([]);
            setEditingContent({});
            setActiveSection(null);
            setMessages([]);
          }
          setSuccessToast("Memo deleted.");
        }}
        onError={(msg) => setError(msg)}
      />
    </div>
  );
}
