"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";

import {
  type DealDetail,
  type DocItem,
  type ChatMessage,
  type Activity,
  type Tab,
  ChatTab,
} from "./components";
import { useResizablePanel } from "./use-resizable-panel";
import { DealPageLoadingSkeleton, DealPageErrorState } from "./deal-page-skeletons";
import { DealPageHeader } from "./deal-page-header";
import { DealPageLeftPanel } from "./deal-page-left-panel";
import { DealPageModals, type StageModalState } from "./deal-page-modals";
import {
  openStageModal,
  openTerminalModal,
  confirmStageChange as confirmStageChangeFn,
  selectTerminalStage,
  confirmDeleteDeal as confirmDeleteDealFn,
  uploadDocuments,
  importDriveDocument,
  sendPrompt as sendPromptFn,
  clearChatHistory as clearChatHistoryFn,
} from "./deal-page-handlers";

// ---------------------------------------------------------------------------
// Page component — owns all data + UI state for the deal detail screen.
//
// Composition (top → bottom): <DealPageHeader /> + two-column layout
// (<DealPageLeftPanel /> | resize handle | <ChatTab />), then
// <DealPageModals /> for everything dialog-shaped.
//
// Sub-components are kept "dumb" (state + setters as props). The data loading
// orchestration (loadDeal/loadActivities/loadChatHistory) and the resizable
// panel logic stay here so they can be coordinated in one place.
// ---------------------------------------------------------------------------

export default function DealDetailPage() {
  const params = useParams<{ id: string }>();
  const dealId = params.id;
  const router = useRouter();
  const { showToast } = useToast();
  const [helpOpen, setHelpOpen] = useState(false);

  // Resizable panels (drag divider between deal content and chat)
  const {
    containerRef,
    leftRef,
    handleRef,
    leftPanelStyle,
    isDragging,
    onMouseDown,
    onTouchStart,
    onDoubleClick,
  } = useResizablePanel();

  const [deal, setDeal] = useState<DealDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("Overview");

  // Stage change modal
  const [stageModal, setStageModal] = useState<StageModalState | null>(null);
  const [stageNote, setStageNote] = useState("");
  const [stageChanging, setStageChanging] = useState(false);
  const [stageError, setStageError] = useState("");

  // Terminal stage modal (Close Deal: Won/Lost/Passed)
  const [showTerminalModal, setShowTerminalModal] = useState(false);

  // Edit deal modal
  const [showEditModal, setShowEditModal] = useState(false);

  // Manage team modal (header "+" / avatar stack)
  const [showTeamModal, setShowTeamModal] = useState(false);

  // Delete-deal confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Documents
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [driveImporting, setDriveImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chat (always visible in sidebar, load eagerly)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Activity (loaded eagerly for inline feed in Overview)
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(false);

  // Fullscreen overlay for Financials / Analysis sections (ports legacy
  // dealFullscreen.js). null = closed.
  const [fullscreenSection, setFullscreenSection] = useState<"financials" | "analysis" | null>(null);

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  const loadDeal = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const raw = await api.get<DealDetail & { teamMembers?: Array<{ role: string; user: { id: string; name: string; avatar?: string; email?: string } }> }>(`/deals/${dealId}`);
      // Flatten teamMembers -> team (API returns nested join, frontend expects flat)
      const data: DealDetail = {
        ...raw,
        team: raw.team || raw.teamMembers?.map((tm) => ({
          id: tm.user?.id || "",
          name: tm.user?.name || "",
          avatar: tm.user?.avatar,
          email: tm.user?.email,
          role: tm.role,
        })) || [],
      };
      setDeal(data);
      setDocuments(data.documents || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load deal";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  const loadActivities = useCallback(async () => {
    setActivitiesLoading(true);
    try {
      const data = await api.get<{ activities: Activity[]; data?: Activity[] } | Activity[]>(
        `/deals/${dealId}/activities?limit=10`
      );
      if (Array.isArray(data)) {
        setActivities(data);
      } else {
        setActivities(data.data || data.activities || []);
      }
    } catch (err) {
      console.warn("[deal] loadActivities failed:", err);
    } finally {
      setActivitiesLoading(false);
    }
  }, [dealId]);

  const loadChatHistory = useCallback(async () => {
    try {
      const data = await api.get<{ messages: ChatMessage[] } | ChatMessage[]>(
        `/deals/${dealId}/chat/history`
      );
      setMessages(Array.isArray(data) ? data : data.messages || []);
    } catch (err) {
      console.warn("[deal] loadChatHistory failed:", err);
    }
  }, [dealId]);

  useEffect(() => {
    loadDeal();
  }, [loadDeal]);

  // Chat is always visible in the sidebar -- load eagerly, independently of deal metadata.
  useEffect(() => {
    loadChatHistory();
  }, [loadChatHistory]);

  // Activities loaded eagerly (shown in Overview tab inline feed)
  useEffect(() => {
    loadActivities();
  }, [loadActivities]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Hash-scroll: the onboarding checklist links to /deals/:id#financials-section
  // etc. Sections render async after the deal loads, so the browser's native
  // hash scroll fires before targets exist. Poll up to 8s for the element then
  // smooth-scroll. Ported from deal.js scrollToHashWhenReady (ee35074).
  useEffect(() => {
    if (!deal) return;
    const hash = window.location.hash?.slice(1);
    if (!hash) return;

    let attempts = 0;
    const maxAttempts = 40; // ~8 seconds @ 200ms
    const interval = setInterval(() => {
      const el = document.getElementById(hash);
      if (el) {
        clearInterval(interval);
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (++attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [deal]);

  // -----------------------------------------------------------------------
  // Handlers — pure logic lives in deal-page-handlers.ts. These thin wrappers
  // bind the current state + setters to the handler signatures.
  // -----------------------------------------------------------------------

  const handleStageClick = (targetStage: string) =>
    openStageModal(targetStage, { deal, setStageModal, setStageNote });

  const handleChangeStageBtn = () =>
    openTerminalModal({ deal, setShowTerminalModal });

  const confirmStageChange = () =>
    confirmStageChangeFn({
      dealId,
      stageModal,
      deal,
      setStageChanging,
      setStageError,
      setDeal,
      setStageModal,
      loadActivities,
    });

  const handleTerminalSelect = (stage: string) =>
    selectTerminalStage(stage, {
      dealId,
      setShowTerminalModal,
      setDeal,
      loadActivities,
      showToast,
    });

  const handleDeleteDeal = () => {
    if (!deal) return;
    setShowDeleteConfirm(true);
  };

  const confirmDeleteDeal = () =>
    confirmDeleteDealFn({ dealId, setShowDeleteConfirm, router, showToast });

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) =>
    uploadDocuments(e, { dealId, setUploading, setDocuments, fileInputRef, showToast });

  const handleImportFromDrive = () =>
    importDriveDocument({ dealId, setDriveImporting, setDocuments, showToast });

  // Send a specific text (used by suggestion chips) without relying on
  // chatInput state -- setState is async so a chip click can't setChatInput
  // then immediately read it.
  const sendPrompt = useCallback(
    (text: string) =>
      sendPromptFn(text, {
        dealId,
        chatSending,
        setChatSending,
        setMessages,
        showToast,
        loadDeal,
      }),
    [dealId, chatSending, showToast, loadDeal],
  );

  const sendMessage = async () => {
    const text = chatInput.trim();
    if (!text || chatSending) return;
    setChatInput("");
    await sendPrompt(text);
  };

  // Clear chat history (ported from deal-chat.js clearChatConfirm)
  const clearChatHistory = useCallback(
    () => clearChatHistoryFn({ dealId, setMessages, showToast }),
    [dealId, showToast],
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) {
    return <DealPageLoadingSkeleton />;
  }

  if (error || !deal) {
    return <DealPageErrorState error={error} />;
  }

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        {/* HEADER BAR — breadcrumb + actions, spans full width above both panels */}
        <DealPageHeader
          deal={deal}
          dealId={dealId}
          setShowEditModal={setShowEditModal}
          setShowTeamModal={setShowTeamModal}
          setHelpOpen={setHelpOpen}
        />

        {/* TWO-COLUMN LAYOUT — below header */}
        <div ref={containerRef} className="flex flex-1 overflow-hidden">
          {/* LEFT PANEL — deal content, scrolls independently */}
          <DealPageLeftPanel
            deal={deal}
            dealId={dealId}
            leftRef={leftRef}
            leftPanelStyle={leftPanelStyle}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onStageClick={handleStageClick}
            onChangeStage={handleChangeStageBtn}
            onDelete={handleDeleteDeal}
            activities={activities}
            activitiesLoading={activitiesLoading}
            loadActivities={loadActivities}
            documents={documents}
            uploading={uploading}
            fileInputRef={fileInputRef}
            onUpload={handleUpload}
            driveImporting={driveImporting}
            onImportFromDrive={handleImportFromDrive}
            onOpenFinancialsFullscreen={() => setFullscreenSection("financials")}
            onOpenAnalysisFullscreen={() => setFullscreenSection("analysis")}
          />

          {/* RESIZE HANDLE — draggable divider between panels */}
          <div
            ref={handleRef}
            onMouseDown={onMouseDown}
            onTouchStart={onTouchStart}
            onDoubleClick={onDoubleClick}
            className={cn(
              "hidden lg:flex w-1.5 cursor-col-resize flex-shrink-0 relative items-center justify-center z-10 transition-colors",
              isDragging
                ? "bg-[rgba(0,51,102,0.15)]"
                : "hover:bg-primary/20 active:bg-primary/40",
            )}
            title="Drag to resize (double-click to reset)"
          >
            {/* Wider invisible hit area for easier grabbing */}
            <div className="absolute inset-y-0 -left-2 -right-2" />
            {/* Visual grip indicator */}
            <div
              className={cn(
                "w-0.5 h-8 rounded-full transition-colors",
                isDragging ? "bg-primary/50 opacity-100" : "bg-gray-300 opacity-0 hover:opacity-100",
              )}
            />
          </div>

          {/* RIGHT PANEL — AI Chat (desktop only, fills remaining space) */}
          <section
            className="hidden lg:flex flex-1 flex-col bg-background-body border-l border-border-subtle/60 shadow-inner relative"
            style={{ minWidth: 300 }}
          >
            <ChatTab
              deal={deal}
              messages={messages}
              chatInput={chatInput}
              setChatInput={setChatInput}
              chatSending={chatSending}
              onSend={sendMessage}
              onSendPrompt={sendPrompt}
              onClearChat={clearChatHistory}
              chatEndRef={chatEndRef}
            />
          </section>
        </div>
        {/* end two-column */}
      </div>
      {/* end flex-col container */}

      {/* All modals */}
      <DealPageModals
        deal={deal}
        dealId={dealId}
        stageModal={stageModal}
        stageNote={stageNote}
        setStageNote={setStageNote}
        stageChanging={stageChanging}
        stageError={stageError}
        onConfirmStageChange={confirmStageChange}
        onCloseStageModal={() => {
          setStageModal(null);
          setStageError("");
        }}
        showTerminalModal={showTerminalModal}
        onTerminalSelect={handleTerminalSelect}
        onCloseTerminalModal={() => setShowTerminalModal(false)}
        showEditModal={showEditModal}
        onCloseEditModal={() => setShowEditModal(false)}
        onDealEdited={(updated) => {
          setDeal((prev) => (prev ? { ...prev, ...updated } : updated));
          showToast("Deal details have been saved", "success", { title: "Deal Updated" });
          loadActivities();
        }}
        showTeamModal={showTeamModal}
        onCloseTeamModal={() => {
          setShowTeamModal(false);
          // Reload activities — adds/removes/role-changes log activity rows.
          loadActivities();
        }}
        onTeamChanged={(team) => {
          setDeal((prev) => (prev ? { ...prev, team } : prev));
        }}
        helpOpen={helpOpen}
        onCloseHelp={() => setHelpOpen(false)}
        showDeleteConfirm={showDeleteConfirm}
        onConfirmDelete={confirmDeleteDeal}
        onCancelDelete={() => setShowDeleteConfirm(false)}
        fullscreenSection={fullscreenSection}
        onCloseFullscreen={() => setFullscreenSection(null)}
      />
    </>
  );
}
